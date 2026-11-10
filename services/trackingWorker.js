/**
 * BACKGROUND TRACKING RECONCILIATION WORKER
 * Periodically syncs active in-transit / dispatched orders with Shiprocket tracking.
 * Ensures orders advance through shipping stages and reach 'delivered' without
 * requiring a browser tracking session.
 */
import Order from "../models/orderModal.js";
import shiprocket from "./shiprocket.js";
import { mapShipmentStatus } from "./shiprocketTracking.js";
import { syncOrderFromShipment } from "../controllers/orderController.js";

const DEFAULT_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
export const TRACKING_POLL_INTERVAL_MS = Number(process.env.TRACKING_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);

export const TRACKING_BACKOFF_STEPS_MINUTES = [1, 5, 15, 60, 240];

export function computeTrackingBackoff(attempts = 1, baseDate = new Date()) {
    const steps = TRACKING_BACKOFF_STEPS_MINUTES;
    const index = Math.max(0, Math.min(attempts - 1, steps.length - 1));
    const minutes = steps[index];
    const base = baseDate instanceof Date ? baseDate.getTime() : (baseDate ? new Date(baseDate).getTime() : Date.now());
    return new Date(base + minutes * 60 * 1000);
}

export function buildTrackingWorkerQuery(now = new Date()) {
    const targetDate = now instanceof Date ? now : (now ? new Date(now) : new Date());
    return {
        status: { $in: ["processing", "shipped", "in_transit", "out_for_delivery", "confirmed"] },
        "cancellation.status": { $nin: ["requested", "completed"] },
        "fulfillmentHold.active": { $ne: true },
        $and: [
            {
                $or: [
                    { "shiprocket.awbCode": { $exists: true, $ne: null, $nin: ["", null, undefined] } },
                    { "shiprocket.shipmentId": { $exists: true, $ne: null } },
                    { "shiprocket.orderId": { $exists: true, $ne: null } },
                ],
            },
            {
                $or: [
                    { "delivery.nextTrackingAt": { $exists: false } },
                    { "delivery.nextTrackingAt": null },
                    { "delivery.nextTrackingAt": { $lte: targetDate } },
                ],
            },
        ],
    };
}

export function isOrderEligibleForTracking(order, now = new Date()) {
    if (!order) return false;
    const targetTime = now instanceof Date ? now.getTime() : new Date(now).getTime();

    const validStatuses = ["processing", "shipped", "in_transit", "out_for_delivery", "confirmed"];
    if (!validStatuses.includes(order.status)) return false;

    if (["requested", "completed"].includes(order.cancellation?.status)) return false;

    if (order.fulfillmentHold?.active === true) return false;

    const hasAwb = order.shiprocket?.awbCode && !["", null, undefined].includes(order.shiprocket.awbCode);
    const hasShipmentId = order.shiprocket?.shipmentId != null;
    const hasOrderId = order.shiprocket?.orderId != null;
    if (!hasAwb && !hasShipmentId && !hasOrderId) return false;

    const nextTrackingAt = order.delivery?.nextTrackingAt;
    if (nextTrackingAt != null) {
        const nextTime = new Date(nextTrackingAt).getTime();
        if (Number.isFinite(nextTime) && nextTime > targetTime) {
            return false;
        }
    }

    return true;
}

export function buildCanonicalTrackingFromDetail(detail, fallbackShipmentId = null) {
    if (!detail) return null;
    const mappedStatus = detail.statusCode != null
        ? mapShipmentStatus(detail.statusCode, "order")
        : (detail.status ? mapShipmentStatus(detail.status, "order") : null);
    return {
        __canonical: true,
        eventTime: detail.eventTime || null,
        etd: detail.etd || null,
        awb: detail.awb || null,
        shipmentId: detail.shipmentId || fallbackShipmentId || null,
        courierName: detail.courier || null,
        rawStatus: detail.statusCode ?? detail.status ?? null,
        shipmentStatus: detail.status || null,
        currentStatus: detail.status || null,
        mappedStatus,
        trackUrl: detail.trackUrl || null,
        activities: [],
    };
}

