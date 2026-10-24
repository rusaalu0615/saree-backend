/**
 * ORDER LIFECYCLE SERVICE — explicit state transitions for five SEPARATE
 * dimensions. Controllers, webhooks, the browser-verification path, admin
 * actions and background reconciliation all share these functions, so an
 * outcome is never decided by a scattered `order.status` string comparison.
 *
 *   1. payment.status       pending → paid → refunded  (| failed)
 *   2. reservation.state    held → release_requested → released
 *                                     → return_pending → return_restored
 *   3. fulfillment.stage    (see fulfillmentWorker — persisted pipeline)
 *   4. cancellation.status  none → requested → completed   (courier outcome
 *                           recorded SEPARATELY: intent ≠ proof)
 *   5. refund.status        requested → pending → processed (| failed/unknown)
 *
 * `order.status` remains only as a DISPLAY summary for the existing UI/emails.
 *
 * INVARIANTS ENFORCED HERE
 *  - A payment lookup failure never means "unpaid" (caller keeps `pending`).
 *  - A paid payment can never be downgraded by a stale expiry worker: expiry
 *    and confirmation COMPETE through conditional updates that require
 *    `payment.status: "pending"` — whichever wins, the other matches nothing.
 *  - Inventory is released at most once: the release marker, the product
 *    increments and the coupon-claim release commit in ONE transaction, and a
 *    failed transaction leaves DURABLE, RETRYABLE work instead of excluding the
 *    order from later cleanup queries.
 *  - Shiprocket/email/network calls never happen inside a retried transaction.
 *  - Stock for a DISPATCHED parcel is only restored by a VERIFIED physical
 *    return, exactly once, without re-opening the original order.
 *  - Delayed/out-of-order events cannot silently reactivate cancelled or
 *    refunded fulfillment (terminal transitions are one-way).
 */
import crypto from "crypto";
import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import Coupon from "../models/couponModal.js";
import EmailJob from "../models/emailJobModel.js";

// Bounded release-refill safety: coupon usedCount never goes below zero.
const clampNonNeg = (n) => Math.max(0, Number(n) || 0);

// A worker id unique to this process — used for DB-backed lease ownership so a
// stale/crashed worker can never clear another worker's lock or advance stages.
export const WORKER_ID = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

/**
 * Run `fn` inside a MongoDB transaction using Mongoose's supported session API.
 *
 * TRANSACTIONS REQUIRE A MongoDB REPLICA SET (or sharded cluster). A standalone
 * mongod cannot start a transaction — `startSession`/`withTransaction` throw
 * "Transaction numbers are only allowed on a replica set member or mongos". We
 * surface that as a real failure; we NEVER silently fall back to non-
 * transactional multi-document writes, because that would let a half-applied
 * release/return corrupt stock or coupon counts. Recovery callers treat a thrown
 * error as "retryable" so the durable work is retried once a replica set is
 * available.
 *
 * `fn(session)` MUST be re-runnable: the driver retries a transaction on
 * TransientTransactionError / UnknownTransactionCommitResult, so `fn` MUST use
 * fresh reads + conditional writes and MUST NOT call Razorpay/Shiprocket/email
 * (external side effects cannot be rolled back and would fire per retry).
 *
 * @param {(session: import('mongoose').ClientSession) => Promise<any>} fn
 * @returns {Promise<any>} whatever `fn` resolves to after a successful commit
 */
export async function withTransaction(fn) {
    if (mongoose.connection.readyState !== 1) {
        throw new Error("MongoDB connection not ready for transaction");
    }
    // Mongoose's own API: startSession() is synchronous and returns a session
    // (NOT a promise); endSession() ends + returns it to the pool. Using
    // `db.client().startSession()` was wrong — `db.client` is not a function and
    // the raw driver's startSession is not promise-based.
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            result = await fn(session);
        }, {
            // Bounded retry so a transient write conflict resolves rather than
            // surfacing every contention blip as a hard failure.
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" },
        });
        return result;
    } finally {
        await session.endSession();
    }
}

// ===========================================================================
// 1. PAYMENT STATE
// ===========================================================================

