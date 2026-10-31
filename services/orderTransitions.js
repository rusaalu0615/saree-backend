/**
 * ORDER TRANSITIONS SERVICE — Shared allowed-transition policy matrix and conditional state transitions.
 *
 * Requirements (spec §7):
 *  - Prepaid shipping requires confirmed payment (payment.status === "paid" or zero-payable).
 *  - COD follows its own explicit rules.
 *  - Respects fulfillment holds (fulfillmentHold.active), cancellation state, and shipment evidence.
 *  - Rejects invalid backward transitions.
 *  - Preserves dedicated cancellation and verified physical-return paths.
 *  - Uses conditional updates against current database state.
 *  - Commits status, timeline, and email enqueue atomically.
 *  - Repeated identical requests do not duplicate side effects.
 *  - Required overrides are authorized, explicit, and audited.
 */

import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import AppError from "../utils/AppError.js";
import { enqueueShippingEmail, confirmPhysicalReturn, releaseReservation } from "./orderLifecycle.js";
import { toPaise } from "../utils/security.js";

export const ORDER_STATUSES = [
    "placed",
    "confirmed",
    "processing",
    "shipped",
    "in_transit",
    "out_for_delivery",
    "delivered",
    "cancelled",
    "returned",
];

// Status rank to evaluate progression and prevent backward regression
export const STATUS_PROGRESSION_RANK = {
    placed: 10,
    confirmed: 20,
    processing: 30,
    shipped: 40,
    in_transit: 50,
    out_for_delivery: 60,
    delivered: 70,
    cancelled: 90,
    returned: 100,
};

/**
 * Valid allowed forward transitions map.
 */
export const ALLOWED_TRANSITIONS = {
    placed: ["confirmed", "processing", "cancelled"],
    confirmed: ["processing", "shipped", "cancelled"],
    processing: ["shipped", "cancelled"],
    shipped: ["in_transit", "out_for_delivery", "delivered", "returned", "cancelled"],
    in_transit: ["out_for_delivery", "delivered", "returned"],
    out_for_delivery: ["delivered", "returned"],
    delivered: ["returned"],
    cancelled: ["returned"], // Parcel in flight returned after cancellation
    returned: [],           // Terminal
};

/**
 * Validate whether a transition is allowed according to business policy.
 */
export function validateOrderTransition(order, toStatus, { isOverride = false, overrideReason = "" } = {}) {
    if (!order) {
        throw new AppError("Order not found", 404);
    }

    const fromStatus = order.status;

    if (!ORDER_STATUSES.includes(toStatus)) {
        throw new AppError(`Invalid status: "${toStatus}". Allowed statuses: ${ORDER_STATUSES.join(", ")}`, 400);
    }

    // 1. Idempotent no-op check: same status is always valid, won't duplicate effects
    if (fromStatus === toStatus) {
        return { isNoop: true, allowed: true };
    }

    // 2. Terminal state check: returned orders cannot transition
    if (fromStatus === "returned") {
        throw new AppError("Order is already returned and cannot transition further.", 400);
    }

    // 3. Cancelled orders cannot be reactivated
    if (fromStatus === "cancelled" && toStatus !== "returned") {
        throw new AppError("Order is cancelled and cannot be reactivated.", 400);
    }

    // 4. Fulfillment hold check: orders on hold cannot be fulfilled or shipped
    if (
        order.fulfillmentHold?.active &&
        ["processing", "shipped", "in_transit", "out_for_delivery", "delivered"].includes(toStatus)
    ) {
        throw new AppError(
            `Order cannot transition to "${toStatus}" because it is on fulfillment hold: ${order.fulfillmentHold.reason || "Review required"}`,
            400
        );
    }

    // 5. Payment check: prepaid shipping requires confirmed payment
    const isPrepaid = order.payment?.method !== "cod";
    const totalPaise = toPaise(order.pricing?.total || 0);
    const requiresPayment = isPrepaid && totalPaise > 0;
    const isPaid = order.payment?.status === "paid";

    if (
        requiresPayment &&
        !isPaid &&
        ["shipped", "in_transit", "out_for_delivery", "delivered"].includes(toStatus)
    ) {
        throw new AppError(
            `Cannot ship or deliver an unpaid prepaid order. Payment status is "${order.payment?.status || "pending"}".`,
            400
        );
    }

    // 6. Cancellation intent check
    if (
        order.cancellation?.status === "requested" &&
        ["shipped", "in_transit", "out_for_delivery", "delivered"].includes(toStatus)
    ) {
        throw new AppError("Order has a pending cancellation request and cannot proceed with shipping.", 400);
    }

    // 7. Allowed transitions map & backward transition prevention
    const allowedTargets = ALLOWED_TRANSITIONS[fromStatus] || [];
    if (!allowedTargets.includes(toStatus)) {
        if (!isOverride) {
            throw new AppError(
                `Invalid status transition from "${fromStatus}" to "${toStatus}". Backward or disallowed progression is rejected.`,
                400
            );
        }
        if (!overrideReason || typeof overrideReason !== "string" || !overrideReason.trim()) {
            throw new AppError("An explicit overrideReason is required when overriding order status progression.", 400);
        }
    }

    return { isNoop: false, allowed: true };
}

