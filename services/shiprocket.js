/**
 * Shiprocket API Service
 * Handles authentication, order creation, courier assignment, and tracking.
 *
 * Required env vars:
 *   SHIPROCKET_EMAIL
 *   SHIPROCKET_PASSWORD
 *   SHIPROCKET_PICKUP_LOCATION  (default: "Primary")
 */

let cachedToken = null;
let tokenExpiry = null;

// Bounded token-refresh: concurrent callers share ONE in-flight login instead
// of stacking several authentications when the cached token has lapsed or a
// burst of requests all hit a 401 at once.
let authInFlight = null;

const SHIPROCKET_BASE = "https://apiv2.shiprocket.in/v1/external";

// Every outbound call is capped so a hung Shiprocket socket can never pin a
// fulfillment worker indefinitely. Timeouts surface as AbortError, which the
// controller treats as an AMBIGUOUS failure and reconciles rather than retrying
// blindly (a create may have succeeded server-side despite our timeout).
const REQUEST_TIMEOUT_MS = Number(process.env.SHIPROCKET_TIMEOUT_MS || 20000);

async function fetchWithTimeout(url, options = {}) {
    const signal =
        options.signal ||
        (typeof AbortSignal !== "undefined" && AbortSignal.timeout
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            : undefined);
    return fetch(url, { ...options, signal });
}

/**
 * Authenticate with Shiprocket and cache the bearer token (valid ~10 days).
 * We refresh every 24 hours to be safe. Concurrent misses are de-duplicated so
 * only one login request is ever in flight.
 */
async function getToken() {
    // Return cached token if still valid
    if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
        return cachedToken;
    }

    if (authInFlight) return authInFlight;

    const email = process.env.SHIPROCKET_EMAIL;
    const password = process.env.SHIPROCKET_PASSWORD;

    if (!email || !password) {
        throw new Error("Shiprocket credentials not configured. Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD in .env");
    }

    authInFlight = (async () => {
        try {
            const res = await fetchWithTimeout(`${SHIPROCKET_BASE}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });

            const data = await res.json();

            if (!res.ok || !data.token) {
                throw new Error(`Shiprocket auth failed: ${data.message || res.statusText}`);
            }

            cachedToken = data.token;
            tokenExpiry = Date.now() + 24 * 60 * 60 * 1000; // Refresh every 24h

            return cachedToken;
        } finally {
            authInFlight = null;
        }
    })();

    return authInFlight;
}

/**
 * Make an authenticated request to Shiprocket API.
 * On a 401 the cached token is discarded and the call retried once — this
 * covers token invalidation (password change / re-login elsewhere) without
 * every deploy needing a restart.
 */
async function shiprocketFetch(endpoint, options = {}) {
    const doCall = async (token) => fetchWithTimeout(`${SHIPROCKET_BASE}${endpoint}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...options.headers,
        },
    });

    let res = await doCall(await getToken());

    if (res.status === 401) {
        console.warn(`[Shiprocket] 401 on ${endpoint} — refreshing token and retrying once`);
        cachedToken = null;
        tokenExpiry = null;
        res = await doCall(await getToken());
    }

    const data = await res.json();

    if (!res.ok) {
        const errorMsg = data.message || data.errors || res.statusText;
        console.error(`Shiprocket API error [${endpoint}]:`, errorMsg);
        throw new Error(`Shiprocket API error: ${JSON.stringify(errorMsg)}`);
    }

    // Application-level success: Shiprocket returns HTTP 200 with a business
    // error body ({"success":false} or {"data":{"error":...}}). Treat those as
    // failures so callers never mistake a rejected action for a fulfilled one.
    if (data && data.success === false) {
        throw new Error(`Shiprocket rejected [${endpoint}]: ${JSON.stringify(data.message || data.errors || data).slice(0, 300)}`);
    }

    return data;
}

/**
 * Map Indian state abbreviations to full names (Shiprocket requires full names)
 */