/**
 * ATOMIC capture confirmation. Exactly one caller transitions pending→paid.
 * Browser verification, the webhook and reconciliation all funnel here, so
 * out-of-order / duplicate / concurrent events settle to one outcome.
 *
 * Follow-up fulfillment + email work is persisted in the SAME transaction as
 * the payment flip, so a crash after commit can never strand a paid order that
 * was supposed to ship or notify — the background workers resume from the
 * stored stage.
 *
 * @returns {Object|null} claimed order doc, or null if it was NOT confirmable
 *   (already terminal, cancelled, refunded, or a late capture whose inventory
 *    was already released → durable fulfillment hold, NOT dispatch).
 */
export async function confirmPaymentCaptured(orderId, { paymentId, amountPaise, source }, followUp = { fulfill: true, email: true }) {
    return withTransaction(async (session) => {
        // Conditional claim — requires the CURRENT state to still be payable.
        const set = {
            "payment.status": "paid",
            "payment.amountPaid": amountPaise,
        };
        if (paymentId) set["payment.razorpayPaymentId"] = paymentId;

        const claimed = await Order.findOneAndUpdate(
            { _id: orderId, "payment.status": { $in: ["pending", "failed"] } },
            { $set: set, $push: { timeline: { status: "Payment Successful", description: `Payment confirmed (${source})`, date: new Date() } } },
            { new: true, session }
        );
        if (!claimed) return null; // another path won, or terminal (paid/refunded)

        // Late capture onto a cancelled order: money is real but fulfillment
        // must NOT resume silently — hold for explicit refund/manual workflow.
        if (claimed.cancellation?.status === "requested" || claimed.status === "cancelled") {
            await Order.updateOne(
                { _id: claimed._id },
                { $set: { "fulfillmentHold.active": true, "fulfillmentHold.reason": "Captured payment on a cancelled order — manual refund review required.", "fulfillmentHold.reallocationOutcome": null } },
                { session }
            );
            return null;
        }

        // Late capture after the reservation already expired/released: set a
        // DURABLE hold, do not dispatch and do not merely log a warning.
        if (claimed.reservation?.state === "released" || claimed.resourcesReleased) {
            await Order.updateOne(
                { _id: claimed._id },
                { $set: { "fulfillmentHold.active": true, "fulfillmentHold.reason": "Payment captured after inventory was released — re-reserve stock or refund via admin workflow." } },
                { session }
            );
            return null;
        }

        // A durable-but-uncommitted release intent (release_requested from an
        // expiry path that had NOT yet restored stock) must be RECLAIMED here:
        // the order is now paid, so its still-held allocation stays live and the
        // release retry is cancelled. Runs in THIS transaction, so it competes
        // atomically with any in-flight releaseReservation.
        if (claimed.reservation?.state === "release_requested") {
            await Order.updateOne(
                { _id: claimed._id },
                { $set: { "reservation.state": "held", "reservation.retryable": false, "reservation.nextAttemptAt": null, "reservation.lastError": null, resourcesReleased: false } },
                { session }
            );
        }

        // Persist follow-up WORK atomically with the payment transition. The
        // response/process does not need to survive — workers resume here.
        const update = {};
        if (followUp.fulfill && (claimed.fulfillment?.stage == null || claimed.fulfillment.stage === "none")) {
            update["fulfillment.stage"] = "ready";
            update["fulfillment.nextAttemptAt"] = new Date();
        }
        if (Object.keys(update).length) {
            await Order.updateOne({ _id: claimed._id }, { $set: update }, { session });
        }
        if (followUp.email) {
            await enqueueEmails(claimed, session);
        }
        return claimed;
    });
}

/**
 * Reservation EXPIRY transition. Competes with confirmation through a
 * conditional update that REQUIRES payment to still be pending — so a payment
 * confirmed concurrently (or earlier) makes this a no-op. Never downgrades a
 * paid order.
 * @returns {boolean} true if this call won the transition to failed.
 */
