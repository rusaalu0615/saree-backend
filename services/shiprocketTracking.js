/**
 * SHIPROCKET TRACKING NORMALIZER — the single provider normalization layer.
 *
 * Real Shiprocket tracking responses come in several shapes and the previous
 * inline normalizer missed the two most common ones:
 *   - the AWB/order payloads nest activity + status under
 *     `tracking_data.shipment_track[0]` / `tracking_data.shipment_track_activities`
 *   - `shipment_status` / `shipment_status_id` are frequently NUMERIC codes,
 *     not human text.
 *
 * Design rules (spec §8):
 *   - ONE normalization layer read by both the customer track endpoint and the
 *     forward-only status sync.
 *   - Extract AWB, shipment id, courier, status, activities and ETA from every
 *     known variant.
 *   - Map numeric codes EXPLICITLY; keep the raw value when unknown.
 *   - Map text statuses SPECIFICALLY — "Out For Pickup" is a courier-attempt /
 *     pre-dispatch state and must NEVER be reported as Out For Delivery.
 *   - Preserve unrecognized values instead of guessing.
 *   - Whitelist the public fields so raw consignee PII never leaks.
 *   - Short-lived cache + last-known-state fallback so a slow/failed external
 *     lookup cannot block the page (caller passes `fallback` from stored data).
 */

// Forward-only progression used by the status sync. Higher = further along.
export const STATUS_RANK = {
    placed: 0,
    confirmed: 1,
    processing: 2,
    shipped: 3,
    in_transit: 4,
    out_for_delivery: 5,
    delivered: 6,
};

// Two DISTINCT Shiprocket code spaces exist and must never be conflated:
//
//  (A) ORDER / shipment status  — `shipment_status_id` on the shipment object
//      returned by create-order / order-status endpoints (small, pre-pickup set).
//  (B) TRACKING SCAN status    — `status_code` inside `tracking_data.shipment_track[]`,
//      the AWB tracking endpoint the customer tracking page actually calls.
//
// The codes below are the (B) tracking-scan codes for the AWB endpoint. They are
// NOT the same numbers as (A): e.g. 6 = Shipped here, 7 = Delivered, 17 = Out For
// Delivery, 18 = In Transit, 19 = Out For Pickup. Anything undocumented is left
// unmapped (null) so we never invent a forward progression from a guessed number.
const TRACK_STATUS_CODE = {
    6: "Shipped",
    7: "Delivered",
    17: "Out For Delivery",
    18: "In Transit",
    19: "Out For Pickup",
};

// (A) order/shipment-level codes. Conservative — only the codes with a stable
// documented meaning that map to a NON-terminal progression. Negative/terminal
// courier states (RTO, undelivered, cancelled) are deliberately absent so they
// never auto-advance the order; they are left to the admin workflow.
const ORDER_STATUS_CODE = {
    1: "New",
    2: "Pickup Generated",
    3: "Picked Up",
    4: "In Transit",
    5: "Out For Delivery",
    6: "Delivered",
    14: "Shipped",
};

// Text → canonical status. Order matters: the SPECIFIC phrases are tested
// before any generic substring so "Out For Pickup" can never be mistaken for
// "Out For Delivery".
function classifyText(raw) {
    const s = String(raw || "").toLowerCase().trim();
    if (!s) return null;

    // Terminal-negative states are left to the admin RTO/undelivered workflow —
    // a courier string must never auto-regress or hijack our status.
    if (s.includes("undeliver") || s.includes("rto") || s.includes("cancelled") || s.includes("canceled") || s.includes("failed")) {
        return null;
    }

    // SPECIFIC first — do NOT use a generic "out for" match.
    if (s === "out for delivery" || s.includes("out for delivery") || s.includes("ofd")) return "out_for_delivery";
    if (s.includes("out for pickup") || s.includes("pickup exception") || s.includes("pickup failed") || s.includes("attempted delivery")) {
        // A delivery/pickup ATTEMPT or pre-wheelout state — NOT dispatched-home.
        // Treated as "processing" progression (no forward status hijack).
        return "processing";
    }

    // "Awaiting Wheelout" (numeric code 0) is a PRE-DISPATCH state — the parcel
    // has not physically left the hub yet, so it must NOT advance us to
    // in_transit. Only a completed wheelout/dispatch counts as in transit.
    if (s.includes("awaiting") || s.includes("pending wheelout")) return "processing";

    if (s.includes("delivered")) return "delivered";
    if (s.includes("in transit") || s.includes("transit") || s.includes("dispatch") || s.includes("wheelout")) return "in_transit";
    if (s.includes("shipped") || s.includes("picked up") || s.includes("pickup done") || s.includes("handover")) return "shipped";
    if (s.includes("pickup scheduled") || s.includes("pickup generated") || s.includes("label") || s.includes("assigned") || s.includes("generated") || s.includes("manifest")) return "processing";
    return null; // preserve unrecognized — caller keeps raw, we do not guess
}

