/**
 * Recovery sweeper — an INTERNAL background process, no public API surface.
 *
 * Covers the FULL order lifecycle so money/inventory/fulfillment/notifications
 * settle correctly WITHOUT depending on a browser callback ever firing. Every
 * sweep is bounded (batch limit + indexed queries) and cross-instance SAFE:
 * work is claimed with conditional DB updates (leases / transition guards),
 * never an in-memory flag, so two app instances can never duplicate unsafe
 * work. The in-process `running` flag only avoids overlapping ticks locally.
 *
 * Responsibilities (spec §13):
 *   1. Pending-payment reconciliation — including prepaid orders with NO stored
 *      gateway id. Provider outcome is EXPLICIT (adapter): captured → confirm;
 *      genuinely unpaid → expire-then-release; still-authorized / UNKNOWN →
 *      reservation preserved and retried later, never released on a guess.
 *   2. Retryable inventory-release failures (reservation.retryable + backoff).
 *   3. Durable webhook replay with DB lease claims — unmatched events stay
 *      recoverable, exhausted events go to manual_review (not silently burned).
 *   4. Eligible COD + prepaid fulfillment via the staged fulfillment worker.
 *   5. Pending/unfinalized refund reconciliation + orphan-refund adoption.
 *   6. Failed email delivery via the durable outbox worker.
 *
 * Transactions require a MongoDB replica set; this job assumes the same
 * deployment the checkout transaction already requires.
 */
import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import WebhookEvent from "../models/webhookEventModel.js";
import razorpayInstance from "../config/razorpay.js";
import { __lifecycle } from "../controllers/orderController.js";
import {
    reconcileOrderPayments,
    findPaymentRefunds,
    refundOutcome,
    RZP_OUTCOME,
    REFUND_LIST_OUTCOME,
} from "../services/razorpayProvider.js";
import {
    confirmPaymentCaptured,
    expirePendingPayment,
    releaseReservation,
    finalizeRefundState,
    adoptGatewayRefund,
    backoffDate,
} from "../services/orderLifecycle.js";
import { runFulfillmentSweep } from "../services/fulfillmentWorker.js";
import { runCancellationSweep } from "../services/cancellationWorker.js";
import { runEmailSweep } from "../services/emailWorker.js";
import { runTrackingSweep } from "../services/trackingWorker.js";
import { settleCartAfterPayment } from "../services/cartSettlement.js";
import { findExistingGatewayOrder, GATEWAY_LOOKUP_OUTCOME } from "../services/gatewayOrder.js";

const {
    processWebhookEventDoc,
    RESERVATION_WINDOW_MS,
} = __lifecycle;

const SWEEP_INTERVAL_MS = Number(process.env.SWEEPER_INTERVAL_MS || 5 * 60 * 1000);
const BATCH = Number(process.env.SWEEPER_BATCH || 25);
const CLAIM_LEASE_MS = Number(process.env.SWEEPER_CLAIM_LEASE_MS || 120000);

