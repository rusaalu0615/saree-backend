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
    // Recovery: confirmed orders WITH Shiprocket evidence (AWB/shipment) were
    // fulfilled but webhook was missed — they must be polled. Confirmed with
    // no identifiers stays untouched.
    const activeOrders = await Order.find({
        $or: [
            { "shiprocket.awbCode": { $exists: true, $ne: null, $nin: ["", null, undefined] } },
            { "shiprocket.shipmentId": { $exists: true, $ne: null } },
            { "shiprocket.orderId": { $exists: true, $ne: null } },
        ],
        status: { $in: ["processing", "shipped", "in_transit", "out_for_delivery", "confirmed"] },
        "cancellation.status": { $nin: ["requested", "completed"] },
        "fulfillmentHold.active": { $ne: true },
    })
        .sort({ updatedAt: 1 })
        .limit(batchLimit);

    let synced = 0;
    for (const order of activeOrders) {
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

            if (tracking) {
                await syncFn(order, tracking);
                synced++;
            }
        } catch (err) {
            console.error(`[TrackingWorker] Failed to sync tracking for ${order.orderId}:`, err.message);
        }
    }
    return { synced, total: activeOrders.length };
}

export default {
    runTrackingSweep,
    buildCanonicalTrackingFromDetail,
};
