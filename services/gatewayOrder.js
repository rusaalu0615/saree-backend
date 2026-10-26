/**
 * GATEWAY ORDER SERVICE — Safe Razorpay Order Initialization & Reconciliation.
 *
 * Requirements:
 *  - Explicit discriminated result contract: { kind: "ready" | "in_progress" | "uncertain" | "rejected" | "terminal" | "not_required", order, ... }
 *  - Every result variant guarantees a valid, fresh, persisted order document (never undefined).
 *  - External calls outside database transactions.
 *  - Distinguishes definitive rejection from transient network timeouts, socket disconnects,
 *    and failure to persist a successful response.
 *  - Reconciles uncertain outcomes against Razorpay before concluding failure.
 *  - Never releases inventory or creates duplicate gateway orders solely due to timeouts.
 *  - Preserves checkout key and attempt state across recoverable / manual-review outcomes.
 *  - Single-source rejection cleanup: gatewayOrder.js marks order failed and releases reservation.
 */

import crypto from "crypto";
import Order from "../models/orderModal.js";
import { toPaise } from "../utils/security.js";
import { releaseReservation } from "./orderLifecycle.js";

export const GATEWAY_INIT_STATUS = {
    NONE: "none",
    INITIALIZING: "initializing",
    READY: "ready",
    UNCERTAIN: "uncertain",
    FAILED: "failed",
    MANUAL_REVIEW: "manual_review",
};

export const GATEWAY_ERROR_KIND = {
    DEFINITIVE_REJECTION: "definitive_rejection",
    TRANSIENT_NETWORK: "transient_network",
    PERSISTENCE_FAILURE: "persistence_failure",
    UNKNOWN: "unknown",
};

export const GATEWAY_RESULT_KIND = {
    READY: "ready",
    IN_PROGRESS: "in_progress",
    UNCERTAIN: "uncertain",
    REJECTED: "rejected",
    TERMINAL: "terminal",
    NOT_REQUIRED: "not_required",
};

const DEFAULT_LEASE_MS = 30 * 1000;

/**
 * Classify errors from Razorpay SDK or network calls.
 */
export function classifyGatewayError(err) {
    if (!err) return { kind: GATEWAY_ERROR_KIND.UNKNOWN, message: "Unknown error" };

    const status = err.statusCode || err.status || err.response?.status;
    const msg = String(err.message || err.error?.description || err).toLowerCase();
    const code = String(err.code || err.error?.code || "").toLowerCase();

    // 1. Transient / Network / Timeout errors
    if (
        /timeout|etimedout|esockettimedout|econnreset|econnrefused|enetunreach|socket hang up|fetch failed|network/.test(msg) ||
        code === "etimedout" || code === "econnreset" || code === "econnaborted" ||
        status === 408 || status === 429 || status === 502 || status === 503 || status === 504
    ) {
        return {
            kind: GATEWAY_ERROR_KIND.TRANSIENT_NETWORK,
            status,
            message: msg.slice(0, 300),
        };
    }

    // 2. Definitive rejections (bad request, authentication failure, unauthorized, unprocessable entity)
    if (
        status === 400 || status === 401 || status === 403 || status === 422 ||
        /bad request|unauthorized|forbidden|invalid key|authentication failed/.test(msg)
    ) {
        return {
            kind: GATEWAY_ERROR_KIND.DEFINITIVE_REJECTION,
            status,
            message: msg.slice(0, 300),
        };
    }

    return {
        kind: GATEWAY_ERROR_KIND.UNKNOWN,
        status,
        message: msg.slice(0, 300),
    };
}

/**
 * Claim an atomic lease to initialize a gateway order.
 * Returns:
 *  { state: "ready", order, razorpayOrderId } if already has a valid razorpayOrderId
 *  { state: "claimed", order, claimToken } if this caller won the lease
 *  { state: "in_progress", order } if another caller is currently initializing
 *  { state: "terminal", order } if order is paid/failed/cancelled
 */