export async function runTrackingSweep(batchLimit = 15, options = {}) {
    const syncFn = options.syncOrderFromShipment || syncOrderFromShipment;
    const now = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date());
    const pollIntervalMs = Number(options.pollIntervalMs || process.env.TRACKING_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);
    const computeBackoff = options.computeBackoff || computeTrackingBackoff;

    const query = buildTrackingWorkerQuery(now);
    const activeOrders = await Order.find(query)
        .sort({ "delivery.nextTrackingAt": 1, createdAt: 1 })
        .limit(batchLimit);

    let synced = 0;
    for (const order of activeOrders) {
        const attemptTime = options.now instanceof Date ? options.now : new Date();
        try {
            let tracking = null;
            if (order.shiprocket?.awbCode) {
                tracking = await shiprocket.trackByAWB(order.shiprocket.awbCode);
            } else if (order.shiprocket?.shipmentId) {
                const detail = await shiprocket.getShipmentDetail(order.shiprocket.shipmentId);
                if (detail) {
                    tracking = buildCanonicalTrackingFromDetail(detail, order.shiprocket.shipmentId);
                }
            } else if (order.shiprocket?.orderId) {
                tracking = await shiprocket.trackByShiprocketOrderId(order.shiprocket.orderId);
            }

            if (!tracking) {
                throw new Error(`Shiprocket tracking not found for ${order.orderId || order._id}`);
            }

            await syncFn(order, tracking);

            order.delivery = order.delivery || {};
            order.delivery.lastTrackingAttemptAt = attemptTime;
            order.delivery.trackingAttempts = 0;
            order.delivery.lastTrackingError = null;
            order.delivery.nextTrackingAt = new Date(attemptTime.getTime() + pollIntervalMs);

            if (typeof order.save === "function") {
                await order.save();
            } else if (order._id && Order.updateOne) {
                await Order.updateOne(
                    { _id: order._id },
                    {
                        $set: {
                            "delivery.lastTrackingAttemptAt": attemptTime,
                            "delivery.trackingAttempts": 0,
                            "delivery.lastTrackingError": null,
                            "delivery.nextTrackingAt": new Date(attemptTime.getTime() + pollIntervalMs),
                        },
                    }
                );
            }

            synced++;
        } catch (err) {
            console.error(`[TrackingWorker] Failed to sync tracking for ${order.orderId || order._id}:`, err.message);

            const currentAttempts = (order.delivery?.trackingAttempts || 0) + 1;
            const sanitizedError = String(err?.message || err).slice(0, 500);
            const nextTrackingAt = computeBackoff(currentAttempts, attemptTime);

            order.delivery = order.delivery || {};
            order.delivery.lastTrackingAttemptAt = attemptTime;
            order.delivery.trackingAttempts = currentAttempts;
            order.delivery.lastTrackingError = sanitizedError;
            order.delivery.nextTrackingAt = nextTrackingAt;

            try {
                if (typeof order.save === "function") {
                    await order.save();
                } else if (order._id && Order.updateOne) {
                    await Order.updateOne(
                        { _id: order._id },
                        {
                            $set: {
                                "delivery.lastTrackingAttemptAt": attemptTime,
                                "delivery.trackingAttempts": currentAttempts,
                                "delivery.lastTrackingError": sanitizedError,
                                "delivery.nextTrackingAt": nextTrackingAt,
                            },
                        }
                    );
                }
            } catch (saveErr) {
                console.error(`[TrackingWorker] Failed to persist tracking error state for ${order.orderId || order._id}:`, saveErr.message);
            }
        }
    }
    return { synced, total: activeOrders.length };
}

export default {
    runTrackingSweep,
    buildCanonicalTrackingFromDetail,
    buildTrackingWorkerQuery,
    computeTrackingBackoff,
    isOrderEligibleForTracking,
    TRACKING_POLL_INTERVAL_MS,
    TRACKING_BACKOFF_STEPS_MINUTES,
};