let running = false;
let timer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Pending-payment reconciliation (explicit provider outcomes)
// ---------------------------------------------------------------------------
async function reconcilePendingPayments() {
    const cutoff = new Date(Date.now() - RESERVATION_WINDOW_MS);

    // (a) Prepaid orders past the window with a gateway id — reconcile at Razorpay.
    const stale = await Order.find({
        "payment.method": { $ne: "cod" },
        "payment.status": "pending",
        "payment.razorpayOrderId": { $exists: true, $ne: null },
        "reservation.state": { $in: ["held", "release_requested"] },
        "fulfillmentHold.active": { $ne: true },
        $or: [{ "payment.expiresAt": { $lte: new Date() } }, { createdAt: { $lte: cutoff } }],
    })
        .sort({ createdAt: 1 })
        .limit(BATCH)
        .select("_id orderId payment pricing reservation fulfillmentHold")
        .lean();

    for (const doc of stale) {
        try {
            const expectedPaise = Math.round(Number(doc.pricing?.total || 0) * 100);
            const rec = await reconcileOrderPayments(razorpayInstance, doc.payment.razorpayOrderId, {
                expectedAmountPaise: expectedPaise,
                expectedCurrency: "INR",
            });

            switch (rec.outcome) {
                case RZP_OUTCOME.CAPTURED_VALID: {
                    // Shared transition service — competes atomically with
                    // verify/webhook; fulfilment+emails persisted with the flip.
                    const claimed = await confirmPaymentCaptured(doc._id, {
                        paymentId: rec.payment.id,
                        amountPaise: rec.payment.amount, // payment entity uses `amount`
                        source: "sweeper-reconciliation",
                    });
                    if (claimed) {
                        console.log(`[Sweeper] Recovered paid order ${doc.orderId} (browser/webhook missed it)`);
                        await settleCartAfterPayment(claimed).catch(() => {});
                    }
                    break;
                }
                case RZP_OUTCOME.IN_PROGRESS:
                    // Authorized but not captured — keep the hold, retry later.
                    await Order.updateOne(
                        { _id: doc._id },
                        { $set: { "payment.expiresAt": backoffDate(2) } } // ~15 min
                    ).catch(() => {});
                    break;
                case RZP_OUTCOME.NO_CAPTURED: {
                    // Conditional — a concurrent capture makes this a no-op.
                    const won = await expirePendingPayment(doc._id);
                    if (won) {
                        const rel = await releaseReservation(doc._id, { reason: "reservation-expired" });
                        if (rel && !rel.released && rel.retryable) {
                            console.warn(`[Sweeper] Release for ${doc.orderId} is retryable — kept as durable work`);
                        } else {
                            console.log(`[Sweeper] Released expired reservation for ${doc.orderId}`);
                        }
                    }
                    break;
                }
                case RZP_OUTCOME.MISMATCH:
                    // Money/expectations disagree — manual review, never auto-confirm.
                    await Order.updateOne(
                        { _id: doc._id },
                        { $set: { "fulfillmentHold.active": true, "fulfillmentHold.reason": `Payment reconciliation mismatch: ${rec.reason}` } }
                    ).catch(() => {});
                    console.error(`[Sweeper] MISMATCH for ${doc.orderId} (${rec.reason}) — held for manual review`);
                    break;
                default:
                    // UNKNOWN (lookup failed / malformed) — NOT proof of absence.
                    // Preserve inventory and retry with backoff on next tick.
                    await Order.updateOne(
                        { _id: doc._id },
                        { $set: { "payment.expiresAt": backoffDate(1) } } // ~5 min
                    ).catch(() => {});
                    break;
            }
        } catch (err) {
            console.error(`[Sweeper] payment reconcile error for ${doc.orderId}:`, err.message);
        }
        await sleep(20);
    }

    // (b) Prepaid orders with NO gateway id at all
    const orphanPending = await Order.find({
        "payment.method": { $ne: "cod" },
        "payment.status": "pending",
        "payment.razorpayOrderId": { $in: [null, undefined, ""] },
        "reservation.state": { $in: ["held", "release_requested"] },
        "fulfillmentHold.active": { $ne: true },
        $or: [
            { "gatewayInit.nextAttemptAt": { $lte: new Date() } },
            { "gatewayInit.nextAttemptAt": { $exists: false } },
            { "gatewayInit.nextAttemptAt": null },
        ],
        createdAt: { $lte: cutoff },
    })
        .sort({ "gatewayInit.nextAttemptAt": 1, createdAt: 1 })
        .limit(BATCH)
        .select("_id orderId pricing gatewayInit createdAt payment")
        .lean();

    for (const doc of orphanPending) {
        try {
            // Check if an external call was ever sent to Razorpay
            if (doc.gatewayInit?.sentExternalCall) {
                // An external order creation was dispatched! Reconcile with Razorpay first
                const lookup = await findExistingGatewayOrder(razorpayInstance, doc);

                if (lookup.outcome === GATEWAY_LOOKUP_OUTCOME.FOUND) {
                    // Gateway order exists! Link it so normal payment reconciliation can evaluate it
                    console.log(`[Sweeper] Reconciled remote gateway order ${lookup.razorpayOrderId} for ${doc.orderId}`);
                    await Order.updateOne(
                        { _id: doc._id, "payment.razorpayOrderId": { $in: [null, undefined, ""] } },
                        {
                            $set: {
                                "payment.razorpayOrderId": lookup.razorpayOrderId,
                                "gatewayInit.status": "ready",
                                "gatewayInit.claimToken": null,
                                "gatewayInit.claimExpiresAt": null,
                                "gatewayInit.nextAttemptAt": null,
                            },
                        }
                    );
                    // Do not expire! Next tick or immediate reconciliation will handle it
                    continue;
                }

                if (lookup.outcome === GATEWAY_LOOKUP_OUTCOME.MISMATCH) {
                    // Mismatch between gateway and local order details: place on fulfillment hold
                    console.error(`[Sweeper] MISMATCH for ${doc.orderId} during orphan reconciliation (${lookup.reason}) — held for review`);
                    await Order.updateOne(
                        { _id: doc._id },
                        {
                            $set: {
                                "gatewayInit.status": "manual_review",
                                "gatewayInit.nextAttemptAt": null,
                                "fulfillmentHold.active": true,
                                "fulfillmentHold.reason": `Gateway order mismatch: ${lookup.reason}`,
                            },
                        }
                    );
                    continue;
                }

                if (lookup.outcome === GATEWAY_LOOKUP_OUTCOME.UNKNOWN) {
                    // Remote status is uncertain (timeout, network, or visibility window): backoff and retry later, do NOT release inventory!
                    const nextAttempt = backoffDate(Math.min((doc.gatewayInit?.attempts || 1), 5));
                    await Order.updateOne(
                        { _id: doc._id },
                        {
                            $set: {
                                "gatewayInit.status": "uncertain",
                                "gatewayInit.nextAttemptAt": nextAttempt,
                            },
                            $inc: { "gatewayInit.attempts": 1 },
                        }
                    );
                    console.warn(`[Sweeper] Unresolved gateway state for ${doc.orderId}; preserved reservation, retry at ${nextAttempt.toISOString()}`);
                    continue;
                }

                // If outcome === CONFIRMED_ABSENT, external creation definitively never existed or was abandoned
            }

            // Genuine abandoned attempt with no external creation: conditionally expire & release
            const won = await expirePendingPayment(doc._id);
            if (won) {
                await releaseReservation(doc._id, { reason: "no-gateway-order-expired" });
                console.log(`[Sweeper] Expired gateway-less pending order ${doc.orderId}`);
            }
        } catch (err) {
            console.error(`[Sweeper] orphan-pending error for ${doc.orderId}:`, err.message);
        }
    }
}