/**
 * Execute an order status transition conditionally and atomically.
 */
export async function executeOrderTransition(
    orderId,
    toStatus,
    {
        description = "",
        adminUser = null,
        isOverride = false,
        overrideReason = "",
        session: passedSession = null,
    } = {}
) {
    const runTransition = async (session) => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new AppError("Order not found", 404);

        const check = validateOrderTransition(order, toStatus, { isOverride, overrideReason });
        if (check.isNoop) {
            return { order, changed: false };
        }

        const fromStatus = order.status;

        // Physical return: atomic stock restoration BEFORE marking returned!
        if (toStatus === "returned") {
            const desc = description || "Physical return confirmed by admin";
            const returnRes = await confirmPhysicalReturn(order._id, { description: desc, session });
            if (!returnRes || !returnRes.success) {
                throw new AppError("Failed to restore inventory for physical return. Return transition aborted.", 500);
            }

            const updated = await Order.findOneAndUpdate(
                { _id: order._id, status: fromStatus },
                {
                    $set: {
                        status: "returned",
                        "returnInfo.status": "confirmed",
                        "returnInfo.confirmedAt": new Date(),
                        "returnInfo.stockRestored": true,
                        "reservation.state": "return_restored",
                        resourcesReleased: true,
                    },
                    $push: {
                        timeline: {
                            status: "Returned",
                            description: desc,
                            date: new Date(),
                        },
                    },
                },
                { new: true, session }
            );

            if (!updated) {
                throw new AppError("Order status was modified concurrently by another process. Please refresh and try again.", 409);
            }

            return { order: updated, changed: true };
        }

        // Conditional atomic update: requires current status to still match fromStatus
        const isPrepaid = order.payment?.method !== "cod";
        const totalPaise = toPaise(order.pricing?.total || 0);
        const requiresPayment = isPrepaid && totalPaise > 0;

        const statusLabel = toStatus.charAt(0).toUpperCase() + toStatus.slice(1).replace(/_/g, " ");
        const adminEmail = adminUser?.email || "admin";
        const defaultDesc = `Order status updated to ${statusLabel} by ${adminEmail}`;
        let entryDesc = description || defaultDesc;
        if (isOverride && overrideReason) {
            entryDesc = `${entryDesc} [OVERRIDE by ${adminEmail}: ${overrideReason.trim()}]`;
        }

        const timelineEntry = {
            status: statusLabel,
            description: entryDesc,
            date: new Date(),
        };

        const filter = {
            _id: order._id,
            status: fromStatus,
        };

        if (["processing", "shipped", "in_transit", "out_for_delivery", "delivered"].includes(toStatus)) {
            filter["fulfillmentHold.active"] = { $ne: true };
            filter["cancellation.status"] = { $ne: "requested" };
            if (requiresPayment) {
                filter["payment.status"] = "paid";
            }
        }

        const isDispatched = ["shipped", "in_transit", "out_for_delivery", "delivered"].includes(toStatus);
        const setDoc = { status: toStatus };
        if (isDispatched && order.reservation?.state === "held") {
            setDoc["reservation.state"] = "return_pending";
        }

        const updated = await Order.findOneAndUpdate(
            filter,
            {
                $set: setDoc,
                $push: { timeline: timelineEntry },
            },
            { new: true, session }
        );

        if (!updated) {
            throw new AppError("Order status or condition changed concurrently. Please refresh and try again.", 409);
        }

        // Atomically enqueue shipping update email if entering shipping stages
        if (["shipped", "in_transit", "out_for_delivery", "delivered"].includes(toStatus)) {
            await enqueueShippingEmail(updated._id, toStatus, { session });
        }

        return { order: updated, changed: true };
    };

    if (passedSession) {
        return await runTransition(passedSession);
    }

    if (mongoose.connection.readyState === 1) {
        const session = await mongoose.startSession();
        try {
            let res;
            await session.withTransaction(async () => {
                res = await runTransition(session);
            });
            return res;
        } finally {
            await session.endSession().catch(() => {});
        }
    }

    throw new AppError("Database connection is not ready. Status transition aborted.", 503);
}

export default {
    ORDER_STATUSES,
    STATUS_PROGRESSION_RANK,
    ALLOWED_TRANSITIONS,
    validateOrderTransition,
    executeOrderTransition,
};
