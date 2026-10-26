/**
 * DURABLE EMAIL OUTBOX WORKER
 * ---------------------------------------------------------------------------
 * Transactional email is decoupled from the payment/shipping success path: the
 * success transition only ENQUEUES an EmailJob (atomically, in orderLifecycle or checkout transaction),
 * and this worker owns delivery. A process restart can never lose a
 * notification, and an SMTP failure produces BOUNDED retries with backoff plus
 * an explicit manual_review/failed_permanent state — not a silently dropped
 * message. We do NOT promise exactly-once external delivery; the per-job lease
 * makes concurrent instances safe and dedupeKey makes re-enqueue idempotent.
 */
import crypto from "crypto";
import EmailJob from "../models/emailJobModel.js";
import Order from "../models/orderModal.js";
import emailService from "./emailService.js";
import invoiceService from "./invoiceService.js";
import { WORKER_ID } from "./orderLifecycle.js";

const LEASE_MS = Number(process.env.EMAIL_LEASE_MS || 60000);

export const backoff = (attempts) => {
    const steps = [1, 5, 15, 60, 240]; // minutes, capped
    return new Date(Date.now() + steps[Math.min(attempts, steps.length - 1)] * 60000);
};

/**
 * Claim single due job with lease fencing and unique per-claim token
 */
export async function claimJob(workerId = WORKER_ID) {
    const now = new Date();
    const claimToken = crypto.randomUUID();
    return EmailJob.findOneAndUpdate(
        {
            state: "queued",
            nextAttemptAt: { $lte: now },
            $or: [
                { leaseExpiresAt: null },
                { leaseExpiresAt: { $exists: false } },
                { leaseExpiresAt: { $lt: now } },
            ],
        },
        {
            $set: {
                state: "in_flight",
                leaseOwner: workerId,
                claimToken,
                leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
                nextAttemptAt: new Date(now.getTime() + LEASE_MS),
            },
            $inc: { attempts: 1 },
        },
        { new: true, sort: { nextAttemptAt: 1 } }
    );
}

/**
 * Extend lease for long-running email send (e.g. slow PDF generation / SMTP timeout)
 * Requires current unexpired lease and matching claimToken.
 */
export async function renewLease(jobId, claimToken, workerId = WORKER_ID) {
    const now = new Date();
    const filter = {
        _id: jobId,
        state: "in_flight",
        leaseExpiresAt: { $gt: now },
    };
    if (claimToken) filter.claimToken = claimToken;
    if (workerId) filter.leaseOwner = workerId;

    const res = await EmailJob.updateOne(
        filter,
        { $set: { leaseExpiresAt: new Date(now.getTime() + LEASE_MS) } }
    );
    return res.modifiedCount === 1;
}

export async function deliver(job) {
    const order = await Order.findById(job.order);
    if (!order) {
        // Order deleted or invalid reference — permanently unresolvable.
        await EmailJob.updateOne(
            { _id: job._id, claimToken: job.claimToken, state: "in_flight" },
            {
                $set: {
                    state: "failed_permanent",
                    lastError: "order_not_found",
                    leaseOwner: null,
                    claimToken: null,
                    leaseExpiresAt: null,
                    nextAttemptAt: null,
                },
            }
        );
        return;
    }

    let ownershipLost = false;
    // Bounded periodic heartbeat renewal during delivery (every 10s or half the lease)
    const heartbeatIntervalMs = Math.max(5000, Math.min(15000, Math.floor(LEASE_MS / 2)));
    const heartbeatTimer = setInterval(async () => {
        try {
            const renewed = await renewLease(job._id, job.claimToken, job.leaseOwner);
            if (!renewed) {
                ownershipLost = true;
                console.warn(`[EmailWorker] Heartbeat renewal failed for job ${job._id}: lease ownership lost or expired.`);
            }
        } catch (e) {
            console.error(`[EmailWorker] Heartbeat error for job ${job._id}:`, e.message);
        }
    }, heartbeatIntervalMs);

    try {
        // Pre-send lease verification: ensure this worker still owns the in-flight job with active unexpired lease
        const now = new Date();
        const stillOwned = await EmailJob.findOne({
            _id: job._id,
            claimToken: job.claimToken,
            state: "in_flight",
            leaseExpiresAt: { $gt: now },
        });
        if (!stillOwned || ownershipLost) {
            console.warn(`[EmailWorker] Aborting delivery for job ${job._id}: lease ownership was lost or expired.`);
            return;
        }

        let result;
        if (job.kind === "order_confirmation") {
            let pdf = null;
            try {
                pdf = await invoiceService.generateInvoicePDF(order);
            } catch (pdfErr) {
                console.warn(`[EmailWorker] Invoice PDF generation failed for order ${order.orderId}, sending without attachment:`, pdfErr.message);
            }

            if (ownershipLost) {
                console.warn(`[EmailWorker] Ownership lost after PDF generation for job ${job._id}. Halting before SMTP send.`);
                return;
            }

            // Renew lease immediately before sending
            const renewed = await renewLease(job._id, job.claimToken, job.leaseOwner);
            if (!renewed) {
                console.warn(`[EmailWorker] Pre-SMTP renewal failed for job ${job._id}. Halting send.`);
                return;
            }

            result = await emailService.sendOrderConfirmationEmail(order, pdf);
        } else if (job.kind === "admin_order_notification") {
            if (ownershipLost) return;
            result = await emailService.sendAdminOrderNotificationEmail(order);
        } else if (job.kind === "shipping_update") {
            if (ownershipLost) return;
            result = await emailService.sendShippingUpdateEmail(order, job.statusParam || order.status);
        } else {
            throw new Error(`unknown_email_kind:${job.kind}`);
        }

        const finalState = result?.status === "skipped" ? "skipped" : "sent";
        const updateRes = await EmailJob.updateOne(
            { _id: job._id, claimToken: job.claimToken, state: "in_flight" },
            {
                $set: {
                    state: finalState,
                    sentAt: finalState === "sent" ? new Date() : null,
                    lastError: result?.status === "skipped" ? `skipped:${result.reason || ""}` : null,
                    leaseOwner: null,
                    claimToken: null,
                    leaseExpiresAt: null,
                    nextAttemptAt: null,
                },
            }
        );

        if (updateRes.modifiedCount === 0) {
            // SMTP message was accepted by the provider, but worker's lease expired and another worker may have claimed the job.
            // Note: Fencing cannot retract an email already transmitted through SMTP relay.
            console.warn(`[EmailWorker] Job ${job._id} delivery succeeded with SMTP but lease was lost before completion commit.`);
        }
    } catch (err) {
        const permanent = !!err?.permanent;
        const exhausted = !permanent && job.attempts >= (job.maxAttempts || 6);
        const nextState = permanent ? "failed_permanent" : exhausted ? "manual_review" : "queued";

        await EmailJob.updateOne(
            { _id: job._id, claimToken: job.claimToken, state: "in_flight" },
            {
                $set: {
                    state: nextState,
                    lastError: String(err.message || err).slice(0, 400),
                    leaseOwner: null,
                    claimToken: null,
                    leaseExpiresAt: null,
                    nextAttemptAt: permanent || exhausted ? null : backoff(job.attempts),
                },
            }
        );
        console.error(`[EmailWorker] ${job.kind} for order ${job.order} attempt ${job.attempts} → ${nextState}:`, err.message);
    } finally {
        clearInterval(heartbeatTimer);
    }
}