// ---------------------------------------------------------------------------
// 2. Retryable inventory-release failures
// ---------------------------------------------------------------------------
async function retryFailedReleases() {
    const due = await Order.find({
        "reservation.state": "release_requested",
        "reservation.retryable": true,
        $or: [{ "reservation.nextAttemptAt": { $exists: false } }, { "reservation.nextAttemptAt": { $lte: new Date() } }],
    })
        .sort({ "reservation.nextAttemptAt": 1 })
        .limit(BATCH)
        .select("_id orderId")
        .lean();

    for (const doc of due) {
        try {
            const res = await releaseReservation(doc._id, { reason: "retry-release" });
            if (res?.released) console.log(`[Sweeper] Completed retryable release for ${doc.orderId}`);
        } catch (err) {
            console.error(`[Sweeper] release retry error for ${doc.orderId}:`, err.message);
        }
    }
}

// ---------------------------------------------------------------------------
// 2b. Expired-but-unreleased cleanup. If the expiry worker flipped payment to
// `failed` but crashed before the release, the order sits held + failed and is
// invisible to the pending-payment query (which requires `pending`). This makes
// "a crash after expiry" leave discoverable, retryable work (spec §3).
// ---------------------------------------------------------------------------
async function reconcileExpiredUnreleased() {
    const due = await Order.find({
        "payment.method": { $ne: "cod" },
        "payment.status": "failed",
        $or: [{ "reservation.state": "held" }, { "reservation.state": { $exists: false } }, { "reservation.state": null }],
        "fulfillmentHold.active": { $ne: true },
    })
        .sort({ "payment.expiresAt": 1, createdAt: 1 })
        .limit(BATCH)
        .select("_id orderId")
        .lean();

    for (const doc of due) {
        try {
            const rel = await releaseReservation(doc._id, { reason: "expired-unreleased" });
            if (rel?.released) console.log(`[Sweeper] Completed expired release for ${doc.orderId}`);
            else if (rel?.reason === "paid_keep_hold") console.log(`[Sweeper] ${doc.orderId} expired-release skipped (now paid / active)`);
        } catch (err) {
            console.error(`[Sweeper] expired-unreleased error for ${doc.orderId}:`, err.message);
        }
    }
}