const STATE_MAP = {
    AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam", BR: "Bihar",
    CG: "Chhattisgarh", GA: "Goa", GJ: "Gujarat", HR: "Haryana",
    HP: "Himachal Pradesh", JH: "Jharkhand", KA: "Karnataka", KL: "Kerala",
    MP: "Madhya Pradesh", MH: "Maharashtra", MN: "Manipur", ML: "Meghalaya",
    MZ: "Mizoram", NL: "Nagaland", OD: "Odisha", PB: "Punjab",
    RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu", TS: "Telangana",
    TR: "Tripura", UP: "Uttar Pradesh", UK: "Uttarakhand", WB: "West Bengal",
    AN: "Andaman and Nicobar Islands", CH: "Chandigarh",
    DN: "Dadra and Nagar Haveli and Daman and Diu", DL: "Delhi",
    JK: "Jammu and Kashmir", LA: "Ladakh", LD: "Lakshadweep", PY: "Puducherry",
};

/**
 * Estimate shipment weight (kg) from item count — 0.5kg per unit, floor 0.5kg.
 * Used for both the adhoc payload and courier serviceability so the courier
 * billable weight matches what is actually in the parcel.
 */
function calculateWeight(order) {
    const units = order.items.reduce((sum, item) => sum + (item.quantity || 1), 0);
    return Math.max(0.5, +(units * 0.5).toFixed(2));
}

/**
 * Create an order in Shiprocket
 * @param {Object} order - Our database Order document
 */
async function createShiprocketOrder(order) {
    const pickupLocation = process.env.SHIPROCKET_PICKUP_LOCATION || "Primary";
    const weight = calculateWeight(order);

    // Resolve state abbreviation to full name
    const stateCode = order.shippingAddress.state;
    const stateName = STATE_MAP[stateCode] || stateCode;

    const payload = {
        order_id: order.orderId,
        order_date: new Date().toISOString().slice(0, 19).replace("T", " "),
        pickup_location: pickupLocation,
        billing_customer_name: order.shippingAddress.firstName,
        billing_last_name: order.shippingAddress.lastName,
        billing_address: order.shippingAddress.address,
        billing_address_2: order.shippingAddress.landmark || "",
        billing_city: order.shippingAddress.city,
        billing_pincode: order.shippingAddress.pincode,
        billing_state: stateName,
        billing_country: "India",
        billing_email: order.shippingAddress.email,
        billing_phone: order.shippingAddress.phone,
        shipping_is_billing: true,
        order_items: order.items.map((item) => ({
            name: item.name,
            sku: item.sku || `SKU-${item.productId}`,
            units: item.quantity,
            selling_price: item.price,
            discount: 0,
            tax: 0,
        })),
        payment_method: order.payment.method === "cod" ? "COD" : "Prepaid",
        sub_total: order.pricing.total,
        length: 30,
        breadth: 25,
        height: 5,
        weight,
    };

    // Log only non-PII fields — never dump the customer's address/contact to stdout
    console.log(`[Shiprocket] Creating adhoc order ${order.orderId} → pincode ${order.shippingAddress.pincode}, weight ${weight}kg, payment ${payload.payment_method}`);

    const result = await shiprocketFetch("/orders/create/adhoc", {
        method: "POST",
        body: JSON.stringify(payload),
    });

    console.log(`[Shiprocket] Order ${order.orderId} created → shipment_id ${result.shipment_id}, sr order_id ${result.order_id}`);
    return result;
}

/**
 * Request courier assignment for a shipment
 * @param {Number} shipmentId - Shiprocket shipment ID
 * @param {Object} orderDetails - { pickupPincode, deliveryPincode, weight, isCOD }
 */
