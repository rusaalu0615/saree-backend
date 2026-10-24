/**
 * DURABLE, RESUMABLE FULFILLMENT WORKER
 * ---------------------------------------------------------------------------
 * The Shiprocket pipeline is a persisted STAGE MACHINE on the order, driven by
 * a database-backed worker claim — not an in-memory flag (which is not a lock).
 * Any instance can safely run; a crashed/expired worker can never corrupt
 * another's progress because every stage write is a conditional update gated on
 * the CURRENT lock owner.
 *
 * Stages (order.fulfillment.stage):
 *   null / none            → not yet eligible (set to "ready" on payment/COD)
 *   ready                  → eligible, no create attempted yet
 *   create_uncertain       → we may have asked Shiprocket to create and the
 *                            outcome is UNKNOWN (timeout / crash-after-send).
 *                            MUST reconcile via search before any 2nd create.
 *   sr_created             → shipment exists (orderId + shipmentId stored)
 *   courier_pending        → no courier serviceable yet (durable, retriable)
 *   courier_assigned       → AWB assigned
 *   pickup_pending         → pickup request previously rejected (retriable)
 *   pickup_requested       → pickup scheduled
 *   complete               → dispatched; reservation marked return_pending
 *   needs_reconciliation   → ambiguous, resolve via provider search
 *   manual_review          → retries exhausted; a human must act
 *
 * Recovery explicitly includes COD orders AND paid orders whose stage is
 * null/none (the old replay only reconciled needs_reconciliation while blindly
 * replaying create). External provider success followed by a local-save failure
 * can never create a duplicate shipment because the stage stays uncertain and
 * the next run reconciles first.
 */
import crypto from "crypto";
import Order from "../models/orderModal.js";
import shiprocket from "./shiprocket.js";
import {
    WORKER_ID,
    enqueueShippingEmail,
    backoffDate,
} from "./orderLifecycle.js";

const LEASE_MS = Number(process.env.FULFILLMENT_LEASE_MS || 90000);
const MAX_FULFILLMENT_ATTEMPTS = Number(process.env.FULFILLMENT_MAX_ATTEMPTS || 8);
// After we asked Shiprocket to create and lost the response, an EMPTY search can
// simply be indexing lag — wait this long (and re-check across sweeps) before we
// ever trust CONFIRMED_ABSENT enough to attempt a second create.
const RECONCILE_GRACE_MS = Number(process.env.SHIPROCKET_RECONCILE_GRACE_MS || 120000);

// A unique token per CLAIM (not just the process-wide WORKER_ID) so that two
// overlapping workers on the same process can never both hold a lease, and a
// stale claim from a prior run can never satisfy an ownership-guarded write.
function makeClaimToken(workerId = WORKER_ID) {
    return `${workerId}#${crypto.randomBytes(6).toString("hex")}`;
}

// Stages a background sweep is allowed to (re)claim and drive forward.
export const RESUMABLE_STAGES = [
    "ready",
    "create_uncertain",
    "sr_created",
    "courier_pending",
    "courier_assigned",
    "pickup_pending",
    "pickup_requested",
    "needs_reconciliation",
];

const isAmbiguous = (err) =>
    err && (err.name === "AbortError" || /timeout|network|socket|econn|etimedout|fetch failed/i.test(String(err.message || err)));

// Shared eligibility — used BOTH to pick sweep candidates AND, crucially, in the
// atomic claim itself, so eligibility is enforced at claim time, not only before.
// A cancellation INTENT ("requested", even before status flips to "cancelled")
// stops the pipeline just as hard as a completed cancellation — new fulfillment
// must never be started for an order the customer/admin has asked to cancel.
function eligibilityFilter() {
    return {
        "fulfillmentHold.active": { $ne: true },
        status: { $nin: ["cancelled", "returned"] },
        "cancellation.status": { $nin: ["requested", "completed"] },
        "reservation.state": { $nin: ["released", "return_pending", "return_restored"] },
        $or: [
            { "payment.method": "cod" },
            { "payment.status": "paid" },
        ],
    };
}

/**
 * Atomically CLAIM an order for fulfillment work, enforcing eligibility IN the
 * update and taking the lease only if no live lock is held. Returns the fresh
 * doc (with our unique `claimToken` as lockOwner) or null.
 */