// ---------------------------------------------------------------------------
// 3. Webhook replay with DB lease claims (cross-instance safe)
// ---------------------------------------------------------------------------
async function replayWebhookEvents() {
    const claimedDocs = [];
    for (let i = 0; i < BATCH; i++) {
        const doc = await WebhookEvent.findOneAndUpdate(
            {
                $or: [
                    { state: { $in: ["pending", "unmatched"] } },
                    { state: "in_flight", leaseExpiresAt: { $lt: new Date() } },
                ],
                $expr: { $gt: ["$maxRetries", "$retries"] },
                nextAttemptAt: { $lte: new Date() },
            },
            {
                $set: { state: "in_flight", leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS) },
                $inc: { retries: 1 },
            },
            { new: true }
        );
        if (!doc) break;
        claimedDocs.push(doc);
    }

    for (const doc of claimedDocs) {
        try {
            await processWebhookEventDoc(doc);
        } catch (err) {
            // Processing threw — make it retryable again with backoff. After
            // maxRetries the query above naturally stops claiming it; move it
            // to manual_review so it is visible instead of silently looping.
            const willExhaust = doc.retries >= doc.maxRetries;
            await WebhookEvent.updateOne(
                { _id: doc._id },
                {
                    $set: {
                        state: willExhaust ? "manual_review" : "pending",
                        lastError: String(err.message || err).slice(0, 500),
                        nextAttemptAt: backoffDate(doc.retries),
                        leaseExpiresAt: null,
                    },
                }
            ).catch(() => {});
            console.error(`[Sweeper] webhook replay error (${doc.eventId}):`, err.message);
        }
        await sleep(20);
    }
}

// ---------------------------------------------------------------------------
// 4 + 6. Fulfillment (COD + prepaid) and email outbox — workers own their
// claims; the sweeps are lease-guarded internally so multi-instance is safe.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. Refund reconciliation — pending/unfinalized refund states
// ---------------------------------------------------------------------------
async function reconcileRefunds() {
    const now = new Date();
    // Includes "processed" so a refund the gateway confirmed but local
    // finalization crashed before applying totals is still recovered (the
    // `finalized: { $ne: true }` guard keeps it exactly-once).
    const due = await Order.find({
        "refund.status": { $in: ["requested", "pending", "unknown", "processed"] },
        "refund.finalized": { $ne: true },
        $or: [
            { "refund.leaseExpiresAt": { $exists: false } },
            { "refund.leaseExpiresAt": null },
            { "refund.leaseExpiresAt": { $lt: now } },
            { "refund.nextAttemptAt": { $lte: now } },
        ],
    })
        .sort({ "refund.nextAttemptAt": 1 })
        .limit(BATCH)
        .select("_id orderId payment refund")
        .lean();

    for (const doc of due) {
        try {
            if (!razorpayInstance) continue;
            if (doc.refund.razorpayRefundId) {
                // We know the refund — fetch its true gateway state.
                const fresh = await razorpayInstance.refunds.fetch(doc.refund.razorpayRefundId);
                const gw = refundOutcome(fresh);
                if (gw === "processed" || gw === "failed") {
                    await finalizeRefundState(doc._id, { providerStatus: gw });
                    console.log(`[Sweeper] Refund ${doc.refund.razorpayRefundId} finalized as ${gw} for ${doc.orderId}`);
                } else {
                    // Still pending / unrecognized — schedule the next look.
                    await Order.updateOne(
                        { _id: doc._id },
                        { $set: { "refund.nextAttemptAt": backoffDate(doc.refund.attempts || 1) } }
                    ).catch(() => {});
                }
            } else if (doc.payment?.razorpayPaymentId) {
                // Initiation response was lost — check the payment for refunds
                // we already created (items[] shape via the provider adapter)
                // and ADOPT one rather than re-issuing (never double-refund).
                const res = await findPaymentRefunds(razorpayInstance, doc.payment.razorpayPaymentId);
                if (res.outcome === REFUND_LIST_OUTCOME.FOUND) {
                    const newest = res.refunds
                        .filter((r) => ["processed", "pending", "written_out", "failed"].includes(r.status))
                        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
                    if (newest) {
                        await adoptGatewayRefund(doc._id, {
                            refundId: newest.id,
                            amountPaise: newest.amount,
                            gatewayStatus: refundOutcome(newest),
                            createdAt: newest.created_at,
                        });
                        console.log(`[Sweeper] Adopted orphan refund ${newest.id} for ${doc.orderId}`);
                    }
                }
                // NONE / UNKNOWN → leave the durable intent; retry next tick with backoff.
                if (res.outcome !== REFUND_LIST_OUTCOME.FOUND) {
                    await Order.updateOne(
                        { _id: doc._id },
                        { $set: { "refund.nextAttemptAt": backoffDate(doc.refund.attempts || 1) } }
                    ).catch(() => {});
                }
            }
        } catch (err) {
            // Provider error is NOT proof of absence — schedule another look.
            await Order.updateOne(
                { _id: doc._id },
                { $set: { "refund.nextAttemptAt": backoffDate(doc.refund?.attempts || 1), "refund.lastError": String(err.message || err).slice(0, 500) } }
            ).catch(() => {});
            console.error(`[Sweeper] refund reconcile error for ${doc.orderId}:`, err.message);
        }
        await sleep(20);
    }
}