export async function expirePendingPayment(orderId) {
    const res = await Order.updateOne(
        { _id: orderId, "payment.status": "pending" },
        {
            $set: { "payment.status": "failed" },
            $push: { timeline: { status: "Payment Expired", description: "No captured payment within the reservation window.", date: new Date() } },
        }
    );
    return res.modifiedCount === 1;
}

// ===========================================================================
// 2. INVENTORY RESERVATION STATE
// ===========================================================================

/**
 * Release held inventory + coupon claim for a PRE-DISPATCH order — at most once,
 * atomically, ONLY when the order is genuinely eligible.
 *
 * ELIGIBILITY (rechecked INSIDE the transaction, not just from a stale read):
 *   reservation.state ∈ {held, release_requested}      (pre-dispatch, not yet released)
 *   AND ( payment.status ∈ {pending, failed, refunded}  (unpaid / expired / money back)
 *         OR cancellation.status ∈ {requested, completed} )
 * A PAID, NON-CANCELLED order is NEVER released — this closes the race where an
 * expiry worker marked payment `failed`, a late capture flipped it to `paid`, and
 * a separate release then restored stock for an order that must still ship.
 * Capture and release therefore COMPETE on the same authoritative document.
 *
 * A DISPATCHED order (reservation.state "return_pending") is not released here;
 * its stock returns only via confirmPhysicalReturn(). On a real transaction
 * failure the order stays `release_requested` + retryable with backoff so
 * recovery keeps trying — it is never "marked failed and excluded forever".
 * @returns {Object} { released: boolean, retryable: boolean, reason?: string }
 */
export async function releaseReservation(orderId, { reason = "order-failed" } = {}) {
    let order;
    try {
        order = await Order.findById(orderId);
    } catch (e) {
        return { released: false, retryable: true, reason: "read_failed" };
    }
    if (!order) return { released: false, retryable: false, reason: "not_found" };

    const state = order.reservation?.state || (order.resourcesReleased ? "released" : "held");
    if (state === "released" || state === "return_restored") {
        return { released: false, retryable: false, reason: "already_released" };
    }
    if (state === "return_pending") {
        // Physically with the courier — wait for a verified return.
        return { released: false, retryable: false, reason: "dispatched_awaiting_return" };
    }

    const isEligible = (o) =>
        ["pending", "failed", "refunded"].includes(o?.payment?.status) ||
        ["requested", "completed"].includes(o?.cancellation?.status);

    // Fast-path eligibility so a queued retry of an unpaid expiry does not even
    // open a transaction once the order has become an active paid fulfillment.
    if (!isEligible(order)) {
        await Order.updateOne(
            { _id: orderId, "reservation.retryable": true },
            { $set: { "reservation.retryable": false, "reservation.nextAttemptAt": null, "reservation.lastError": "release blocked: active paid order retains its allocation" } }
        ).catch(() => {});
        return { released: false, retryable: false, reason: "paid_keep_hold" };
    }

    try {
        const outcome = await withTransaction(async (session) => {
            // Atomic claim that RE-CHECKS eligibility at write time. A capture
            // committed concurrently makes this match nothing (no wrongful release).
            const claimed = await Order.findOneAndUpdate(
                {
                    _id: orderId,
                    "reservation.state": { $in: ["held", "release_requested"] },
                    $or: [
                        { "payment.status": { $in: ["pending", "failed", "refunded"] } },
                        { "cancellation.status": { $in: ["requested", "completed"] } },
                    ],
                },
                { $set: { "reservation.state": "release_requested", "reservation.releaseReason": reason, "reservation.retryable": false, resourcesReleased: false } },
                { new: true, session }
            );
            if (!claimed) return { kind: "no_claim" };

            const increments = (claimed.items || [])
                .filter((it) => it.productId)
                .map((it) => ({ updateOne: { filter: { _id: it.productId }, update: { $inc: { stock: it.quantity } } } }));
            if (increments.length) await Product.bulkWrite(increments, { session });

            if (claimed.pricing?.couponCode) {
                const coupon = await Coupon.findOne({ code: claimed.pricing.couponCode }).session(session);
                if (coupon) {
                    const idx = coupon.usedBy.findIndex((uid) => uid.toString() === claimed.user?.toString());
                    if (idx !== -1) coupon.usedBy.splice(idx, 1);
                    coupon.usedCount = clampNonNeg(coupon.usedCount - 1);
                    await coupon.save({ session });
                }
            }

            await Order.updateOne(
                { _id: orderId, "reservation.state": "release_requested" },
                { $set: { "reservation.state": "released", "reservation.releasedAt": new Date(), "reservation.retryable": false, "reservation.nextAttemptAt": null, "reservation.lastError": null, resourcesReleased: true, resourcesReleasedAt: new Date() } },
                { session }
            );
            return { kind: "released" };
        });

        if (outcome?.kind === "released") return { released: true, retryable: false };

        // no_claim: classify WHY after the (aborted) transaction using fresh state.
        const fresh = await Order.findById(orderId).select("payment.status cancellation.status reservation.state reservation.retryable").lean();
        if (fresh?.reservation?.state === "released" || fresh?.reservation?.state === "return_restored") {
            return { released: false, retryable: false, reason: "already_released" };
        }
        if (!isEligible(fresh)) {
            // A capture won the race — keep the hold and stop retrying.
            await Order.updateOne(
                { _id: orderId, "reservation.retryable": true },
                { $set: { "reservation.retryable": false, "reservation.nextAttemptAt": null, "reservation.lastError": "release blocked: active paid order retains its allocation" } }
            ).catch(() => {});
            return { released: false, retryable: false, reason: "paid_keep_hold" };
        }
        return { released: false, retryable: false, reason: "concurrent_release" };
    } catch (err) {
        // Retain durable retry work on a genuine transaction/infra failure.
        console.error(`[Lifecycle] releaseReservation transaction failed for ${orderId}:`, err.message);
        await Order.updateOne(
            { _id: orderId },
            { $set: { "reservation.state": "release_requested", "reservation.retryable": true, "reservation.lastError": String(err.message || err).slice(0, 400), "reservation.nextAttemptAt": backoffDate(order.reservation?.attempts) }, $inc: { "reservation.attempts": 1 } }
        ).catch(() => {});
        return { released: false, retryable: true, reason: "transaction_failed" };
    }
}