async function assignCourier(shipmentId, orderDetails = {}) {
    try {
        const {
            pickupPincode = "",
            deliveryPincode = "",
            weight = 0.5,
            isCOD = true,
        } = orderDetails;

        // Courier serviceability requires these params
        const params = new URLSearchParams({
            pickup_postcode: pickupPincode,
            delivery_postcode: deliveryPincode,
            weight: String(weight),
            cod: isCOD ? "1" : "0",
        });

        const couriers = await shiprocketFetch(
            `/courier/serviceability/?${params.toString()}`
        );

        if (
            couriers.data &&
            couriers.data.available_courier_companies &&
            couriers.data.available_courier_companies.length > 0
        ) {
            // Pick the cheapest courier
            const cheapest = couriers.data.available_courier_companies.sort(
                (a, b) => a.rate - b.rate
            )[0];

            // Assign the courier
            const assignment = await shiprocketFetch("/courier/assign/awb", {
                method: "POST",
                body: JSON.stringify({
                    shipment_id: shipmentId,
                    courier_id: cheapest.courier_company_id,
                }),
            });

            return {
                courierName: cheapest.courier_name,
                courierCompanyId: cheapest.courier_company_id,
                awbCode: assignment.response?.data?.awb_code || null,
            };
        }

        console.log("[Shiprocket] No couriers available for this route");
        return null;
    } catch (err) {
        console.error("Courier assignment failed:", err.message);
        return null;
    }
}

/**
 * Track shipment by AWB code
 */
async function trackByAWB(awbCode) {
    return await shiprocketFetch(`/courier/track/awb/${awbCode}`);
}

/**
 * Track shipment by Shiprocket order ID
 */
async function trackByShiprocketOrderId(shiprocketOrderId) {
    return await shiprocketFetch(
        `/courier/track?order_id=${shiprocketOrderId}`
    );
}

/**
 * Cancel a Shiprocket order and classify provider outcome explicitly:
 * Returns: { outcome: "confirmed" | "failed" | "uncertain", statusCode?: number, message?: string, raw?: any, error?: string }
 */
async function cancelShiprocketOrder(shiprocketOrderIds) {
    if (!shiprocketOrderIds) {
        return { outcome: "failed", message: "no_shiprocket_order_id" };
    }
    const id = Array.isArray(shiprocketOrderIds) ? shiprocketOrderIds[0] : shiprocketOrderIds;
    let data;
    try {
        data = await shiprocketFetch("/orders/cancel", {
            method: "POST",
            body: JSON.stringify({ ids: [id] }),
        });
    } catch (err) {
        const msg = String(err.message || err);
        // Distinguish definite rejections (e.g. 400/404/422/already shipped) from uncertain network/timeout errors
        const isTransient = /timeout|network|socket|econn|etimedout|abort|fetch failed|5\d\d/i.test(msg);
        if (isTransient) {
            return { outcome: "uncertain", error: msg };
        }
        return { outcome: "failed", error: msg };
    }

    // Inspect response: Shiprocket can return HTTP 200 with status_code: 400 or message indicating failure
    const statusCode = data?.status_code ?? data?.status ?? 200;
    const msg = String(data?.message || data?.errors || "");
    const isSuccessCode = statusCode === 200 || statusCode === 204;
    const isSuccessMessage = /cancelled successfully|order cancelled/i.test(msg);
    const isRejectMessage = /cannot be cancelled|already shipped|already delivered|not found|invalid/i.test(msg);

    if (isSuccessCode && !isRejectMessage) {
        return { outcome: "confirmed", statusCode, message: msg, raw: data };
    }
    if (isRejectMessage || (statusCode >= 400 && statusCode < 500)) {
        return { outcome: "failed", statusCode, message: msg, raw: data };
    }

    return { outcome: "uncertain", statusCode, message: msg, raw: data };
}

/**
 * Generate a pickup request
 */
async function generatePickup(shipmentId) {
    return await shiprocketFetch("/courier/generate/pickup", {
        method: "POST",
        body: JSON.stringify({ shipment_id: [shipmentId] }),
    });
}