export async function claimFulfillment(orderId, claimToken = makeClaimToken(), leaseMs = LEASE_MS) {
    const now = new Date();
    return Order.findOneAndUpdate(
        {
            _id: orderId,
            ...eligibilityFilter(),
            "fulfillment.stage": { $in: RESUMABLE_STAGES },
            "fulfillment.nextAttemptAt": { $lte: now },
            // free lock OR our own expired lock OR any expired lock
            $and: [
                {
                    $or: [
                        { "fulfillment.lockUntil": null },
                        { "fulfillment.lockUntil": { $exists: false } },
                        { "fulfillment.lockUntil": { $lt: now } },
                    ],
                },
            ],
            // never advance a cancelled/refund-in-flight order past checks done later
        },
        {
            $set: {
                "fulfillment.lockOwner": claimToken,
                "fulfillment.lockUntil": new Date(now.getTime() + leaseMs),
                "fulfillment.updatedAt": now,
            },
            $inc: { "fulfillment.attempts": 1 },
        },
        { new: true }
    );
}

/** Conditional write that only succeeds while WE still own the lease. */
async function ownedUpdate(orderId, claimToken, set, push) {
    const update = { $set: { ...set, "fulfillment.updatedAt": new Date() } };
    if (push) update.$push = push;
    return Order.updateOne({ _id: orderId, "fulfillment.lockOwner": claimToken }, update);
}

/**
 * Extend our lease before a long-running external call, but ONLY while we still
 * own it. Returns false when ownership was lost (expired lease stolen by another
 * worker) so the caller can stop instead of racing a newer owner.
 */
async function renewLease(orderId, claimToken, leaseMs = LEASE_MS) {
    const res = await Order.updateOne(
        { _id: orderId, "fulfillment.lockOwner": claimToken },
        { $set: { "fulfillment.lockUntil": new Date(Date.now() + leaseMs), "fulfillment.updatedAt": new Date() } }
    );
    return res.modifiedCount === 1;
}

/** Release the lease (only if we still own it) so a stale worker never clears another's lock. */
async function releaseLease(orderId, claimToken, set = {}) {
    return Order.updateOne(
        { _id: orderId, "fulfillment.lockOwner": claimToken },
        { $set: { "fulfillment.lockUntil": null, "fulfillment.updatedAt": new Date(), ...set } }
    );
}

// --- Stage helpers ---------------------------------------------------------

async function stageEnsureShipment(order, claimToken) {
    if (order.shiprocket?.orderId && order.shiprocket?.shipmentId) return order;

    // Reconcile an ambiguous previous create BEFORE attempting another. We only
    // recreate on a DEFINITIVE absence that has also aged past the grace window;
    // an UNKNOWN lookup (malformed/timeout/incomplete) or a too-fresh empty
    // result must NEVER be mistaken for "it didn't happen, create again".
    const isUncertainReconcile =
        ["create_uncertain", "needs_reconciliation"].includes(order.fulfillment?.stage) ||
        order.fulfillment?.attempts > 1;

    if (isUncertainReconcile) {
        const lookup = await shiprocket.findShipmentByOurOrderId(order.orderId);

        if (lookup.outcome === "FOUND") {
            await ownedUpdate(order._id, claimToken, {
                "shiprocket.orderId": lookup.shipment.srOrderId,
                "shiprocket.shipmentId": lookup.shipment.shipmentId,
                "shiprocket.status": lookup.shipment.status,
                "fulfillment.stage": "sr_created",
                "fulfillment.stageConfirmedAt": new Date(),
                "fulfillment.uncertainSince": null,
                "fulfillment.lastError": null,
                status: order.status === "placed" ? "confirmed" : order.status,
            });
            return Order.findById(order._id);
        }

        // UNKNOWN or a fresh/empty absence: keep the durable uncertain stage and
        // reschedule — never fire a second create off this run.
        const uncertainSince = order.fulfillment?.uncertainSince
            ? new Date(order.fulfillment.uncertainSince).getTime()
            : null;
        const agedOut = uncertainSince !== null && Date.now() - uncertainSince >= RECONCILE_GRACE_MS;

        if (lookup.outcome === "CONFIRMED_ABSENT" && agedOut) {
            // A well-formed absence that has aged past the grace window is now
            // trustworthy — fall through to a single (re)create below.
        } else {
            const reason =
                lookup.outcome === "UNKNOWN"
                    ? `shipment lookup UNKNOWN (${lookup.reason || ""}) — not recreating`
                    : `shipment search empty but within reconcile grace — re-checking later`;
            await ownedUpdate(order._id, claimToken, {
                "fulfillment.lastError": reason.slice(0, 300),
                "fulfillment.nextAttemptAt": backoffDate(order.fulfillment?.attempts),
                "fulfillment.uncertainSince": uncertainSince ? order.fulfillment.uncertainSince : new Date(),
            });
            // Throwing keeps the run from advancing stages; the outer catch keeps
            // the uncertain stage and owner-guards the write.
            throw Object.assign(new Error(reason), { code: "reconcile_pending" });
        }
    }

    // Persist create intent FIRST (with a timestamp) so a crash/timeout after
    // send is recognized as uncertain on the next run.
    await ownedUpdate(order._id, claimToken, {
        "fulfillment.stage": "create_uncertain",
        "fulfillment.uncertainSince": new Date(),
    });

    // Renew the lease immediately before the external call; if we already lost
    // ownership, stop rather than create against a doc another worker holds.
    if (!(await renewLease(order._id, claimToken))) {
        throw Object.assign(new Error("lease_lost_before_create"), { code: "lease" });
    }

    const result = await shiprocket.createShiprocketOrder(order);
    if (!result?.order_id || !result?.shipment_id) {
        throw new Error(`Shiprocket create returned no ids: ${JSON.stringify(result).slice(0, 160)}`);
    }
    // The two ids MUST be distinct concepts; refuse to persist a create whose
    // shipment id is missing or merely echoes the order id.
    if (String(result.order_id) === String(result.shipment_id)) {
        throw new Error(`Shiprocket create returned identical order/shipment ids: ${JSON.stringify(result).slice(0, 160)}`);
    }

    const res = await ownedUpdate(
        order._id,
        claimToken,
        {
            "shiprocket.orderId": result.order_id,
            "shiprocket.shipmentId": result.shipment_id,
            "shiprocket.status": result.status || null,
            "fulfillment.stage": "sr_created",
            "fulfillment.stageConfirmedAt": new Date(),
            "fulfillment.uncertainSince": null,
            status: order.status === "placed" ? "confirmed" : order.status,
        },
        { timeline: { status: "Order Confirmed", description: "Order confirmed and sent to shipping partner", date: new Date() } }
    );
    if (res.modifiedCount !== 1) {
        // We lost the lease but the create SUCCEEDED — adopt the ids by owner-
        // independent id write so the shipment is never orphaned/recreated.
        await Order.updateOne(
            { _id: order._id, "shiprocket.orderId": { $exists: false } },
            { $set: { "shiprocket.orderId": result.order_id, "shiprocket.shipmentId": result.shipment_id, "fulfillment.uncertainSince": null } }
        ).catch(() => {});
        throw Object.assign(new Error("lease_lost_after_create"), { code: "lease" });
    }
    return Order.findById(order._id);
}

