/**
 * BACKGROUND TRACKING RECONCILIATION WORKER
 * Periodically syncs active in-transit / dispatched orders with Shiprocket tracking.
 * Ensures orders advance through shipping stages and reach 'delivered' without
 * requiring a browser tracking session.
 */
import Order from "../models/orderModal.js";
import shiprocket from "./shiprocket.js";
import { syncOrderFromShipment } from "../controllers/orderController.js";

export async function runTrackingSweep(batchLimit = 15) {
    const activeOrders = await Order.find({
        $or: [
            { "shiprocket.awbCode": { $exists: true, $ne: null } },
            { "shiprocket.orderId": { $exists: true, $ne: null } },
        ],
        status: { $in: ["processing", "shipped", "in_transit", "out_for_delivery"] },
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
            } else if (order.shiprocket?.orderId) {
                tracking = await shiprocket.trackByShiprocketOrderId(order.shiprocket.orderId);
            }

            if (tracking) {
                await syncOrderFromShipment(order, tracking);
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
};