/**
 * Mark a reservation DISPATCHED (parcel physically leaving): stock can no longer
 * be auto-released — only a verified return restores it. Called by fulfillment
 * once pickup is confirmed / the courier reports dispatch.
 */
export async function markDispatched(orderId) {
    const res = await Order.updateOne(
        { _id: orderId, "reservation.state": "held" },
        { $set: { "reservation.state": "return_pending" } }
    );
    return res.modifiedCount === 1;
}

/**
 * VERIFIED PHYSICAL RETURN restores eligible stock EXACTLY ONCE, without
 * reactivating the original order. Works for previously cancelled/dispatched
 * shipments. This is what the old code wrongly forced by resetting
 * resourcesReleased in memory.
 * @returns {boolean} true if this call performed the one-time restoration.
 */
export async function confirmPhysicalReturn(orderId, { description = "Physical return confirmed" } = {}) {
    try {
        return await withTransaction(async (session) => {
            const order = await Order.findOne({ _id: orderId, "reservation.state": "return_pending" }).session(session);
            if (!order) return false;

            // Atomic exactly-once claim on the return marker.
            const claimed = await Order.findOneAndUpdate(
                { _id: orderId, "reservation.state": "return_pending", "returnInfo.stockRestored": { $ne: true } },
                { $set: { "returnInfo.status": "confirmed", "returnInfo.confirmedAt": new Date(), "returnInfo.stockRestored": true, "reservation.state": "return_restored", "reservation.releasedAt": new Date(), resourcesReleased: true, resourcesReleasedAt: new Date() }, $push: { timeline: { status: "Returned — Stock Restored", description, date: new Date() } } },
                { new: true, session }
            );
            if (!claimed) return false;

            const increments = (claimed.items || [])
                .filter((it) => it.productId)
                .map((it) => ({ updateOne: { filter: { _id: it.productId }, update: { $inc: { stock: it.quantity } } } }));
            if (increments.length) await Product.bulkWrite(increments, { session });

            // The coupon claim of THIS order is also handed back once.
            if (claimed.pricing?.couponCode) {
                const coupon = await Coupon.findOne({ code: claimed.pricing.couponCode }).session(session);
                if (coupon) {
                    const idx = coupon.usedBy.findIndex((uid) => uid.toString() === claimed.user?.toString());
                    if (idx !== -1) coupon.usedBy.splice(idx, 1);
                    coupon.usedCount = clampNonNeg(coupon.usedCount - 1);
                    await coupon.save({ session });
                }
            }
            return true;
        });
    } catch (err) {
        console.error(`[Lifecycle] confirmPhysicalReturn failed for ${orderId}:`, err.message);
        return false;
    }
}

