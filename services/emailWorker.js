/**
 * DURABLE EMAIL OUTBOX WORKER
 * ---------------------------------------------------------------------------
 * Transactional email is decoupled from the payment/shipping success path: the
 * success transition only ENQUEUES an EmailJob (atomically, in orderLifecycle),
 * and this worker owns delivery. A process restart can never lose a
 * notification, and an SMTP failure produces BOUNDED retries with backoff plus
 * an explicit manual_review/failed_permanent state — not a silently dropped
 * message. We do NOT promise exactly-once external delivery; the per-job lease
 * makes concurrent instances safe and dedupeKey makes re-enqueue idempotent.
 */
import EmailJob from "../models/emailJobModel.js";
import Order from "../models/orderModal.js";
import emailService from "./emailService.js";
import invoiceService from "./invoiceService.js";
import { WORKER_ID } from "./orderLifecycle.js";

const LEASE_MS = Number(process.env.EMAIL_LEASE_MS || 60000);

const backoff = (attempts) => {
    const steps = [1, 5, 15, 60, 240]; // minutes, capped
    return new Date(Date.now() + steps[Math.min(attempts, steps.length - 1)] * 60000);
};

async function claimJob(workerId = WORKER_ID) {
    const now = new Date();
    // Grab the single earliest-due runnable job and take a lease atomically.
    return EmailJob.findOneAndUpdate(
        {
            state: { $in: ["queued"] },
            nextAttemptAt: { $lte: now },
            $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $exists: false } }, { leaseExpiresAt: { $lt: now } }],
        },
        {
            $set: { state: "in_flight", leaseOwner: workerId, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
            $inc: { attempts: 1 },
        },
        { new: true, sort: { nextAttemptAt: 1 } }
    );
}

async function deliver(job) {
    const order = await Order.findById(job.order);
    if (!order) {
        // Order gone — permanently unresolvable.
        await EmailJob.updateOne({ _id: job._id, leaseOwner: job.leaseOwner }, { $set: { state: "failed_permanent", lastError: "order_not_found", leaseOwner: null, leaseExpiresAt: null } });
        return;
    }
    try {
        let result;
        if (job.kind === "order_confirmation") {
            let pdf = null;
            try { pdf = await invoiceService.generateInvoicePDF(order); } catch (e) { /* send without invoice */ }
            result = await emailService.sendOrderConfirmationEmail(order, pdf);
        } else if (job.kind === "admin_order_notification") {
            result = await emailService.sendAdminOrderNotificationEmail(order);
        } else if (job.kind === "shipping_update") {
            result = await emailService.sendShippingUpdateEmail(order, job.statusParam || order.status);
        } else {
            throw new Error(`unknown_email_kind:${job.kind}`);
        }

        // A delivery is only "sent" on CONFIRMED transport acceptance. An
        // explicit skip (e.g. a status with no customer email) is terminal but
        // recorded as "skipped" — never silently reported as delivered.
        const finalState = result?.status === "skipped" ? "skipped" : "sent";
        await EmailJob.updateOne(
            { _id: job._id, leaseOwner: job.leaseOwner, state: "in_flight" },
            {
                $set: {
                    state: finalState,
                    sentAt: finalState === "sent" ? new Date() : null,
                    lastError: result?.status === "skipped" ? `skipped:${result.reason || ""}` : null,
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    nextAttemptAt: null,
                },
            }
        );
    } catch (err) {
        // A permanent failure (misconfiguration / unresolvable) never retries;
        // anything else is a transient transport error → bounded backoff.
        const permanent = !!err?.permanent;
        const exhausted = !permanent && job.attempts >= (job.maxAttempts || 6);
        const nextState = permanent ? "failed_permanent" : exhausted ? "manual_review" : "queued";
        await EmailJob.updateOne(
            { _id: job._id, leaseOwner: job.leaseOwner, state: "in_flight" },
            {
                $set: {
                    state: nextState,
                    lastError: String(err.message || err).slice(0, 400),
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    nextAttemptAt: permanent || exhausted ? null : backoff(job.attempts),
                },
            }
        );
        console.error(`[EmailWorker] ${job.kind} for order ${job.order} attempt ${job.attempts} → ${nextState}:`, err.message);
    }
}

/** Process up to `maxJobs` due email jobs. Expired in_flight leases are reclaimed. */
export async function runEmailSweep(maxJobs = 20) {
    // Reclaim crashed in-flight jobs whose lease has expired.
    await EmailJob.updateMany(
        { state: "in_flight", leaseExpiresAt: { $lt: new Date() } },
        { $set: { state: "queued", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date() } }
    ).catch(() => {});

    let done = 0;
    for (let i = 0; i < maxJobs; i++) {
        const job = await claimJob();
        if (!job) break;
        await deliver(job);
        done++;
    }
    return { processed: done };
}

export default { runEmailSweep };