/** Human label for a numeric code within a given code space, else null. */
function codeLabel(code, space) {
    const table = space === "order" ? ORDER_STATUS_CODE : TRACK_STATUS_CODE;
    return table[Number(code)] || null;
}

/**
 * Map a raw provider status (numeric code OR free text) to OUR canonical
 * forward-only status. `space` disambiguates the two numeric code spaces:
 *   "track" (default) — AWB shipment_track[].status_code
 *   "order"           — order/shipment shipment_status_id
 * A numeric code that is undocumented in that space returns null (never a guess).
 * Returns null when the status must NOT advance the order.
 */
export function mapShipmentStatus(raw, space = "track") {
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw === "number" || /^\d+$/.test(String(raw).trim())) {
        const label = codeLabel(raw, space);
        return label ? classifyText(label) : null; // unknown numeric → never assume
    }
    return classifyText(raw);
}

/** Return the human label for a numeric code (or the raw string) for display. */
function statusLabel(raw, space = "track") {
    if (typeof raw === "number" || /^\d+$/.test(String(raw ?? "").trim())) {
        return codeLabel(raw, space);
    }
    return raw || null;
}

// First activity in `shipment_track` is the freshest scan in Shiprocket payloads.
function readShipmentTrack(td) {
    const arr = td?.shipment_track;
    if (Array.isArray(arr) && arr.length) return arr[0] || null;
    return null;
}

function collectActivities(src) {
    const lists = [
        src?.shipment_track_activities,
        src?.track_activities,
        src?.activities,
        src?.tracking_infos,
    ];
    for (const list of lists) {
        if (Array.isArray(list) && list.length) return list;
    }
    return [];
}

/**
 * Extract the canonical shipment object from any Shiprocket tracking response
 * variant (AWB tracking, order-id tracking, tracking_data wrapper, shipments[]).
 */