async function stageAssignCourier(order, claimToken) {
    if (!order.shiprocket?.shipmentId || order.shiprocket?.awbCode) return order;

    // Renew before the external call; stop on lost ownership rather than racing.
    if (!(await renewLease(order._id, claimToken))) {
        throw Object.assign(new Error("lease_lost_before_courier"), { code: "lease" });
    }

    const courier = await shiprocket.assignCourier(order.shiprocket.shipmentId, {
        pickupPincode: process.env.SHIPROCKET_PICKUP_PINCODE || "",
        deliveryPincode: order.shippingAddress.pincode,
        weight: shiprocket.calculateWeight(order),
        isCOD: order.payment.method === "cod",
    });

    if (courier?.awbCode) {
        await ownedUpdate(order._id, claimToken, {
            "shiprocket.courierName": courier.courierName,
            "shiprocket.courierCompanyId": courier.courierCompanyId,
            "shiprocket.awbCode": courier.awbCode,
            "shiprocket.trackingUrl": `https://shiprocket.co/tracking/${courier.awbCode}`,
            "fulfillment.stage": "courier_assigned",
            "fulfillment.stageConfirmedAt": new Date(),
            "fulfillment.lastError": null,
        });
    } else if (courier) {
        // Courier chosen but no AWB returned — serviceable, keep trying.
        await ownedUpdate(order._id, claimToken, {
            "shiprocket.courierName": courier.courierName,
            "shiprocket.courierCompanyId": courier.courierCompanyId,
            "fulfillment.stage": "courier_pending",
            "fulfillment.nextAttemptAt": backoffDate(order.fulfillment?.attempts),
        });
    } else {
        // No courier serviceable right now — durable retry, NOT an error state.
        await ownedUpdate(order._id, claimToken, {
            "fulfillment.stage": "courier_pending",
            "fulfillment.lastError": "no courier serviceable for pincode",
            "fulfillment.nextAttemptAt": backoffDate(order.fulfillment?.attempts),
        });
    }
    return Order.findById(order._id);
}