/**
 * Reclaim stale in-flight jobs where the worker crashed or timed out.
 */
export async function reclaimStaleJobs() {
    const now = new Date();
    const res = await EmailJob.updateMany(
        { state: "in_flight", leaseExpiresAt: { $lt: now } },
        {
            $set: {
                state: "queued",
                leaseOwner: null,
                claimToken: null,
                leaseExpiresAt: null,
                nextAttemptAt: now,
            },
        }
    ).catch((e) => {
        console.error("[EmailWorker] Error reclaiming stale jobs:", e.message);
    });
    return res;
}

/**
 * Process up to `maxJobs` due email jobs in an isolated bounded sweep.
 */
export async function runEmailSweep(maxJobs = 20) {
    try {
        await reclaimStaleJobs();

        let done = 0;
        for (let i = 0; i < maxJobs; i++) {
            const job = await claimJob();
            if (!job) break;
            await deliver(job);
            done++;
        }
        return { processed: done };
    } catch (err) {
        console.error("[EmailWorker] Sweep error:", err.message);
        return { processed: 0, error: err.message };
    }
}

/**
 * Narrowly scoped recovery for configuration-related failed_permanent jobs after configuration is corrected.
 * Does NOT resend successful jobs or reset all failures indiscriminately.
 *
 * NOTE ON SMTP DELIVERY:
 * transporter.sendMail verifies acceptance of the message by the configured SMTP relay server
 * (e.g. Gmail SMTP or custom MTA). It confirms relay transmission, not guaranteed delivery to the
 * recipient's personal inbox (downstream spam classification and mailbox availability occur post-relay).
 */
export async function retryConfigFailedEmailJobs() {
    const isConfigValid = await emailService.verifyEmailConfig();
    if (!isConfigValid) {
        console.warn("[EmailWorker] Cannot retry config-failed jobs: SMTP configuration is still invalid.");
        return { success: false, reason: "smtp_config_invalid", resetCount: 0 };
    }

    const now = new Date();
    const result = await EmailJob.updateMany(
        {
            state: "failed_permanent",
            lastError: { $regex: /EMAIL_USER|EMAIL_PASS|not configured|EAUTH|authentication failed|credentials/i },
        },
        {
            $set: {
                state: "queued",
                nextAttemptAt: now,
                leaseOwner: null,
                leaseExpiresAt: null,
                attempts: 0,
            },
        }
    );

    console.log(`[EmailWorker] Reset ${result.modifiedCount} config-failed email jobs for delivery after configuration correction.`);
    return { success: true, resetCount: result.modifiedCount };
}

/**
 * Controlled retry of failed email jobs.
 * Does NOT reset or resend already sent or skipped jobs.
 */
export async function retryFailedEmailJobs({ maxRetries = 6, resetManualReview = true } = {}) {
    const targetStates = ["queued"];
    if (resetManualReview) targetStates.push("manual_review");

    const now = new Date();
    const result = await EmailJob.updateMany(
        {
            state: { $in: targetStates },
            attempts: { $lte: maxRetries },
        },
        {
            $set: {
                state: "queued",
                nextAttemptAt: now,
                leaseOwner: null,
                leaseExpiresAt: null,
            },
        }
    );

    console.log(`[EmailWorker] Reset ${result.modifiedCount} eligible email jobs for retry`);
    return result;
}

export default {
    claimJob,
    renewLease,
    deliver,
    runEmailSweep,
    reclaimStaleJobs,
    retryConfigFailedEmailJobs,
    retryFailedEmailJobs,
};