export function normalizeTrackingResult(raw) {
    if (!raw || typeof raw !== "object") return null;

    // Unwrap possible `data` and `shipments[0]` layers without losing tracking_data.
    let base = raw.data && typeof raw.data === "object" ? raw.data : raw;
    if (Array.isArray(base.shipments) && base.shipments.length) {
        base = { ...base, ...base.shipments[0] };
    }
    const td = base.tracking_data || raw.tracking_data || null;

    // Merge precedence: tracking_data (most detailed) > base > top-level raw.
    const firstTrack = readShipmentTrack(td) || readShipmentTrack(base);
    const src = { ...raw, ...base, ...(td || {}), ...(firstTrack || {}) };

    // Distinguish the two code spaces by SOURCE FIELD, never by guessing:
    //  - the AWB scan lives in shipment_track[0].status_code → TRACK table
    //  - the order-level status lives in tracking_data.shipment_status_id → ORDER table
    const trackScanCode = firstTrack?.status_code ?? firstTrack?.shipment_status_id ?? null;
    const trackScanText =
        firstTrack?.["sr-status-label"] ||
        firstTrack?.shipment_track_detail ||
        firstTrack?.shipment_track_status ||
        firstTrack?.courier_status_label ||
        null;
    const orderStatusCode = td?.shipment_status_id ?? src.shipment_status_id ?? null;
    const orderStatusText = src.current_status || src.courier_status || src.shipment_status || src.tracking_status || null;

    // Forward status is decided from the freshest authoritative signal. A track
    // scan code/text outranks the coarser order-level field.
    let mappedStatus = null;
    if (trackScanCode !== null && trackScanCode !== undefined && trackScanCode !== "") {
        mappedStatus = mapShipmentStatus(trackScanCode, "track");
    }
    if (mappedStatus == null && trackScanText) mappedStatus = mapShipmentStatus(trackScanText, "track");
    if (mappedStatus == null && orderStatusCode !== null && orderStatusCode !== undefined && orderStatusCode !== "") {
        mappedStatus = mapShipmentStatus(orderStatusCode, "order");
    }
    if (mappedStatus == null && orderStatusText) mappedStatus = mapShipmentStatus(orderStatusText, "order");

    // Display label: the human scan text if present, else the resolved code label,
    // else the order-level text. Raw status is always preserved alongside.
    const label =
        trackScanText ||
        statusLabel(trackScanCode, "track") ||
        statusLabel(orderStatusCode, "order") ||
        orderStatusText ||
        null;
    const rawStatusCode = trackScanCode ?? orderStatusCode ?? null;
    const currentStatus = label || orderStatusText || null;

    const activities = collectActivities(src)
        .slice(0, 40)
        .map((a) => ({
            date: a.date || a["activity-date"] || a.time || a.shipment_track_date || null,
            activity: a["sr-status-label"] || a.activity || a.status || a.shipment_track_detail || "Package Scanned",
            location: a.location || a.city || a.from || null,
        }));

    return {
        awb: String(src.awb_code || src.awb || "").trim() || null,
        shipmentId: src.shipment_id || src.id || null,
        courierName: src.courier_name || src.courierName || null,
        // Keep BOTH the raw provider value and our classified label so nothing
        // is lost when the code/text is unrecognized.
        rawStatus: rawStatusCode,
        shipmentStatus: label,
        currentStatus,
        mappedStatus,
        etd: src.etd || src.expected_date || src.edd || src.delivery_date || null,
        trackUrl: src.track_url || src.trackingUrl || null,
        activities,
    };
}

/** Data-minimized public tracking shape — no consignee PII from raw payloads. */
export function sanitizeTrackingForPublic(raw) {
    const n = normalizeTrackingResult(raw);
    if (!n) return null;
    return {
        courier_name: n.courierName,
        current_status: n.currentStatus || n.shipmentStatus,
        shipment_status: n.shipmentStatus,
        awb: n.awb,
        etd: n.etd,
        track_url: n.trackUrl,
        shipment_track_activities: n.activities,
    };
}

// ---------------------------------------------------------------------------
// Short-lived cache + last-known-state fallback. A slow or failing external
// lookup returns the freshest of (recent cache, stored fallback) instead of
// blocking the page or showing nothing.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = Number(process.env.TRACKING_CACHE_TTL_MS || 30000);
const cache = new Map(); // key -> { at, value }

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }
    return hit.value;
}

/**
 * Resolve tracking with graceful degradation.
 * @param {String} key            cache key (awb or order id)
 * @param {Function} fetcher      async () => raw provider payload
 * @param {Object} [fallbackRaw]  last-known raw/stored shape to normalize if fetch fails
 * @returns {Object|null} normalized tracking (never throws for network reasons)
 */
export async function resolveTracking(key, fetcher, fallbackRaw = null) {
    if (!key) return normalizeTrackingResult(fallbackRaw);
    const cached = cacheGet(key);
    if (cached) return cached;
    try {
        const raw = await fetcher();
        const norm = normalizeTrackingResult(raw);
        if (norm) cache.set(key, { at: Date.now(), value: norm });
        return norm || normalizeTrackingResult(fallbackRaw);
    } catch (err) {
        // Provider failed / timed out — serve last-known state, never block.
        return normalizeTrackingResult(fallbackRaw);
    }
}

export default {
    STATUS_RANK,
    mapShipmentStatus,
    normalizeTrackingResult,
    sanitizeTrackingForPublic,
    resolveTracking,
};
