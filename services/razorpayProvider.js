/**
 * Razorpay PROVIDER ADAPTER — the only place that knows SDK response shapes.
 *
 * Verified against the installed razorpay@2.9.8 (dist/resources/*.js) and the
 * official REST docs:
 *  - orders.fetchPayments()  → GET /orders/{id}/payments → a FLAT collection:
 *        { entity: "collection", count: Number, items: [paymentEntity...] }
 *    (NOT response.entity.data)
 *  - payments.fetchMultipleRefund() → GET /payments/{id}/refunds → same flat
 *    collection shape: refunds live in response.items (NOT response.data)
 *  - A PAYMENT entity carries `amount` (integer paise captured). `amount_paid`
 *    is a field of the ORDER entity — the two must never be conflated.
 *
 * Reconciliation returns EXPLICIT outcomes; a lookup failure is NEVER collapsed
 * into "no payment found":
 *   CAPTURED_VALID      — captured, and paymentId/orderId/amount/currency all match
 *   NO_CAPTURED         — collection fetched OK, contains only non-capturable rows
 *   IN_PROGRESS          — an authorized/created payment exists, capture pending
 *   MISMATCH             — a captured payment exists but violates a hard invariant
 *   UNKNOWN              — timeout / network / auth / rate-limit / malformed shape
 *
 * UNKNOWN preserves inventory and payment state until a later safe
 * reconciliation or explicit operational resolution.
 */

export const RZP_OUTCOME = {
    CAPTURED_VALID: "captured_valid",
    NO_CAPTURED: "no_captured",
    IN_PROGRESS: "in_progress",
    MISMATCH: "mismatch",
    UNKNOWN: "unknown",
};

export const REFUND_LIST_OUTCOME = {
    FOUND: "found",
    NONE: "none",     // list fetched successfully and is genuinely empty
    UNKNOWN: "unknown", // timeout/auth/rate-limit/malformed — absence NOT proven
};

const isPositiveInt = (v) => Number.isInteger(v) && v >= 0;

// Deterministic failure classification. Anything we cannot classify is UNKNOWN.
function classifyError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    if (/timeout|abort|socket|econn|etimedout|network|fetch failed|socket hang up/.test(msg)) {
        return { outcome: RZP_OUTCOME.UNKNOWN, reason: "network_or_timeout", detail: msg.slice(0, 200) };
    }
    if (/auth|key|401|403|unauthorized|forbidden/.test(msg)) {
        return { outcome: RZP_OUTCOME.UNKNOWN, reason: "authentication", detail: msg.slice(0, 200) };
    }
    if (/rate ?limit|429|too many/.test(msg)) {
        return { outcome: RZP_OUTCOME.UNKNOWN, reason: "rate_limited", detail: msg.slice(0, 200) };
    }
    return { outcome: RZP_OUTCOME.UNKNOWN, reason: "provider_error", detail: msg.slice(0, 200) };
}

/**
 * A Razorpay collection must be { entity:"collection", count, items:[...] }.
 * Anything else is a MALFORMED response → UNKNOWN, never an empty success.
 */
function parseCollection(res) {
    if (!res || typeof res !== "object") return null;
    if (!Array.isArray(res.items)) return null; // unknown shape → caller treats as UNKNOWN
    const count = Number.isInteger(res.count) ? res.count : res.items.length;
    return { items: res.items, count };
}

/**
 * Reconcile an order's payment state against the gateway.
 *
 * @param {Object} razorpay   initialized SDK instance (or null → UNKNOWN)
 * @param {String} rzpOrderId stored gateway order id (required)
 * @param {Object} expectations {
 *     expectedAmountPaise: Integer   — our authoritative order total in paise
 *     expectedCurrency:    "INR"
 *     expectedPaymentId:   String?   — if set, the capture MUST be this payment
 *   }
 * @returns {Object} explicit outcome (see RZP_OUTCOME)
 */