async function stageGeneratePickup(order, claimToken) {
    if (!order.shiprocket?.awbCode) return order;
    if (!["courier_assigned", "pickup_pending"].includes(order.fulfillment?.stage)) return order;

    // Renew before the external call.
    if (!(await renewLease(order._id, claimToken))) {
        throw Object.assign(new Error("lease_lost_before_pickup"), { code: "lease" });
    }

    const pickup = await shiprocket.generatePickup(order.shiprocket.shipmentId);
    const rejected = pickup?.data?.failed_pickup_messages?.length || pickup?.data?.error?.message;
    const scheduledDate =
        pickup?.data?.pickup_dates?.[0]?.pickup_origin_expected_date ||
        pickup?.data?.pickup_dates?.[0]?.pickup_scheduled_date ||
        null;
    // A REAL confirmation — Shiprocket returns pickup_dates on an accepted
    // request. "No rejection AND no date" is NOT proof of a scheduled pickup, so
    // we do not advance (and definitely never treat it as a courier handover).
    const confirmed = !rejected && scheduledDate !== null;

    if (rejected) {
        await ownedUpdate(
            order._id,
            claimToken,
            { "fulfillment.stage": "pickup_pending", "fulfillment.lastError": String(rejected).slice(0, 300), "fulfillment.nextAttemptAt": backoffDate(order.fulfillment?.attempts) },
            { timeline: { status: "Pickup Pending", description: `Pickup rejected: ${String(rejected).slice(0, 150)} — will retry`, date: new Date() } }
        );
        return Order.findById(order._id);
    }

    if (!confirmed) {
        // Ambiguous success (accepted but no scheduled date) — retry the pickup;
        // this is NOT a dispatch and must not mark stock return_pending.
        await ownedUpdate(
            order._id,
            claimToken,
            { "fulfillment.stage": "pickup_pending", "fulfillment.lastError": "pickup accepted but no scheduled date returned — re-confirming", "fulfillment.nextAttemptAt": backoffDate(order.fulfillment?.attempts) }
        );
        return Order.findById(order._id);
    }

    // Pickup SUCCEEDED with a real scheduled date. Advance to pickup_requested
    // (scheduled) — this is still NOT a physical handover; the reservation is
    // only frozen (return_pending) once real tracking reports a courier pickup.
    await ownedUpdate(
        order._id,
        claimToken,
        { "fulfillment.stage": "pickup_requested", "fulfillment.stageConfirmedAt": new Date(), "fulfillment.pickupScheduledFor": scheduledDate, "fulfillment.lastError": null },
        { timeline: { status: "Pickup Scheduled", description: `Courier pickup scheduled for ${scheduledDate}`, date: new Date() } }
    );
    return Order.findById(order._id);
}

async function stageComplete(order, claimToken) {
    // The fulfillment PIPELINE's job ends at a scheduled pickup: getting the
    // shipment created, a courier assigned and a pickup booked. "Pickup
    // scheduled" is deliberately NOT treated as a physical handover here — the
    // reservation stays "held" (a genuine pre-handover cancel can still release
    // stock) and only syncOrderFromShipment, on a REAL courier scan, flips it to
    // return_pending. So completing the stage must NOT mark dispatched.
    if (order.fulfillment?.stage !== "pickup_requested") return false;
    const done = await ownedUpdate(
        order._id,
        claimToken,
        { "fulfillment.stage": "complete", "fulfillment.stageConfirmedAt": new Date(), "fulfillment.lastError": null, "fulfillment.nextAttemptAt": null },
        { timeline: { status: "Pickup Booked", description: "Shipment handed to courier schedule — awaiting pickup scan", date: new Date() } }
    );
    if (done.modifiedCount === 1) {
        await enqueueShippingEmail(order._id, "processing").catch(() => {});
        return true;
    }
    return false;
}

/**
 * Drive an order through as many stages as possible in one claimed session.
 * Each stage re-reads the fresh doc; a re-check of cancellation-intent/hold/
 * refund/ownership happens before later stages so a stale worker can't overwrite
 * a cancel or race a newer owner. `claimToken` is unique PER CLAIM, so two
 * overlapping workers never share an ownership key.
 */
