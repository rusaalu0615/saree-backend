/**
 * Focused regression tests for the checkout / payment / shipping CORE LOGIC.
 *
 * These exercise the pure decision layers with REALISTIC PROVIDER FIXTURES —
 * no MongoDB, no live Razorpay, no Shiprocket network calls — so they run
 * anywhere with `node --test` and never touch real credentials or real money.
 * Every test here FAILS against the previously-buggy code (reading
 * entity.data / response.data instead of items[], conflating amount with
 * amount_paid, collapsing timeouts into "unpaid", treating "Out For Pickup"
 * as "Out For Delivery", missing shipment_track[0] and numeric status codes)
 * and PASSES against the current provider-adapter / lifecycle implementation.
 *
 * Integration paths (transactions, webhook signatures against the live secret,
 * Shiprocket test pushes, background-worker claims) require a database and are
 * listed in the final report as manual test-mode checks, NOT automated here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { safeCompare, hashToken, toPaise, toRupees } from "../utils/security.js";
import { normalizeTrackingResult, __test } from "../controllers/orderController.js";
import shiprocket from "../services/shiprocket.js";
import {
    reconcileOrderPayments,
    findPaymentRefunds,
    refundOutcome,
    RZP_OUTCOME,
    REFUND_LIST_OUTCOME,
} from "../services/razorpayProvider.js";

const { mapShipmentStatus, sanitizeTrackingForPublic, eventEntity, STATUS_RANK } = __test;
const { prepareCollection, CHECKOUT_COLLECTION_MODELS } = __test;

// ---------------------------------------------------------------------------
// Money helpers — the whole checkout runs on INTEGER PAISE to kill float drift.
// ---------------------------------------------------------------------------
test("toPaise rounds rupees to whole paise and resists float drift", () => {
    assert.equal(toPaise(199), 19900);
    assert.equal(toPaise(0.1) + toPaise(0.2), 30); // 0.1+0.2 float trap
    assert.equal(toPaise(999.99), 99999);
    assert.equal(toPaise(1234.567), 123457); // rounds half up on the cent
    assert.equal(toPaise("450"), 45000); // coerces string input defensively
});

test("toRupees is the inverse of toPaise for real amounts", () => {
    assert.equal(toRupees(19900), 199);
    assert.equal(toRupees(99999), 999.99);
    assert.equal(toPaise(toRupees(25050)), 25050);
});

// ---------------------------------------------------------------------------
// safeCompare — must NEVER throw (old timingSafeEqual crashed on bad length).
// ---------------------------------------------------------------------------
test("safeCompare matches equal strings and rejects unequal ones", () => {
    assert.equal(safeCompare("abc123", "abc123"), true);
    assert.equal(safeCompare("abc123", "abc124"), false);
    assert.equal(safeCompare("", ""), false); // empty is never a valid secret
});

test("safeCompare is throw-proof on malformed / unequal-length / non-string input", () => {
    assert.doesNotThrow(() => safeCompare("short", "a-much-longer-signature-value"));
    assert.doesNotThrow(() => safeCompare("zz", "yy"));
    assert.equal(safeCompare(undefined, "x"), false);
    assert.equal(safeCompare("x", null), false);
    assert.equal(safeCompare(123, 123), false); // non-strings rejected, no throw
});

test("hashToken is deterministic and one-way (collision-free across inputs)", () => {
    assert.equal(hashToken("secret-token"), hashToken("secret-token"));
    assert.notEqual(hashToken("a"), hashToken("b"));
    assert.equal(hashToken("x").length, 64); // sha-256 hex
});

// ---------------------------------------------------------------------------
// Webhook entity path — the reported bug was reading payload.payment (wrapper)
// instead of payload.payment.entity. This must unwrap the REAL object.
// ---------------------------------------------------------------------------
test("eventEntity unwraps payment.entity and order.entity, not the wrapper", () => {
    const paymentEvent = { event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 19900, currency: "INR" } } } };
    assert.equal(eventEntity(paymentEvent).id, "pay_1");
    assert.equal(eventEntity(paymentEvent).order_id, "order_1");

    const orderEvent = { event: "order.paid", payload: { order: { entity: { id: "order_2", amount: 5000 } } } };
    assert.equal(eventEntity(orderEvent).id, "order_2");

    assert.equal(eventEntity({ event: "unknown", payload: {} }), null);
    assert.equal(eventEntity({}), null);
});

// ---------------------------------------------------------------------------
// RAZORPAY PROVIDER ADAPTER — real collection shapes and EXPLICIT outcomes.
// Fixtures below are copied from razorpay@2.9.x REST responses: collections
// are flat { entity:"collection", count, items:[...] } — the historic bug
// read response.entity.data (undefined) and treated every fetch as unpaid.
// ---------------------------------------------------------------------------
const rzpPaymentEntity = (over = {}) => ({
    id: "pay_MOCKCAPTURED01",
    entity: "payment",
    order_id: "order_MOCK001",
    status: "captured",
    amount: 199900,
    amount_paid: 199900, // present on some SDK builds — must NOT be preferred blindly
    currency: "INR",
    created_at: 1750000000,
    ...over,
});

const collectionFixture = (items, count) => ({
    entity: "collection",
    count: count ?? items.length,
    items,
});

function mockRazorpay(responses) {
    return {
        orders: {
            fetchPayments: async () => {
                if (responses.fetchPayments instanceof Error) throw responses.fetchPayments;
                return responses.fetchPayments;
            },
        },
        payments: {
            fetchMultipleRefund: async () => {
                if (responses.refunds instanceof Error) throw responses.refunds;
                return responses.refunds;
            },
        },
    };
}

test("captured payment inside items[] is validated and returned — the exact entity the old code missed", async () => {
    const rzp = mockRazorpay({ fetchPayments: collectionFixture([rzpPaymentEntity()]) });
    const rec = await reconcileOrderPayments(rzp, "order_MOCK001", { expectedAmountPaise: 199900 });
    assert.equal(rec.outcome, RZP_OUTCOME.CAPTURED_VALID);
    // The authoritative amount comes from the PAYMENT entity in integer paise.
    assert.equal(rec.payment.amount, 199900);
    assert.equal(rec.payment.id, "pay_MOCKCAPTURED01");
});

test("a timeout is UNKNOWN — never collapsed into unpaid, so inventory is preserved", async () => {
    const rzp = mockRazorpay({ fetchPayments: new Error("connect ETIMEDOUT 157.245.3.11:443") });
    const rec = await reconcileOrderPayments(rzp, "order_MOCK001", { expectedAmountPaise: 199900 });
    assert.equal(rec.outcome, RZP_OUTCOME.UNKNOWN);
    assert.equal(rec.reason, "network_or_timeout");
    // Outcome is an explicit object — NOT null and NOT a boolean.
    assert.notEqual(rec, null);
    assert.notEqual(typeof rec, "boolean");
});

test("legacy entity.data-shaped response is UNKNOWN, not silently 'no payments'", async () => {
    // This is the shape the OLD buggy reader expected (and the real SDK does
    // NOT return). Reading it must yield UNKNOWN — absence is never proven
    // from a response we cannot parse.
    const legacyShape = { entity: "order", id: "order_MOCK001", entity: { data: [rzpPaymentEntity()] } };
    const rzp = mockRazorpay({ fetchPayments: legacyShape });
    const rec = await reconcileOrderPayments(rzp, "order_MOCK001", { expectedAmountPaise: 199900 });
    assert.equal(rec.outcome, RZP_OUTCOME.UNKNOWN);
    assert.equal(rec.reason, "malformed_collection_response");
});

test("empty-but-valid collection means genuinely no capture", async () => {
    const rzp = mockRazorpay({ fetchPayments: collectionFixture([]) });
    const rec = await reconcileOrderPayments(rzp, "order_MOCK001", { expectedAmountPaise: 199900 });
    assert.equal(rec.outcome, RZP_OUTCOME.NO_CAPTURED);
});

test("authorized-but-not-captured payment is IN_PROGRESS, never captured or absent", async () => {
    const rzp = mockRazorpay({
        fetchPayments: collectionFixture([rzpPaymentEntity({ status: "authorized", amount: 100, amount_paid: undefined })]),
    });
    const rec = await reconcileOrderPayments(rzp, "order_MOCK001", { expectedAmountPaise: 199900 });
    assert.equal(rec.outcome, RZP_OUTCOME.IN_PROGRESS);
});

test("captured amount mismatch against our authoritative total is an explicit MISMATCH", async () => {
    const rzp = mockRazorpay({ fetchPayments: collectionFixture([rzpPaymentEntity({ amount: 1 })]) });
    const rec = await reconcileOrderPayments(rzp, "order_MOCK001", { expectedAmountPaise: 199900 });
    assert.equal(rec.outcome, RZP_OUTCOME.MISMATCH);
    assert.equal(rec.reason, "amount_mismatch");
});

test("currency and order-id violations are MISMATCH — never auto-confirmed", async () => {
    const wrongCurrency = await reconcileOrderPayments(
        mockRazorpay({ fetchPayments: collectionFixture([rzpPaymentEntity({ currency: "USD" })]) }),
        "order_MOCK001",
        { expectedAmountPaise: 199900, expectedCurrency: "INR" }
    );
    assert.equal(wrongCurrency.outcome, RZP_OUTCOME.MISMATCH);
    assert.equal(wrongCurrency.reason, "currency_mismatch");

    const wrongOrder = await reconcileOrderPayments(
        mockRazorpay({ fetchPayments: collectionFixture([rzpPaymentEntity({ order_id: "order_SOMEONE_ELSE" })]) }),
        "order_MOCK001",
        { expectedAmountPaise: 199900 }
    );
    assert.equal(wrongOrder.outcome, RZP_OUTCOME.MISMATCH);
    assert.equal(wrongOrder.reason, "order_id_mismatch");
});

test("a PARTIAL collection (count > items) is UNKNOWN — a truncated list can't prove absence", async () => {
    const rzp = mockRazorpay({ fetchPayments: collectionFixture([rzpPaymentEntity({ status: "failed" })], 5) });
    const rec = await reconcileOrderPayments(rzp, "order_MOCK001", { expectedAmountPaise: 199900 });
    assert.equal(rec.outcome, RZP_OUTCOME.UNKNOWN);
    assert.equal(rec.reason, "partial_collection");
});

test("an expected payment id that is not the captured one is a conflict, not a silent pick", async () => {
    const rzp = mockRazorpay({ fetchPayments: collectionFixture([rzpPaymentEntity({ id: "pay_OTHER" })]) });
    const rec = await reconcileOrderPayments(rzp, "order_MOCK001", {
        expectedAmountPaise: 199900,
        expectedPaymentId: "pay_MOCKCAPTURED01",
    });
    assert.equal(rec.outcome, RZP_OUTCOME.MISMATCH);
    assert.equal(rec.reason, "payment_id_conflict");
});

test("non-configured gateway reconciles to UNKNOWN with a reason", async () => {
    const rec = await reconcileOrderPayments(null, "order_MOCK001", {});
    assert.equal(rec.outcome, RZP_OUTCOME.UNKNOWN);
    assert.equal(rec.reason, "gateway_not_configured");
});

// ---------------------------------------------------------------------------
// REFUNDS — payments.fetchMultipleRefund returns items[] too (the old code
// read response.data), and an error NEVER proves a refund does not exist.
// ---------------------------------------------------------------------------
test("findPaymentRefunds reads items[] and finds an existing refund for recovery", async () => {
    const rzp = mockRazorpay({
        refunds: collectionFixture([{ id: "rfnd_MOCK01", entity: "refund", status: "processed", amount: 199900, created_at: 1750000100 }]),
    });
    const res = await findPaymentRefunds(rzp, "pay_MOCKCAPTURED01");
    assert.equal(res.outcome, REFUND_LIST_OUTCOME.FOUND);
    assert.equal(res.refunds[0].id, "rfnd_MOCK01");
});

test("an empty refund collection is genuine NONE; a thrown error is UNKNOWN", async () => {
    const none = await findPaymentRefunds(mockRazorpay({ refunds: collectionFixture([]) }), "pay_1");
    assert.equal(none.outcome, REFUND_LIST_OUTCOME.NONE);

    const unknown = await findPaymentRefunds(mockRazorpay({ refunds: new Error("rate limit exceeded 429") }), "pay_1");
    assert.equal(unknown.outcome, REFUND_LIST_OUTCOME.UNKNOWN);
});

test("refundOutcome classifies every documented gateway status conservatively", () => {
    assert.equal(refundOutcome({ status: "processed" }), "processed");
    assert.equal(refundOutcome({ status: "written_out" }), "processed");
    assert.equal(refundOutcome({ status: "failed" }), "failed");
    assert.equal(refundOutcome({ status: "pending" }), "pending");
    assert.equal(refundOutcome({ status: "created" }), "pending");
    assert.equal(refundOutcome({ status: "something_new" }), RZP_OUTCOME.UNKNOWN); // never guess
    assert.equal(refundOutcome(null), RZP_OUTCOME.UNKNOWN);
});

// ---------------------------------------------------------------------------
// Shiprocket status mapping — forward-only, numeric codes, terminal-negative
// left to admin, and "Out For Pickup" DISTINCT from "Out For Delivery".
// ---------------------------------------------------------------------------
test("mapShipmentStatus maps progress and refuses to regress on negatives", () => {
    assert.equal(mapShipmentStatus("Delivered"), "delivered");
    assert.equal(mapShipmentStatus("Out for Delivery"), "out_for_delivery");
    assert.equal(mapShipmentStatus("In Transit"), "in_transit");
    assert.equal(mapShipmentStatus("Shipped"), "shipped");
    // Negative/terminal courier text must NEVER hijack our status:
    assert.equal(mapShipmentStatus("RTO Initiated"), null);
    assert.equal(mapShipmentStatus("Undelivered"), null);
    assert.equal(mapShipmentStatus("Cancelled"), null);
    assert.equal(mapShipmentStatus(""), null);
    assert.equal(mapShipmentStatus(null), null);
});

test("TRACKING-scan codes (shipment_track.status_code) map per the AWB endpoint — not the order set", () => {
    // The reviewer's authoritative tracking-endpoint codes. These DIFFER from
    // the order/shipment status_id space, which is exactly the old bug.
    assert.equal(mapShipmentStatus(6, "track"), "shipped");   // 6 = Shipped (NOT delivered!)
    assert.equal(mapShipmentStatus(7, "track"), "delivered");  // 7 = Delivered
    assert.equal(mapShipmentStatus("7", "track"), "delivered");// stringified
    assert.equal(mapShipmentStatus(17, "track"), "out_for_delivery"); // 17 = Out For Delivery
    assert.equal(mapShipmentStatus(18, "track"), "in_transit");       // 18 = In Transit
    assert.equal(mapShipmentStatus(19, "track"), "processing");       // 19 = Out For Pickup — NOT OFD
    assert.equal(mapShipmentStatus(99, "track"), null);               // undocumented code — never assume
    // A shipped payload (6) must NEVER read as delivered:
    assert.notEqual(mapShipmentStatus(6, "track"), "delivered");
});

test("ORDER/shipment status_id codes map in their OWN space (distinct numbers)", () => {
    assert.equal(mapShipmentStatus(6, "order"), "delivered"); // order-level 6 = Delivered
    assert.equal(mapShipmentStatus(5, "order"), "out_for_delivery");
    assert.equal(mapShipmentStatus(4, "order"), "in_transit");
    assert.equal(mapShipmentStatus(3, "order"), "shipped"); // Picked Up → shipped progression
    assert.equal(mapShipmentStatus(1, "order"), null); // "New" must not advance a real status
    // Same number, different meaning across spaces — proves they are not conflated:
    assert.equal(mapShipmentStatus(6, "track"), "shipped");
    assert.equal(mapShipmentStatus(6, "order"), "delivered");
});

test('"Out For Pickup" is never reported as Out For Delivery (text variants too)', () => {
    assert.equal(mapShipmentStatus("Out For Pickup", "track"), "processing");
    assert.equal(mapShipmentStatus("Pickup Exception", "track"), "processing");
    assert.equal(mapShipmentStatus("Attempted Delivery", "track"), "processing");
    assert.equal(mapShipmentStatus("Out for Delivery", "track"), "out_for_delivery");
    // And the rank ordering keeps OFD ahead of processing — a pickup attempt
    // must not advance a customer-visible "arriving today" state.
    assert.ok(STATUS_RANK.out_for_delivery > STATUS_RANK.processing);
});

// ---------------------------------------------------------------------------
// Tracking normalization + PII minimization for the PUBLIC tracking endpoint.
// ---------------------------------------------------------------------------
test("normalizeTrackingResult flattens the shipments[] + tracking_data variant", () => {
    const raw = {
        data: {
            shipments: [
                {
                    awb_code: "5443212029",
                    courier_name: "Delhivery",
                    tracking_data: {
                        shipment_status: "Delivered",
                        current_status: "Delivered",
                        track_url: "https://...",
                        shipment_track_activities: [
                            { date: "2026-01-02", "sr-status-label": "Delivered", location: "Delhi" },
                        ],
                    },
                },
            ],
            // PII that must NOT leak through sanitize:
            shipment_shipment_courier_master_id: 123,
        },
    };
    const n = normalizeTrackingResult(raw);
    assert.equal(n.awb, "5443212029");
    assert.equal(n.courierName, "Delhivery");
    assert.equal(n.currentStatus, "Delivered");
    assert.equal(n.activities[0].activity, "Delivered");
});

test("normalizeTrackingResult reads shipment_track[0].status_code with the TRACK code space", () => {
    // Actual shape of trackByAWB responses: the freshest scan lives in the FIRST
    // shipment_track element as a NUMERIC status_code (AWB endpoint space).
    const raw = {
        tracking_data: {
            id: 999,
            shipment_id: 1234,
            awb_code: "4455667788",
            courier_name: "BlueDart",
            shipment_status_id: 6, // order-level (Shipped) — must NOT outrank the scan
            current_status: "Shipped",
            shipment_track: [
                {
                    status_code: 7, // TRACK space: 7 = Delivered
                    shipment_track_detail: "Delivered",
                    "activity-date": "02 Jan 2026",
                    city: "Mumbai",
                },
            ],
            shipment_track_activities: [
                { date: "02 Jan 2026", status: "Delivered", city: "Mumbai" },
            ],
        },
    };
    const n = normalizeTrackingResult(raw);
    assert.equal(n.awb, "4455667788");
    assert.equal(n.shipmentStatus, "Delivered"); // scan text wins
    assert.equal(n.mappedStatus, "delivered");   // from status_code 7 (track space)
    assert.equal(n.activities.length >= 1, true);
});

test("a shipped (track code 6) scan is never normalized to delivered", () => {
    const raw = {
        tracking_data: {
            awb_code: "333",
            shipment_track: [{ status_code: 6, shipment_track_detail: "Shipped" }],
        },
    };
    const n = normalizeTrackingResult(raw);
    assert.equal(n.mappedStatus, "shipped");
    assert.notEqual(n.mappedStatus, "delivered");
});

test("Out For Pickup (track code 19) inside shipment_track never normalizes to out_for_delivery", () => {
    const raw = {
        tracking_data: {
            awb_code: "111",
            current_status: "Out For Pickup",
            shipment_track: [{ status_code: 19, shipment_track_detail: "Out For Pickup" }],
        },
    };
    const n = normalizeTrackingResult(raw);
    assert.equal(n.mappedStatus, "processing");
    assert.notEqual(n.mappedStatus, "out_for_delivery");
});

test("unrecognized provider text is preserved raw instead of guessed away", () => {
    const n = normalizeTrackingResult({
        tracking_data: { awb_code: "222", current_status: "Quantum Leap Arrived", shipment_status: "Quantum Leap Arrived" },
    });
    assert.equal(n.currentStatus, "Quantum Leap Arrived");
    assert.equal(n.mappedStatus, null); // preserved, not mapped
});

test("sanitizeTrackingForPublic exposes only courier-safe fields (no consignee PII)", () => {
    const sanitized = sanitizeTrackingForPublic({
        data: {
            shipments: [
                {
                    awb_code: "999",
                    courier_name: "BlueDart",
                    tracking_data: { current_status: "In Transit", shipment_status: "In Transit" },
                    shipment_shipment_payment_total_amount: 5000, // PII/business noise
                },
            ],
        },
    });
    assert.equal(sanitized.courier_name, "BlueDart");
    assert.equal(sanitized.current_status, "In Transit");
    // The sanitized object must be a whitelist — raw PII keys must be gone.
    assert.equal("shipment_shipment_payment_total_amount" in sanitized, false);
    assert.equal("data" in sanitized, false);
});

// ---------------------------------------------------------------------------
// Weight estimation drives both the adhoc payload and courier serviceability.
// ---------------------------------------------------------------------------
test("calculateWeight floors at 0.5kg and scales per unit", () => {
    assert.equal(shiprocket.calculateWeight({ items: [{ quantity: 1 }] }), 0.5);
    assert.equal(shiprocket.calculateWeight({ items: [{ quantity: 2 }] }), 1);
    assert.equal(shiprocket.calculateWeight({ items: [{ quantity: 3 }, { quantity: 1 }] }), 2);
    assert.equal(shiprocket.calculateWeight({ items: [] }), 0.5); // empty -> floor
});

// ---------------------------------------------------------------------------
// P6 — SHIPMENT RECONCILE LOOKUP returns EXPLICIT outcomes. A broken/ambiguous
// lookup must never be read as "not there" (which would let a duplicate create
// fire), and an order id must never be substituted for a shipment id.
// Mocks fetch so NOTHING hits the real Shiprocket API.
// ---------------------------------------------------------------------------
process.env.SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL || "test@example.com";
process.env.SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD || "test-pass";

function mockOrdersFetch(handler) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes("/auth/login")) {
            return { ok: true, status: 200, json: async () => ({ token: "fake-token" }) };
        }
        const res = handler(u, opts);
        if (res instanceof Error) throw res;
        return {
            ok: res.ok ?? true,
            status: res.status ?? 200,
            json: async () => res.body,
        };
    };
    return () => { globalThis.fetch = realFetch; };
}

test("shipment lookup: a complete listing with an exact match is FOUND with BOTH distinct ids", async () => {
    const restore = mockOrdersFetch(() => ({
        body: { data: { orders: [{ order_id: "TH-1001", id: 555, shipment_id: 999, status: "New" }], current_page: 1, total: 1 } },
    }));
    try {
        const r = await shiprocket.findShipmentByOurOrderId("TH-1001");
        assert.equal(r.outcome, "FOUND");
        assert.equal(r.shipment.srOrderId, 555);   // Shiprocket ORDER id
        assert.equal(r.shipment.shipmentId, 999);  // distinct SHIPMENT id — never the order id
    } finally { restore(); }
});

test("shipment lookup: a matched record missing a distinct shipment_id is UNKNOWN, not a substitution", async () => {
    const restore = mockOrdersFetch(() => ({
        body: { data: { orders: [{ order_id: "TH-1002", id: 777, status: "New" }], current_page: 1, total: 1 } },
    }));
    try {
        const r = await shiprocket.findShipmentByOurOrderId("TH-1002");
        assert.equal(r.outcome, "UNKNOWN");
        assert.equal(r.reason, "incomplete_match");
    } finally { restore(); }
});

test("shipment lookup: a network/timeout error is UNKNOWN (never treated as absence)", async () => {
    const restore = mockOrdersFetch(() => Object.assign(new Error("network timeout"), { name: "AbortError" }));
    try {
        const r = await shiprocket.findShipmentByOurOrderId("TH-1003");
        assert.equal(r.outcome, "UNKNOWN");
        assert.equal(r.reason, "fetch_failed");
    } finally { restore(); }
});

test("shipment lookup: a non-array / malformed body is UNKNOWN, not CONFIRMED_ABSENT", async () => {
    const restore = mockOrdersFetch(() => ({ body: { data: { orders: "not-an-array" } } }));
    try {
        const r = await shiprocket.findShipmentByOurOrderId("TH-1004");
        assert.equal(r.outcome, "UNKNOWN");
        assert.equal(r.reason, "malformed_body");
    } finally { restore(); }
});

test("shipment lookup: an empty listing WITHOUT page metadata is UNKNOWN (single lookup proves nothing)", async () => {
    const restore = mockOrdersFetch(() => ({ body: { data: { orders: [] } } }));
    try {
        const r = await shiprocket.findShipmentByOurOrderId("TH-1005");
        assert.equal(r.outcome, "UNKNOWN");
        assert.equal(r.reason, "empty_without_page_meta");
    } finally { restore(); }
});

test("shipment lookup: a complete paginated listing with no match is CONFIRMED_ABSENT", async () => {
    const restore = mockOrdersFetch(() => ({
        body: { data: { orders: [{ order_id: "OTHER-9", id: 1, shipment_id: 2 }], current_page: 1, total: 1, last_page: 1 } },
    }));
    try {
        const r = await shiprocket.findShipmentByOurOrderId("TH-1006");
        assert.equal(r.outcome, "CONFIRMED_ABSENT");
    } finally { restore(); }
});