export async function reconcileOrderPayments(razorpay, rzpOrderId, expectations = {}) {
    if (!razorpay || typeof rzpOrderId !== "string" || !rzpOrderId) {
        return { outcome: RZP_OUTCOME.UNKNOWN, reason: !razorpay ? "gateway_not_configured" : "missing_order_id" };
    }

    let res;
    try {
        res = await razorpay.orders.fetchPayments(rzpOrderId);
    } catch (err) {
        return { ...classifyError(err), source: "fetchPayments" };
    }

    const collection = parseCollection(res);
    if (!collection) {
        // Malformed/unrecognized response — outcome is UNKNOWN, NOT "empty".
        return { outcome: RZP_OUTCOME.UNKNOWN, reason: "malformed_collection_response", source: "fetchPayments" };
    }
    // Pagination guard: an order normally has few payments; if the provider
    // reports more than we received, our view is partial → never conclude
    // NO_CAPTURED from a partial list.
    if (collection.count > collection.items.length) {
        return { outcome: RZP_OUTCOME.UNKNOWN, reason: "partial_collection", count: collection.count, received: collection.items.length };
    }

    const { expectedAmountPaise, expectedCurrency = "INR", expectedPaymentId } = expectations;

    const captured = collection.items.filter(
        (p) => p && p.entity === "payment" && p.status === "captured"
    );
    const inProgress = collection.items.find(
        (p) => p && p.entity === "payment" && (p.status === "authorized" || p.status === "created")
    );

    if (captured.length === 0) {
        if (inProgress) {
            return { outcome: RZP_OUTCOME.IN_PROGRESS, payment: inProgress };
        }
        return { outcome: RZP_OUTCOME.NO_CAPTURED };
    }

    // Prefer the payment that matches our recorded id, else the newest capture.
    const sortedByNewest = captured.slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const chosen = expectedPaymentId
        ? sortedByNewest.find((p) => p.id === expectedPaymentId) || sortedByNewest[0]
        : sortedByNewest[0];

    // HARD INVARIANTS — a captured payment that violates any of these must not
    // be auto-confirmed; it is a MISMATCH for explicit operational resolution.
    if (typeof chosen.id !== "string" || !chosen.id) {
        return { outcome: RZP_OUTCOME.MISMATCH, reason: "payment_id_missing", payment: chosen };
    }
    if (expectedPaymentId && chosen.id !== expectedPaymentId) {
        return { outcome: RZP_OUTCOME.MISMATCH, reason: "payment_id_conflict", payment: chosen };
    }
    if (chosen.order_id !== rzpOrderId) {
        return { outcome: RZP_OUTCOME.MISMATCH, reason: "order_id_mismatch", payment: chosen };
    }
    if (chosen.currency !== expectedCurrency) {
        return { outcome: RZP_OUTCOME.MISMATCH, reason: "currency_mismatch", payment: chosen };
    }
    if (!isPositiveInt(chosen.amount)) {
        // Payment entities use `amount` (paise). A non-integer here is a shape
        // violation — UNKNOWN, because we cannot trust the collection parse.
        return { outcome: RZP_OUTCOME.UNKNOWN, reason: "payment_amount_not_integer", payment: chosen };
    }
    if (Number.isInteger(expectedAmountPaise) && chosen.amount !== expectedAmountPaise) {
        return { outcome: RZP_OUTCOME.MISMATCH, reason: "amount_mismatch", payment: chosen, expectedAmountPaise };
    }

    return { outcome: RZP_OUTCOME.CAPTURED_VALID, payment: chosen };
}

/**
 * Look up refunds already attached to a payment (recovering from an uncertain
 * refund initiation). Uses response.items per the SDK/collection shape.
 * Returns FOUND / NONE / UNKNOWN — an error NEVER proves absence.
 */
export async function findPaymentRefunds(razorpay, paymentId) {
    if (!razorpay || typeof paymentId !== "string" || !paymentId) {
        return { outcome: REFUND_LIST_OUTCOME.UNKNOWN, reason: "insufficient_input" };
    }
    let res;
    try {
        res = await razorpay.payments.fetchMultipleRefund(paymentId, { count: 100 });
    } catch (err) {
        return { ...classifyError(err), outcome: REFUND_LIST_OUTCOME.UNKNOWN, source: "fetchMultipleRefund" };
    }
    const collection = parseCollection(res);
    if (!collection) {
        return { outcome: REFUND_LIST_OUTCOME.UNKNOWN, reason: "malformed_refund_collection" };
    }
    if (collection.count > collection.items.length) {
        return { outcome: REFUND_LIST_OUTCOME.UNKNOWN, reason: "partial_refund_collection" };
    }
    const refunds = collection.items.filter((r) => r && typeof r.id === "string");
    if (refunds.length === 0) return { outcome: REFUND_LIST_OUTCOME.NONE, refunds: [] };
    return { outcome: REFUND_LIST_OUTCOME.FOUND, refunds };
}

/** Classify a single refund entity into the local lifecycle vocabulary. */
export function refundOutcome(refundEntity) {
    if (!refundEntity || typeof refundEntity !== "object") return RZP_OUTCOME.UNKNOWN;
    switch (refundEntity.status) {
        case "processed": return "processed";
        case "failed": return "failed";
        case "written_out": return "processed"; // bank payout completed
        case "pending":
        case "created": return "pending";
        default: return RZP_OUTCOME.UNKNOWN; // unrecognized — never guess
    }
}

export default { reconcileOrderPayments, findPaymentRefunds, refundOutcome, RZP_OUTCOME, REFUND_LIST_OUTCOME };