export async function claimGatewayOrderInit(orderId, { leaseMs = DEFAULT_LEASE_MS, workerId = null } = {}) {
    const claimToken = workerId || crypto.randomBytes(16).toString("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs);

    // 1. Fast check if already ready or terminal
    const existing = await Order.findById(orderId);
    if (!existing) {
        return { state: "not_found" };
    }

    if (existing.payment?.razorpayOrderId) {
        return { state: "ready", order: existing, razorpayOrderId: existing.payment.razorpayOrderId };
    }

    if (["paid", "refunded", "failed"].includes(existing.payment?.status) || existing.status === "cancelled") {
        return { state: "terminal", order: existing };
    }

    // 2. Atomic conditional claim: only claim if not currently leased or lease expired
    const claimed = await Order.findOneAndUpdate(
        {
            _id: orderId,
            "payment.status": "pending",
            "payment.razorpayOrderId": { $in: [null, undefined, ""] },
            $or: [
                { "gatewayInit.status": { $in: [null, GATEWAY_INIT_STATUS.NONE, GATEWAY_INIT_STATUS.UNCERTAIN] } },
                { "gatewayInit.claimExpiresAt": { $exists: false } },
                { "gatewayInit.claimExpiresAt": null },
                { "gatewayInit.claimExpiresAt": { $lt: now } },
            ],
        },
        {
            $set: {
                "gatewayInit.status": GATEWAY_INIT_STATUS.INITIALIZING,
                "gatewayInit.claimToken": claimToken,
                "gatewayInit.claimExpiresAt": expiresAt,
                "gatewayInit.lastAttemptAt": now,
            },
            $inc: { "gatewayInit.attempts": 1 },
        },
        { new: true }
    );

    if (claimed) {
        return { state: "claimed", order: claimed, claimToken };
    }

    // If claim failed, re-read order to report accurate state
    const current = await Order.findById(orderId);
    if (current?.payment?.razorpayOrderId) {
        return { state: "ready", order: current, razorpayOrderId: current.payment.razorpayOrderId };
    }

    if (["paid", "refunded", "failed"].includes(current?.payment?.status) || current?.status === "cancelled") {
        return { state: "terminal", order: current };
    }

    return { state: "in_progress", order: current };
}

/**
 * Reconcile gateway order against Razorpay when an existing order ID is known
 * or check if an order entity matches our local expectations.
 */
export async function verifyGatewayOrderMatch(razorpay, razorpayOrderId, expectedOrder) {
    if (!razorpay || !razorpayOrderId) {
        return { outcome: "uncertain", reason: "missing_client_or_id" };
    }

    try {
        const remote = await razorpay.orders.fetch(razorpayOrderId);
        if (!remote || typeof remote !== "object") {
            return { outcome: "uncertain", reason: "malformed_order_response" };
        }

        const expectedPaise = toPaise(expectedOrder.pricing.total);
        if (remote.amount !== expectedPaise) {
            return { outcome: "mismatch", reason: "amount_mismatch", remoteAmount: remote.amount, expectedPaise };
        }
        if (remote.currency !== "INR") {
            return { outcome: "mismatch", reason: "currency_mismatch", remoteCurrency: remote.currency };
        }
        if (expectedOrder.orderId && remote.receipt && remote.receipt !== expectedOrder.orderId) {
            return { outcome: "mismatch", reason: "receipt_mismatch", remoteReceipt: remote.receipt, expectedReceipt: expectedOrder.orderId };
        }

        return { outcome: "valid", order: remote };
    } catch (err) {
        const classified = classifyGatewayError(err);
        return { outcome: "uncertain", error: classified };
    }
}

export const GATEWAY_LOOKUP_OUTCOME = {
    FOUND: "found",
    CONFIRMED_ABSENT: "confirmed_absent",
    UNKNOWN: "unknown",
    MISMATCH: "mismatch",
};

/**
 * Look up existing orders at Razorpay for an order's receipt before re-attempting orders.create.
 * Validates provider response shape, paginates through results, and strictly distinguishes
 * FOUND, CONFIRMED_ABSENT, UNKNOWN, and MISMATCH.
 */
export async function findExistingGatewayOrder(razorpay, order) {
    if (!razorpay || typeof razorpay.orders?.all !== "function" || !order?.orderId) {
        return { outcome: GATEWAY_LOOKUP_OUTCOME.UNKNOWN, reason: "missing_provider_or_receipt" };
    }

    try {
        const expectedPaise = toPaise(order.pricing?.total || 0);
        const matches = [];
        let skip = 0;
        const pageSize = 50;
        const maxPages = 5; // Search up to 250 orders
        let stopReason = "limit_reached";

        for (let page = 0; page < maxPages; page++) {
            let res;
            try {
                res = await razorpay.orders.all({ count: pageSize, skip });
            } catch (providerErr) {
                return {
                    outcome: GATEWAY_LOOKUP_OUTCOME.UNKNOWN,
                    reason: "provider_failure",
                    error: classifyGatewayError(providerErr),
                };
            }

            if (!res || typeof res !== "object") {
                return { outcome: GATEWAY_LOOKUP_OUTCOME.UNKNOWN, reason: "malformed_response" };
            }

            const items = Array.isArray(res.items) ? res.items : Array.isArray(res) ? res : null;
            if (!items) {
                return { outcome: GATEWAY_LOOKUP_OUTCOME.UNKNOWN, reason: "malformed_items_array" };
            }

            for (const o of items) {
                if (o && typeof o === "object" && o.receipt === order.orderId) {
                    matches.push(o);
                }
            }

            if (items.length < pageSize) {
                // Exhausted all remote orders in provider collection
                stopReason = "exhausted";
                break;
            }
            skip += pageSize;
        }

        // 1. If search stopped because the pagination cap was reached with full pages,
        // we cannot prove absence beyond 250 orders. Return UNKNOWN.
        if (stopReason === "limit_reached" && matches.length === 0) {
            return {
                outcome: GATEWAY_LOOKUP_OUTCOME.UNKNOWN,
                reason: "pagination_limit_reached",
                pagesChecked: maxPages,
                ordersScanned: skip,
            };
        }

        // 2. Multiple matching orders for the same receipt requires review
        if (matches.length > 1) {
            return {
                outcome: GATEWAY_LOOKUP_OUTCOME.MISMATCH,
                reason: "multiple_gateway_orders_found",
                orders: matches,
            };
        }

        // 3. Exactly one matching order found: strictly validate identifiers, receipt, amount, and currency
        if (matches.length === 1) {
            const matching = matches[0];
            const hasValidId = typeof matching.id === "string" && matching.id.length > 0;
            const matchesReceipt = matching.receipt === order.orderId;
            const matchesCurrency = String(matching.currency || "").toUpperCase() === "INR";
            const matchesAmount = matching.amount === expectedPaise;

            if (hasValidId && matchesReceipt && matchesCurrency && matchesAmount) {
                return {
                    outcome: GATEWAY_LOOKUP_OUTCOME.FOUND,
                    razorpayOrderId: matching.id,
                    remoteOrder: matching,
                };
            }
            return {
                outcome: GATEWAY_LOOKUP_OUTCOME.MISMATCH,
                reason: "amount_or_currency_mismatch",
                remoteOrder: matching,
                expectedPaise,
                remoteAmount: matching.amount,
                remoteCurrency: matching.currency,
                expectedReceipt: order.orderId,
                remoteReceipt: matching.receipt,
            };
        }

        // 4. No matches found and pagination was exhausted:
        // If an external call was previously dispatched (sentExternalCall === true),
        // provider indexing delay or eventual consistency means we CANNOT prove absence.
        // An earlier request may still complete or become visible later.
        if (order.gatewayInit?.sentExternalCall) {
            return {
                outcome: GATEWAY_LOOKUP_OUTCOME.UNKNOWN,
                reason: "external_call_dispatched_eventual_consistency",
            };
        }

        // Only after full pagination exhaustion with no prior external call is absence confirmed
        return { outcome: GATEWAY_LOOKUP_OUTCOME.CONFIRMED_ABSENT, reason: "exhausted" };
    } catch (err) {
        return {
            outcome: GATEWAY_LOOKUP_OUTCOME.UNKNOWN,
            reason: "provider_failure",
            error: classifyGatewayError(err),
        };
    }
}

/**
 * Safely initialize a Razorpay order for an order document.
 * Returns a strict discriminated union:
 *  { kind: "ready", order, razorpayOrderId, success: true, required: true }
 *  { kind: "in_progress", order, success: false, message }
 *  { kind: "uncertain", order, error, retryable: true, success: false, message }
 *  { kind: "rejected", order, error, success: false, message }
 *  { kind: "terminal", order, success: false, message }
 *  { kind: "not_required", order, success: true, required: false }
 */
export async function ensureGatewayOrder(razorpay, order, { leaseMs = DEFAULT_LEASE_MS } = {}) {
    // 1. If COD or zero-payable, no gateway order needed
    const totalPaise = toPaise(order.pricing?.total || 0);
    if (order.payment?.method === "cod" || totalPaise <= 0) {
        return {
            kind: GATEWAY_RESULT_KIND.NOT_REQUIRED,
            success: true,
            required: false,
            order,
        };
    }

    // 2. If already has razorpayOrderId, return ready
    if (order.payment?.razorpayOrderId) {
        return {
            kind: GATEWAY_RESULT_KIND.READY,
            success: true,
            required: true,
            razorpayOrderId: order.payment.razorpayOrderId,
            order,
        };
    }

    if (!razorpay) {
        throw new Error("Razorpay instance not configured");
    }

    // 3. Claim atomic lease
    const claim = await claimGatewayOrderInit(order._id, { leaseMs });
    if (claim.state === "ready") {
        return {
            kind: GATEWAY_RESULT_KIND.READY,
            success: true,
            required: true,
            razorpayOrderId: claim.razorpayOrderId,
            order: claim.order,
        };
    }

    if (claim.state === "terminal") {
        return {
            kind: GATEWAY_RESULT_KIND.TERMINAL,
            success: false,
            order: claim.order,
            message: "Order is already in a terminal state",
        };
    }

    if (claim.state === "in_progress") {
        return {
            kind: GATEWAY_RESULT_KIND.IN_PROGRESS,
            success: false,
            order: claim.order,
            message: "Gateway order initialization in progress",
        };
    }

    const { claimToken } = claim;
    const claimedOrder = claim.order;

    // 4. If an external call was previously sent, reconcile remotely before calling create again
    if (claimedOrder.gatewayInit?.sentExternalCall) {
        const existingLookup = await findExistingGatewayOrder(razorpay, claimedOrder);

        if (existingLookup.outcome === GATEWAY_LOOKUP_OUTCOME.FOUND) {
            const linked = await Order.findOneAndUpdate(
                { _id: order._id, "gatewayInit.claimToken": claimToken },
                {
                    $set: {
                        "payment.razorpayOrderId": existingLookup.razorpayOrderId,
                        "gatewayInit.status": GATEWAY_INIT_STATUS.READY,
                        "gatewayInit.claimToken": null,
                        "gatewayInit.claimExpiresAt": null,
                        "gatewayInit.lastError": null,
                    },
                },
                { new: true }
            );
            const fresh = linked || (await Order.findById(order._id));
            return {
                kind: GATEWAY_RESULT_KIND.READY,
                success: true,
                required: true,
                razorpayOrderId: existingLookup.razorpayOrderId,
                order: fresh,
            };
        }

        if (existingLookup.outcome === GATEWAY_LOOKUP_OUTCOME.MISMATCH) {
            // Mismatch stops initialization and places attempt on hold — NEVER blindly create another!
            await Order.updateOne(
                { _id: order._id, "gatewayInit.claimToken": claimToken },
                {
                    $set: {
                        "gatewayInit.status": GATEWAY_INIT_STATUS.MANUAL_REVIEW,
                        "gatewayInit.claimToken": null,
                        "gatewayInit.claimExpiresAt": null,
                        "gatewayInit.lastError": `Lookup mismatch: ${existingLookup.reason}`,
                        "fulfillmentHold.active": true,
                        "fulfillmentHold.reason": `Gateway order reconciliation mismatch: ${existingLookup.reason}`,
                    },
                }
            );
            const fresh = await Order.findById(order._id);
            return {
                kind: GATEWAY_RESULT_KIND.REJECTED,
                success: false,
                order: fresh,
                message: "Payment gateway order mismatch detected. Order has been held for review.",
            };
        }

        if (existingLookup.outcome === GATEWAY_LOOKUP_OUTCOME.UNKNOWN) {
            // Cannot establish remote status; retain uncertain state to prevent duplicate charge
            await Order.updateOne(
                { _id: order._id, "gatewayInit.claimToken": claimToken },
                {
                    $set: {
                        "gatewayInit.status": GATEWAY_INIT_STATUS.UNCERTAIN,
                        "gatewayInit.claimToken": null,
                        "gatewayInit.claimExpiresAt": null,
                    },
                }
            );
            const fresh = await Order.findById(order._id);
            return {
                kind: GATEWAY_RESULT_KIND.UNCERTAIN,
                success: false,
                retryable: true,
                error: existingLookup.error,
                order: fresh,
                message: "Previous payment initialization outcome is uncertain. Reconciling with gateway.",
            };
        }
        // Only if outcome === CONFIRMED_ABSENT can execution proceed to create a new order
    }

    // 5. Persist external call intent with fenced ownership before calling Razorpay
    const intentRes = await Order.updateOne(
        {
            _id: order._id,
            "gatewayInit.claimToken": claimToken,
            "payment.status": "pending",
            status: { $ne: "cancelled" },
            $or: [
                { "gatewayInit.claimExpiresAt": { $exists: false } },
                { "gatewayInit.claimExpiresAt": null },
                { "gatewayInit.claimExpiresAt": { $gte: new Date() } },
            ],
        },
        {
            $set: {
                "gatewayInit.sentExternalCall": true,
                "gatewayInit.intentAt": new Date(),
            },
        }
    );

    if (intentRes.matchedCount === 0) {
        console.warn(`[GatewayOrder] Lost claim ownership before external call for ${order.orderId}`);
        const fresh = await Order.findById(order._id);
        return {
            kind: GATEWAY_RESULT_KIND.UNCERTAIN,
            success: false,
            retryable: true,
            order: fresh || order,
            message: "Initialization lease expired or superseded before gateway dispatch.",
        };
    }

    // 6. External call OUTSIDE database transactions
    let rzpOrder;
    try {
        rzpOrder = await razorpay.orders.create({
            amount: totalPaise,
            currency: "INR",
            receipt: order.orderId,
        });
    } catch (err) {
        const classified = classifyGatewayError(err);

        if (classified.kind === GATEWAY_ERROR_KIND.DEFINITIVE_REJECTION) {
            // Definitive rejection: mark failed and release resources cleanly in gatewayOrder service
            const updated = await Order.findOneAndUpdate(
                {
                    _id: order._id,
                    "gatewayInit.claimToken": claimToken,
                    "payment.status": "pending",
                    status: { $ne: "cancelled" },
                },
                {
                    $set: {
                        "payment.status": "failed",
                        "gatewayInit.status": GATEWAY_INIT_STATUS.FAILED,
                        "gatewayInit.claimToken": null,
                        "gatewayInit.claimExpiresAt": null,
                        "gatewayInit.nextAttemptAt": null,
                        "gatewayInit.lastError": classified.message,
                    },
                    $push: {
                        timeline: {
                            status: "Payment Initiation Failed",
                            description: `Gateway rejected order creation: ${classified.message}`,
                            date: new Date(),
                        },
                    },
                },
                { new: true }
            );

            if (updated) {
                await releaseReservation(order._id, { reason: "gateway-init-rejected" });
            }
            const fresh = updated || (await Order.findById(order._id));

            return {
                kind: GATEWAY_RESULT_KIND.REJECTED,
                success: false,
                error: classified,
                order: fresh,
                message: "Payment gateway rejected the order initialization. Please try again.",
            };
        }

        // Transient / Network / Timeout / Uncertain:
        // DO NOT release inventory! Retain recoverable state.
        const updated = await Order.findOneAndUpdate(
            {
                _id: order._id,
                "gatewayInit.claimToken": claimToken,
                "payment.status": "pending",
                status: { $ne: "cancelled" },
            },
            {
                $set: {
                    "gatewayInit.status": GATEWAY_INIT_STATUS.UNCERTAIN,
                    "gatewayInit.claimToken": null,
                    "gatewayInit.claimExpiresAt": null,
                    "gatewayInit.lastError": classified.message,
                },
                $push: {
                    timeline: {
                        status: "Gateway Initialization Uncertain",
                        description: "Network timeout or connection issue during gateway order creation. Order retained for recovery.",
                        date: new Date(),
                    },
                },
            },
            { new: true }
        );

        const fresh = updated || (await Order.findById(order._id));
        return {
            kind: GATEWAY_RESULT_KIND.UNCERTAIN,
            success: false,
            retryable: true,
            error: classified,
            order: fresh,
            message: "Payment initialization timed out. Your order is retained and will reconcile safely.",
        };
    }

    // 7. External call succeeded! Persist the provider response with fenced ownership.
    try {
        const updated = await Order.findOneAndUpdate(
            {
                _id: order._id,
                "gatewayInit.claimToken": claimToken,
                "payment.status": "pending",
                status: { $ne: "cancelled" },
            },
            {
                $set: {
                    "payment.razorpayOrderId": rzpOrder.id,
                    "gatewayInit.status": GATEWAY_INIT_STATUS.READY,
                    "gatewayInit.claimToken": null,
                    "gatewayInit.claimExpiresAt": null,
                    "gatewayInit.nextAttemptAt": null,
                    "gatewayInit.lastError": null,
                },
            },
            { new: true }
        );

        if (!updated) {
            // Lost claim or race: check if current document already has razorpayOrderId
            const fresh = await Order.findById(order._id);
            if (fresh?.payment?.razorpayOrderId === rzpOrder.id) {
                return {
                    kind: GATEWAY_RESULT_KIND.READY,
                    success: true,
                    required: true,
                    razorpayOrderId: rzpOrder.id,
                    order: fresh,
                };
            }

            // Fenced write: DO NOT unconditionally overwrite another worker's claim!
            console.error(`[GatewayOrder] Lost claim for order ${order.orderId} while persisting ${rzpOrder.id}`);
            return {
                kind: GATEWAY_RESULT_KIND.UNCERTAIN,
                success: false,
                retryable: true,
                order: fresh || order,
                message: "Gateway order created remotely but claim ownership was reassigned. Order retained for reconciliation.",
            };
        }

        return {
            kind: GATEWAY_RESULT_KIND.READY,
            success: true,
            required: true,
            razorpayOrderId: rzpOrder.id,
            order: updated,
        };
    } catch (persistErr) {
        console.error(`[GatewayOrder] Failed to persist gateway order ${rzpOrder.id} for order ${order.orderId}:`, persistErr.message);
        const fenceRes = await Order.updateOne(
            { _id: order._id, "gatewayInit.claimToken": claimToken },
            {
                $set: {
                    "payment.razorpayOrderId": rzpOrder.id,
                    "gatewayInit.status": GATEWAY_INIT_STATUS.MANUAL_REVIEW,
                    "gatewayInit.lastError": `Created ${rzpOrder.id} but persist error: ${persistErr.message}`,
                },
            }
        ).catch(() => null);

        if (!fenceRes || fenceRes.matchedCount === 0) {
            console.error(`[GatewayOrder] Lost claim token while recording persist error for ${order.orderId}; preserved ${rzpOrder.id} for reconciliation without overwriting newer claim`);
        }

        const fresh = (await Order.findById(order._id)) || order;
        return {
            kind: GATEWAY_RESULT_KIND.UNCERTAIN,
            success: false,
            retryable: true,
            persistenceError: true,
            razorpayOrderId: rzpOrder.id,
            order: fresh,
            message: "Order was created at the payment gateway but local confirmation is pending.",
        };
    }
}

export default {
    GATEWAY_INIT_STATUS,
    GATEWAY_ERROR_KIND,
    GATEWAY_RESULT_KIND,
    GATEWAY_LOOKUP_OUTCOME,
    classifyGatewayError,
    claimGatewayOrderInit,
    verifyGatewayOrderMatch,
    findExistingGatewayOrder,
    ensureGatewayOrder,
};