/**
 * Reconcile an ambiguous create: find an already-existing Shiprocket shipment
 * by OUR order id (not the Shiprocket id we failed to capture).
 *
 * EXPLICIT LOOKUP OUTCOMES — the caller must never read a broken/ambiguous
 * lookup as "definitely not there" and then create a duplicate shipment:
 *   { outcome: "FOUND",            shipment: { srOrderId, shipmentId, status } }
 *   { outcome: "CONFIRMED_ABSENT" }  a well-formed, complete listing that
 *                                     genuinely contains no exact match.
 *   { outcome: "UNKNOWN" }           malformed body, incomplete/absent page
 *                                     metadata, or a network/timeout error.
 *
 * The order list endpoint exposes a `filter[search]` term that matches our
 * custom order_id; we still re-match the exact record defensively because the
 * search term is broad. We validate the Shiprocket ORDER id and the SHIPMENT id
 * as two SEPARATE fields — a record that only yields one of them is UNKNOWN
 * (incomplete), never a place to substitute the order id for the shipment id.
 */
async function findShipmentByOurOrderId(ourOrderId) {
    if (!ourOrderId) return { outcome: "UNKNOWN", reason: "no_order_id" };
    const trimmed = String(ourOrderId).trim();
    const safe = encodeURIComponent(trimmed);
    if (!safe) return { outcome: "UNKNOWN", reason: "blank_order_id" };

    let data;
    try {
        // A listing failure must NOT be read as "not found" by a caller that
        // would then create a duplicate — a network/HTTP error is UNKNOWN.
        data = await shiprocketFetch(`/orders?status=all&filter%5Bsearch%5D=${safe}&page=1`);
    } catch (err) {
        return { outcome: "UNKNOWN", reason: "fetch_failed", error: String(err.message || err).slice(0, 200) };
    }

    // Accept the known list shapes; a body we cannot parse into an array is
    // INCOMPLETE/MALFORMED → UNKNOWN, not absence.
    const envelope = (data && data.data) ? data.data : data;
    const records =
        (envelope && Array.isArray(envelope.orders)) ? envelope.orders :
        (data && Array.isArray(data.orders)) ? data.orders :
        (Array.isArray(envelope) ? envelope : null);

    if (!Array.isArray(records)) return { outcome: "UNKNOWN", reason: "malformed_body" };

    // Confirm the response looks like a complete first page. Shiprocket returns
    // pagination metadata (current_page / from / to / last_page or total). A
    // bare empty array with NO pagination metadata can be an indexing lag right
    // after create, so a single such lookup does NOT prove absence → UNKNOWN.
    const hasPageMeta = envelope && (
        envelope.current_page !== undefined ||
        envelope.last_page !== undefined ||
        envelope.total !== undefined ||
        envelope.from !== undefined
    );

    const match = records.find((o) => {
        const theirOrderId = o?.order_id ?? o?.display_order_id;
        return theirOrderId && String(theirOrderId).trim().toUpperCase() === trimmed.toUpperCase();
    });

    if (match) {
        const srOrderId = match.id ?? match.order_id ?? null;   // Shiprocket numeric ORDER id
        const shipmentId = match.shipment_id ?? null;           // DISTINCT shipment id — never default to order id
        if (!srOrderId || !shipmentId) {
            // Incomplete record — do not substitute one id for the other.
            return { outcome: "UNKNOWN", reason: "incomplete_match" };
        }
        return { outcome: "FOUND", shipment: { srOrderId, shipmentId, status: match.status ?? null } };
    }

    // No exact match. Only a well-formed, paginated listing proves absence; an
    // empty body without page metadata is too early to trust → UNKNOWN.
    if (records.length === 0 && !hasPageMeta) return { outcome: "UNKNOWN", reason: "empty_without_page_meta" };
    return { outcome: "CONFIRMED_ABSENT" };
}

export default {
    getToken,
    calculateWeight,
    createShiprocketOrder,
    assignCourier,
    trackByAWB,
    trackByShiprocketOrderId,
    findShipmentByOurOrderId,
    cancelShiprocketOrder,
    generatePickup,
};