// ===========================================================================
// 3. CANCELLATION STATE (intent ≠ courier proof ≠ refund/restock)
// ===========================================================================

export async function requestCancellation(orderId, { reason = "Order cancelled" } = {}) {
    const claimed = await Order.findOneAndUpdate(
        { _id: orderId, "cancellation.status": { $in: ["none", null] } },
        { $set: { "cancellation.status": "requested", "cancellation.requestedAt": new Date(), "cancellation.reason": reason }, $push: { timeline: { status: "Cancellation Requested", description: reason, date: new Date() } } },
        { new: true }
    );
    return claimed; // null → already requested/completed (idempotent)
}

/** Record the courier cancel OUTCOME separately from the intent. */
export async function recordCourierOutcome(orderId, outcome /* confirmed|uncertain|failed|not_needed */) {
    await Order.updateOne(
        { _id: orderId, "cancellation.status": "requested" },
        { $set: { "cancellation.courierOutcome": outcome } }
    );
}

export async function completeCancellation(orderId) {
    const res = await Order.findOneAndUpdate(
        { _id: orderId, "cancellation.status": "requested" },
        { $set: { "cancellation.status": "completed", "cancellation.resolvedAt": new Date(), status: "cancelled" }, new: true }
    );
    return res;
}

// ===========================================================================
// 4. REFUND STATE — CLAIMED before any external call, reconciled afterward
// ===========================================================================

/**
 * Atomically CLAIM the intent to refund the still-refundable captured amount.
 * Only one concurrent admin/cancel action wins the lease. Returns the refundable
 * paise + a claim token, or null when not claimable (nothing captured, already
 * fully refunded, or another action holds the lease).
 */
export async function claimRefundIntent(orderId, { leaseOwner = WORKER_ID, leaseMs = 30000 } = {}) {
    const order = await Order.findById(orderId);
    if (!order || order.payment?.status !== "paid" || !order.payment.razorpayPaymentId) return null;

    const captured = order.payment.amountPaid > 0 ? order.payment.amountPaid : Math.round(Number(order.pricing.total) * 100);
    const refundable = captured - clampNonNeg(order.payment.refundedAmount);
    if (refundable <= 0) return null;

    const now = new Date();
    // Claim only when there is no live pending/processed refund and no unexpired lease.
    const claimed = await Order.findOneAndUpdate(
        {
            _id: orderId,
            "payment.status": "paid",
            $or: [{ "refund.status": null }, { "refund.status": "failed" }, { "refund.status": "unknown" }, { "refund.leaseExpiresAt": { $lt: now } }],
        },
        {
            $set: {
                "refund.status": "requested",
                "refund.requestedAmountPaise": refundable,
                "refund.leaseOwner": leaseOwner,
                "refund.leaseExpiresAt": new Date(now.getTime() + leaseMs),
                "refund.nextAttemptAt": now,
                "refund.attempts": (order.refund?.attempts || 0) + 1,
            },
        },
        { new: true }
    );
    if (!claimed) return null;
    return { order: claimed, refundablePaise: refundable };
}