export async function runFulfillmentForOrder(orderId, workerId = WORKER_ID) {
    const claimToken = makeClaimToken(workerId);
    let order = await claimFulfillment(orderId, claimToken);
    if (!order) return { claimed: false, orderId: String(orderId) };

    const recheck = async () => {
        const cur = await Order.findById(order._id);
        if (!cur) return true; // gone
        if (
            ["cancelled", "returned"].includes(cur.status) ||
            ["requested", "completed"].includes(cur.cancellation?.status) ||
            cur.fulfillmentHold?.active
        ) {
            await releaseLease(order._id, claimToken, { "fulfillment.lastError": "cancelled/held/cancel-requested — pipeline stopped" });
            return true; // stop
        }
        // Lease may have expired mid-run; confirm we still own it (our claim token).
        if (cur.fulfillment?.lockOwner !== claimToken) return true; // another worker took over
        return false;
    };

    try {
        if (await recheck()) return { claimed: true, stopped: true, orderId: order.orderId };
        order = await stageEnsureShipment(order, claimToken);

        if (await recheck()) return { claimed: true, stopped: true, orderId: order.orderId };
        order = await stageAssignCourier(order, claimToken);

        if (await recheck()) return { claimed: true, stopped: true, orderId: order.orderId };
        order = await stageGeneratePickup(order, claimToken);

        if (await recheck()) return { claimed: true, stopped: true, orderId: order.orderId };
        const completed = await stageComplete(order, claimToken);

        if (!completed) {
            // Not terminal-complete; free the lease so the next scheduled attempt
            // (courier_pending / pickup_pending backoff) can resume.
            await releaseLease(order._id, claimToken);
        }
        return { claimed: true, completed, orderId: order.orderId };
    } catch (err) {
        if (err?.code === "lease") return { claimed: true, stopped: true, orderId: order.orderId };
        // A controlled reconcile hold: we already scheduled the next attempt under
        // our claim token; free the lease and leave the uncertain stage untouched.
        if (err?.code === "reconcile_pending") {
            await releaseLease(order._id, claimToken).catch(() => {});
            return { claimed: true, reconciling: true, orderId: order.orderId };
        }
        const ambiguous = isAmbiguous(err);
        const attempts = order.fulfillment?.attempts || 1;
        const exhausted = attempts >= MAX_FULFILLMENT_ATTEMPTS;
        const set = {
            "fulfillment.lastError": String(err.message || err).slice(0, 400),
            "fulfillment.lockUntil": null,
            "fulfillment.updatedAt": new Date(),
            "fulfillment.nextAttemptAt": exhausted ? null : backoffDate(attempts),
        };
        // Ambiguous create → keep the uncertain stage so a resume reconciles.
        if (ambiguous && !order.shiprocket?.orderId) {
            set["fulfillment.stage"] = "create_uncertain";
            set["fulfillment.uncertainSince"] = order.fulfillment?.uncertainSince || new Date();
        }
        if (exhausted) set["fulfillment.stage"] = "manual_review";
        // Owner-guarded by our unique claim token so a stale worker never
        // overwrites a newer state.
        await Order.updateOne({ _id: order._id, "fulfillment.lockOwner": claimToken }, { $set: set }).catch(() => {});
        console.error(`[Fulfillment] ${order.orderId} attempt ${attempts} error${exhausted ? " (manual_review)" : ""}:`, err.message);
        return { claimed: true, error: err.message, exhausted, orderId: order.orderId };
    }
}

/**
 * Bounded, indexed sweep for anything eligible — COD + paid orders whose stage
 * is resumable OR null/none. Null/none eligible orders (missed after a crash or
 * a paid order never flipped to ready) are first nudged to "ready" so they
 * become claimable, then each candidate is run through the atomic claim.
 */
export async function runFulfillmentSweep(limit = 25) {
    const now = new Date();

    // Recovery of eligible orders stuck with a null/none stage: flip to ready
    // (durable) so the normal claim/backoff machinery drives them.
    await Order.updateMany(
        {
            ...eligibilityFilter(),
            $and: [
                { $or: [{ "fulfillment.stage": null }, { "fulfillment.stage": "none" }, { "fulfillment.stage": { $exists: false } }] },
            ],
            $or: [
                { "payment.method": "cod" },
                { "payment.status": "paid" },
            ],
        },
        { $set: { "fulfillment.stage": "ready", "fulfillment.nextAttemptAt": now } }
    ).catch(() => {});

    const candidates = await Order.find({
        ...eligibilityFilter(),
        "fulfillment.stage": { $in: RESUMABLE_STAGES },
        "fulfillment.nextAttemptAt": { $lte: now },
        $or: [
            { "fulfillment.lockUntil": null },
            { "fulfillment.lockUntil": { $exists: false } },
            { "fulfillment.lockUntil": { $lt: now } },
        ],
    })
        .select("_id")
        .sort({ "fulfillment.nextAttemptAt": 1 })
        .limit(limit)
        .lean();

    let processed = 0;
    for (const c of candidates) {
        const r = await runFulfillmentForOrder(c._id);
        if (r.claimed) processed++;
    }
    return { scanned: candidates.length, processed };
}

export default { runFulfillmentForOrder, runFulfillmentSweep, claimFulfillment, RESUMABLE_STAGES };