async function reconcileUnsettledPaidCarts() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7-day conservative limit

    // Mark legacy orders older than 7 days as settled without touching current user cart
    await Order.updateMany(
        {
            "payment.status": "paid",
            createdAt: { $lt: cutoff },
            $or: [{ cartSettled: false }, { cartSettled: { $exists: false } }],
        },
        { $set: { cartSettled: true, cartSettledAt: new Date() } }
    ).catch(() => {});

    const unsettled = await Order.find({
        "payment.status": "paid",
        createdAt: { $gte: cutoff },
        $or: [{ cartSettled: false }, { cartSettled: { $exists: false } }],
    })
        .limit(BATCH)
        .select("_id orderId user isGuest cartSettled items createdAt")
        .lean();

    for (const doc of unsettled) {
        try {
            await settleCartAfterPayment(doc, { caller: "sweeper" });
        } catch (e) {
            console.error(`[Sweeper] Cart settle recovery failed for ${doc.orderId}:`, e.message);
        }
    }
}

// ---------------------------------------------------------------------------
// Single guarded tick — never allows overlapping runs IN THIS PROCESS; every
// sweep above is also claim-safe ACROSS processes.
// Isolated error boundaries ensure email delivery or payment recovery are NEVER
// blocked by an earlier step failing.
// ---------------------------------------------------------------------------
async function runSweepOnce() {
    if (running) return;
    if (mongoose.connection.readyState !== 1) return; // DB not ready
    running = true;
    try {
        try { await reconcilePendingPayments(); } catch (e) { console.error("[Sweeper] reconcilePendingPayments error:", e.message); }
        try { await reconcileExpiredUnreleased(); } catch (e) { console.error("[Sweeper] reconcileExpiredUnreleased error:", e.message); }
        try { await retryFailedReleases(); } catch (e) { console.error("[Sweeper] retryFailedReleases error:", e.message); }
        try { await replayWebhookEvents(); } catch (e) { console.error("[Sweeper] replayWebhookEvents error:", e.message); }
        try { await reconcileUnsettledPaidCarts(); } catch (e) { console.error("[Sweeper] reconcileUnsettledPaidCarts error:", e.message); }
        try { await runFulfillmentSweep(BATCH); } catch (e) { console.error("[Sweeper] runFulfillmentSweep error:", e.message); }
        try { await runCancellationSweep(BATCH); } catch (e) { console.error("[Sweeper] runCancellationSweep error:", e.message); }
        try { await reconcileRefunds(); } catch (e) { console.error("[Sweeper] reconcileRefunds error:", e.message); }
        try { await runEmailSweep(BATCH); } catch (e) { console.error("[Sweeper] runEmailSweep error:", e.message); }
        try { await runTrackingSweep(BATCH); } catch (e) { console.error("[Sweeper] runTrackingSweep error:", e.message); }
    } catch (err) {
        console.error("[Sweeper] tick error:", err.message);
    } finally {
        running = false;
    }
}

export function startReservationSweeper() {
    if (timer || process.env.SWEEPER_DISABLED === "true") return;
    if (!razorpayInstance) {
        console.warn("[Sweeper] Razorpay not configured — payment/refund reconciliation will be limited");
    }
    console.log(
        `[Sweeper] Lifecycle recovery sweeper enabled (every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s, window ${Math.round(RESERVATION_WINDOW_MS / 60000)}m, batch ${BATCH})`
    );
    // Fire once shortly after boot, then on the interval. unref() keeps the
    // timer from blocking a graceful shutdown / test exit.
    const kickoff = setTimeout(() => { runSweepOnce(); }, 15 * 1000);
    if (kickoff.unref) kickoff.unref();
    timer = setInterval(() => { runSweepOnce(); }, SWEEP_INTERVAL_MS);
    if (timer.unref) timer.unref();
}

export function stopReservationSweeper() {
    if (timer) { clearInterval(timer); timer = null; }
}

// Exported for tests / manual admin triggering without a public route.
export { runSweepOnce };