/** Persist the gateway refund id after a SUCCESSFUL initiation call. */
export async function recordRefundInitiation(orderId, { refundId, gatewayStatus, amountPaise, leaseOwner = WORKER_ID }) {
    const set = {
        "refund.razorpayRefundId": refundId,
        "refund.amountPaise": amountPaise,
        "refund.status": gatewayStatus === "processed" ? "processed" : gatewayStatus === "failed" ? "failed" : "pending",
        "refund.initiatedAt": new Date(),
    };
    if (set["refund.status"] === "processed") set["refund.verifiedAt"] = new Date();
    const res = await Order.updateOne(
        { _id: orderId, "refund.leaseOwner": leaseOwner, "refund.status": "requested" },
        { $set: set, $push: { timeline: { status: "Refund " + set["refund.status"], description: `Refund ${refundId} → ${gatewayStatus}`, date: new Date() } } }
    );
    return res.modifiedCount === 1;
}

/**
 * Move a refund to a gateway-verified state and apply local accounting.
 *
 * The finalization marker, the refunded total, the payment status and the
 * timeline entry commit in ONE transaction — so a crash between "marked
 * finalized" and "money applied" can never strand a processed refund whose
 * totals were lost. Re-checks `finalized !== true` inside the conditional
 * update, so duplicate provider events / reconciliation passes are harmless
 * (exactly-once accounting).
 *
 * @param {Object} opts providerStatus MUST be the gateway-verified status
 *   ("processed" | "failed"). pending/unknown returns false and leaves the row
 *   for periodic reconciliation — it is NEVER treated as final.
 */
export async function finalizeRefundState(orderId, { providerStatus, leaseOwner = WORKER_ID } = {}) {
    if (providerStatus === "processed") {
        return withTransaction(async (session) => {
            // Read the authoritative refund/payment figures inside the txn.
            const order = await Order.findOne(
                {
                    _id: orderId,
                    "refund.razorpayRefundId": { $exists: true, $ne: null },
                    "refund.finalized": { $ne: true },
                },
                { session }
            );
            if (!order) return false;

            const refundAmount = clampNonNeg(order.refund.amountPaise || order.refund.requestedAmountPaise || 0);
            const captured = order.payment.amountPaid > 0 ? order.payment.amountPaid : Math.round(Number(order.pricing.total) * 100);
            const applied = clampNonNeg(order.payment.refundedAmount) + refundAmount;

            const set = {
                "refund.status": "processed",
                "refund.verifiedAt": new Date(),
                "refund.finalized": true,
                "refund.leaseOwner": null,
                "refund.leaseExpiresAt": null,
                "payment.refundedAmount": applied,
            };
            if (applied >= captured) set["payment.status"] = "refunded";

            // Conditional re-check of the marker makes this exactly-once even
            // under a concurrent duplicate finalize.
            const res = await Order.updateOne(
                { _id: orderId, "refund.finalized": { $ne: true } },
                {
                    $set: set,
                    $push: { timeline: { status: "Refund Completed", description: `Gateway confirmed refund processed (${order.refund.razorpayRefundId}).`, date: new Date() } },
                },
                { session }
            );
            return res.modifiedCount === 1;
        });
    }
    if (providerStatus === "failed") {
        // A failed refund is not final accounting — keep the row retryable from
        // admin; only clear OUR lease, never another worker's newer attempt.
        const res = await Order.updateOne(
            { _id: orderId, "refund.leaseOwner": leaseOwner, "refund.finalized": { $ne: true } },
            { $set: { "refund.status": "failed", "refund.leaseOwner": null, "refund.leaseExpiresAt": null }, $push: { timeline: { status: "Refund Failed", description: "Gateway reported the refund failed — retry from admin.", date: new Date() } } }
        );
        return res.modifiedCount === 1;
    }
    return false; // pending/unknown — leave for periodic reconciliation
}

/**
 * Adopt a refund that already exists at the gateway but was lost locally (an
 * initiation that timed out). The gateway status is passed THROUGH to
 * finalization so a processed orphan actually updates the totals — the previous
 * bug called finalizeRefundState with no providerStatus, so nothing ever applied.
 */
