/**
 * DURABLE CANCELLATION RECOVERY WORKER
 * ---------------------------------------------------------------------------
 * Reconciles unresolved cancellation requests independently of normal fulfillment.
 * Survives process restarts and ensures:
 * - Orders with cancellation.status = "requested" are picked up.
 * - Late-created Shiprocket shipments are detected via findShipmentByOurOrderId
 *   and cancelled without reopening the order.
 * - Confirmed cancellations complete their stock release and refund cleanly.
 * - Definite courier rejections preserve tracking without false stock release.
 * - Exhausted retries transition to manual review with an actionable reason.
 */

import crypto from "crypto";
import Order from "../models/orderModal.js";
import shiprocket from "./shiprocket.js";
import {
    WORKER_ID,
    releaseReservation,
    completeCancellation,
    recordCourierOutcome,
    enqueueShippingEmail,
    backoffDate,
} from "./orderLifecycle.js";
import {
    refundPaidOrder,
} from "./orderCancellation.js";

const CANCELLATION_LEASE_MS = Number(process.env.CANCELLATION_LEASE_MS || 60000);
const MAX_CANCELLATION_ATTEMPTS = Number(process.env.CANCELLATION_MAX_ATTEMPTS || 5);

function makeClaimToken(workerId = WORKER_ID) {
    return `cancel-${workerId}#${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Atomically claim an order for cancellation reconciliation.
 */
export async function claimCancellation(orderId, claimToken = makeClaimToken(), leaseMs = CANCELLATION_LEASE_MS) {
    const now = new Date();
    return Order.findOneAndUpdate(
        {
            _id: orderId,
            "cancellation.status": "requested",
            status: { $ne: "cancelled" },
            $or: [
                { "cancellation.nextAttemptAt": null },
                { "cancellation.nextAttemptAt": { $lte: now } },
            ],
            $and: [
                {
                    $or: [
                        { "cancellation.claimExpiresAt": null },
                        { "cancellation.claimExpiresAt": { $exists: false } },
                        { "cancellation.claimExpiresAt": { $lt: now } },
                    ],
                },
            ],
        },
        {
            $set: {
                "cancellation.claimToken": claimToken,
                "cancellation.claimExpiresAt": new Date(now.getTime() + leaseMs),
            },
            $inc: { "cancellation.attempts": 1 },
        },
        { new: true }
    );
}

/**
 * Release lease and update retry schedule.
 */
export async function releaseCancellationClaim(orderId, claimToken, update = {}) {
    return Order.updateOne(
        { _id: orderId, "cancellation.claimToken": claimToken },
        {
            $set: {
                "cancellation.claimToken": null,
                "cancellation.claimExpiresAt": null,
                ...update,
            },
        }
    );
}

/**
 * Reconcile a single order's pending cancellation.
 */
export async function reconcileSingleCancellation(orderDoc, claimToken = makeClaimToken()) {
    const orderId = orderDoc._id;
    const attempts = orderDoc.cancellation?.attempts || 1;

    try {
        let courierOutcome = orderDoc.cancellation?.courierOutcome || null;
        let srOrderId = orderDoc.shiprocket?.orderId || null;

        // 1. If no Shiprocket order ID, check if a late shipment was created
        if (!srOrderId) {
            const searchRes = await shiprocket.findShipmentByOurOrderId(orderDoc.orderId);

            if (searchRes.outcome === "FOUND") {
                srOrderId = searchRes.shipment.srOrderId;
                await Order.updateOne(
                    { _id: orderId },
                    {
                        $set: {
                            "shiprocket.orderId": searchRes.shipment.srOrderId,
                            "shiprocket.shipmentId": searchRes.shipment.shipmentId,
                            "shiprocket.status": searchRes.shipment.status,
                            "fulfillment.stage": "sr_created",
                        },
                    }
                );
            } else if (searchRes.outcome === "CONFIRMED_ABSENT") {
                courierOutcome = "not_needed";
            } else {
                // UNKNOWN / search failed: retry later
                const nextDate = backoffDate(attempts);
                await releaseCancellationClaim(orderId, claimToken, {
                    "cancellation.nextAttemptAt": nextDate,
                    "cancellation.lastError": `Shipment search uncertain (${searchRes.reason || searchRes.error || "unknown"})`,
                });
                return { outcome: "uncertain", reason: "shipment_search_uncertain" };
            }
        }

        // 2. If shipment ID is known and cancellation unconfirmed, cancel via courier
        if (srOrderId && courierOutcome !== "confirmed" && courierOutcome !== "not_needed") {
            const cancelRes = await shiprocket.cancelShiprocketOrder(srOrderId);
            courierOutcome = cancelRes.outcome; // "confirmed" | "failed" | "uncertain"
        }

        await recordCourierOutcome(orderId, courierOutcome);

        // 3. Process confirmed outcome or not_needed
        if (courierOutcome === "confirmed" || courierOutcome === "not_needed") {
            // Inventory release
            await releaseReservation(orderId, { reason: "cancelled" });

            // Refund if paid
            if (orderDoc.payment?.status === "paid") {
                try {
                    const freshOrder = await Order.findById(orderId);
                    await refundPaidOrder(freshOrder, orderDoc.cancellation?.reason || "Order cancelled");
                } catch (rErr) {
                    console.error(`[CancellationWorker] Refund initiation for ${orderDoc.orderId}:`, rErr.message);
                }
            }

            // Finalize order cancellation
            await completeCancellation(orderId);
            await enqueueShippingEmail(orderId, "cancelled");

            await releaseCancellationClaim(orderId, claimToken, {
                "cancellation.resolvedAt": new Date(),
                "cancellation.nextAttemptAt": null,
                "cancellation.lastError": null,
            });

            return { outcome: "completed", courierOutcome };
        }

        // 4. Definite courier rejection (parcel already in transit / delivered)
        if (courierOutcome === "failed") {
            await releaseCancellationClaim(orderId, claimToken, {
                "cancellation.resolvedAt": new Date(),
                "cancellation.nextAttemptAt": null,
                "cancellation.lastError": "Courier rejected cancellation; parcel is with courier.",
                "fulfillmentHold.active": true,
                "fulfillmentHold.reason": "Cancellation rejected by courier (parcel in transit).",
            });

            return { outcome: "courier_rejected", courierOutcome };
        }

        // 5. Courier outcome still uncertain: retry or escalate to manual review
        if (attempts >= MAX_CANCELLATION_ATTEMPTS) {
            await releaseCancellationClaim(orderId, claimToken, {
                "cancellation.nextAttemptAt": null,
                "cancellation.lastError": `Exhausted ${attempts} attempts reconciling cancellation with courier. Manual review required.`,
                "fulfillmentHold.active": true,
                "fulfillmentHold.reason": "Manual review required: courier cancellation unresolved after maximum retries.",
            });

            return { outcome: "manual_review", attempts };
        }

        const nextDate = backoffDate(attempts);
        await releaseCancellationClaim(orderId, claimToken, {
            "cancellation.nextAttemptAt": nextDate,
            "cancellation.lastError": "Courier cancel outcome uncertain; scheduled retry.",
        });

        return { outcome: "uncertain", nextAttemptAt: nextDate };
    } catch (err) {
        console.error(`[CancellationWorker] Error reconciling ${orderDoc.orderId}:`, err.message);
        const nextDate = backoffDate(attempts);
        await releaseCancellationClaim(orderId, claimToken, {
            "cancellation.nextAttemptAt": nextDate,
            "cancellation.lastError": String(err.message || err).slice(0, 300),
        });
        return { outcome: "error", error: err.message };
    }
}

/**
 * Background sweep pass for all pending cancellations.
 */
export async function runCancellationSweep(batchLimit = 10) {
    const now = new Date();
    const candidates = await Order.find({
        "cancellation.status": "requested",
        status: { $ne: "cancelled" },
        $or: [
            { "cancellation.nextAttemptAt": null },
            { "cancellation.nextAttemptAt": { $lte: now } },
        ],
        $and: [
            {
                $or: [
                    { "cancellation.claimExpiresAt": null },
                    { "cancellation.claimExpiresAt": { $exists: false } },
                    { "cancellation.claimExpiresAt": { $lt: now } },
                ],
            },
        ],
    })
        .sort({ "cancellation.nextAttemptAt": 1, createdAt: 1 })
        .limit(batchLimit);

    let processed = 0;
    for (const doc of candidates) {
        const claimToken = makeClaimToken();
        const claimed = await claimCancellation(doc._id, claimToken);
        if (!claimed) continue;

        await reconcileSingleCancellation(claimed, claimToken);
        processed++;
    }

    return { processed, found: candidates.length };
}

export default {
    claimCancellation,
    releaseCancellationClaim,
    reconcileSingleCancellation,
    runCancellationSweep,
};