export async function adoptGatewayRefund(orderId, { refundId, amountPaise, gatewayStatus, currency, paymentId, createdAt }) {
    const set = {
        "refund.razorpayRefundId": refundId,
        "refund.amountPaise": amountPaise,
        "refund.status": gatewayStatus === "processed" ? "processed" : gatewayStatus === "failed" ? "failed" : "pending",
        "refund.initiatedAt": createdAt ? new Date(createdAt * 1000) : new Date(),
        "refund.leaseOwner": null,
        "refund.leaseExpiresAt": null,
    };
    // Bind adoption to the specific payment when we know it — never adopt an
    // unrelated earlier refund. This guard is advisory (recovery re-verifies).
    const filter = { _id: orderId, "refund.finalized": { $ne: true } };
    if (paymentId) filter["payment.razorpayPaymentId"] = paymentId;
    await Order.updateOne(filter, { $set: set, $push: { timeline: { status: "Refund Reconciled", description: `Recovered gateway refund ${refundId} after an uncertain initiation.`, date: new Date() } } });
    // Finalize from the ACTUAL gateway status. processed-but-unfinalized rows
    // are also picked up by the sweeper if this call crashes first.
    if (gatewayStatus === "processed") await finalizeRefundState(orderId, { providerStatus: "processed" });
    return set;
}

// ===========================================================================
// EMAIL OUTBOX — enqueue is part of success transitions, delivery is a worker
// ===========================================================================

async function enqueueEmails(order, session) {
    const jobs = [
        { dedupeKey: `confirm:${order._id}`, kind: "order_confirmation", order: order._id },
        { dedupeKey: `admin:${order._id}`, kind: "admin_order_notification", order: order._id },
    ];
    for (const job of jobs) {
        await EmailJob.updateOne({ dedupeKey: job.dedupeKey }, { $setOnInsert: job }, { upsert: true, session });
    }
}

/** Queue a shipping/status update email (idempotent per order+status). */
export async function enqueueShippingEmail(orderId, status) {
    await EmailJob.updateOne(
        { dedupeKey: `ship:${orderId}:${status}` },
        { $setOnInsert: { kind: "shipping_update", order: orderId, statusParam: status, state: "queued", nextAttemptAt: new Date() } },
        { upsert: true }
    ).catch((err) => console.error(`[Lifecycle] shipping email enqueue failed:`, err.message));
}

/**
 * Enqueue the confirmation + admin notification emails for an already-settled
 * order (COD or zero-payable prepaid) that never flows through
 * confirmPaymentCaptured. Idempotent via the EmailJob dedupeKey.
 */
export async function enqueueOrderEmails(orderId) {
    const order = await Order.findById(orderId);
    if (!order) return false;
    await enqueueEmails(order, null);
    return true;
}

/**
 * Mark a settled (COD / zero-payable) order eligible for the fulfillment worker
 * and enqueue its emails — the durable replacements for the old fire-and-forget
 * pushToShiprocket/sendOrderEmails inline calls. Returns nothing; the worker and
 * sweeper drive the actual pipeline.
 */
export async function scheduleFulfillment(orderId) {
    await Order.updateOne(
        { _id: orderId, $or: [{ "fulfillment.stage": null }, { "fulfillment.stage": "none" }, { "fulfillment.stage": { $exists: false } }] },
        { $set: { "fulfillment.stage": "ready", "fulfillment.nextAttemptAt": new Date() } }
    ).catch(() => {});
    await enqueueOrderEmails(orderId);
}

// exponential-ish backoff, capped (~4h max) — bounded, not a fixed short loop.
function backoffDate(attempts = 0) {
    const steps = [1, 5, 15, 60, 240];
    const minutes = steps[Math.min(attempts, steps.length - 1)];
    return new Date(Date.now() + minutes * 60 * 1000);
}
export { backoffDate };

export default {
    WORKER_ID,
    withTransaction,
    confirmPaymentCaptured,
    expirePendingPayment,
    releaseReservation,
    markDispatched,
    confirmPhysicalReturn,
    requestCancellation,
    recordCourierOutcome,
    completeCancellation,
    claimRefundIntent,
    recordRefundInitiation,
    finalizeRefundState,
    adoptGatewayRefund,
    enqueueShippingEmail,
    enqueueOrderEmails,
    scheduleFulfillment,
    backoffDate,
};

