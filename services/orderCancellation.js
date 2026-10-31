/**
 * ORDER CANCELLATION SERVICE
 * Centralized business logic, eligibility rules, lifecycle transitions,
 * and customer/admin summaries for order cancellation and refunds.
 */

import Order from "../models/orderModal.js";
import AppError from "../utils/AppError.js";
import shiprocket from "./shiprocket.js";
import razorpayInstance from "../config/razorpay.js";
import { toRupees, toPaise } from "../utils/security.js";
import {
    requestCancellation,
    recordCourierOutcome,
    completeCancellation,
    releaseReservation,
    claimRefundIntent,
    recordRefundInitiation,
    finalizeRefundState,
    adoptGatewayRefund,
    enqueueShippingEmail,
    backoffDate,
    WORKER_ID,
} from "./orderLifecycle.js";
import {
    findPaymentRefunds,
    refundOutcome,
    REFUND_LIST_OUTCOME,
} from "./razorpayProvider.js";

export const CANCELLATION_POLICIES = {
    FULL_REFUND: "full_refund",
};

// Store owner policy: Zero cancellation fees, 100% full refund of remaining captured payment
export const ACTIVE_CANCELLATION_POLICY = CANCELLATION_POLICIES.FULL_REFUND;

/**
 * Calculate refundable amount according to commercial policy.
 * Eligible cancellations carry no cancellation fee.
 * Formula: capturedAmountPaise - successfullyProcessedRefundsPaise.
 */
export function calculateCancellationRefund(order, policy = ACTIVE_CANCELLATION_POLICY) {
    const isPrepaid = order?.payment?.method && order.payment.method !== "cod";
    if (!isPrepaid || order?.payment?.status !== "paid") {
        return {
            refundablePaise: 0,
            feePaise: 0,
            policyApplied: policy,
            isPrepaid: false,
            capturedPaise: 0,
            alreadyRefundedPaise: 0,
        };
    }

    const capturedRaw = order.payment.amountPaid > 0
        ? order.payment.amountPaid
        : Math.round(Number(order.pricing?.total || 0) * 100);

    const capturedPaise = Number.isFinite(capturedRaw) && capturedRaw > 0 ? Math.round(capturedRaw) : 0;
    const refundedRaw = Number(order.payment?.refundedAmount) || 0;
    const alreadyRefundedPaise = Number.isFinite(refundedRaw) && refundedRaw > 0 ? Math.round(refundedRaw) : 0;

    // No cancellation fees or deductions under confirmed business policy
    const feePaise = 0;
    const netRefundablePaise = Math.max(0, capturedPaise - alreadyRefundedPaise);

    return {
        refundablePaise: netRefundablePaise,
        feePaise,
        policyApplied: policy,
        isPrepaid: true,
        capturedPaise,
        alreadyRefundedPaise,
    };
}

/**
 * Centralized eligibility evaluator.
 * Determines whether a customer (or admin) can cancel an order.
 */
export function evaluateCancellationEligibility(order, { isCustomer = true } = {}) {
    if (!order) {
        return { canCancel: false, reasonCode: "not_found", cannotCancelReason: "Order not found." };
    }

    // 1. Terminal states
    if (order.status === "cancelled" || order.cancellation?.status === "completed") {
        return {
            canCancel: false,
            reasonCode: "already_cancelled",
            cannotCancelReason: "This order has already been cancelled.",
        };
    }

    if (order.status === "returned" || order.reservation?.state === "return_restored") {
        return {
            canCancel: false,
            reasonCode: "order_returned",
            cannotCancelReason: "This order has already been returned.",
        };
    }

    if (order.status === "delivered") {
        return {
            canCancel: false,
            reasonCode: "order_delivered",
            cannotCancelReason: "Delivered orders cannot be cancelled. You may request a return if eligible.",
        };
    }

    // 2. Physical dispatch check: Cannot cancel if parcel has already left
    const isDispatchedStatus = ["shipped", "in_transit", "out_for_delivery"].includes(order.status);
    const isDispatchedReservation = ["return_pending", "return_restored"].includes(order.reservation?.state);

    if (isDispatchedStatus || isDispatchedReservation) {
        return {
            canCancel: false,
            reasonCode: "already_dispatched",
            cannotCancelReason: "Cancellation is not available because your order has already been dispatched. You may initiate a return after delivery.",
        };
    }

    // 3. Existing cancellation intent checks
    if (order.cancellation?.status === "requested") {
        if (order.cancellation.courierOutcome === "uncertain") {
            return {
                canCancel: false,
                reasonCode: "confirmation_pending",
                cannotCancelReason: "Cancellation request is currently awaiting courier confirmation.",
            };
        }
        if (order.cancellation.courierOutcome === "failed") {
            return {
                canCancel: false,
                reasonCode: "courier_rejected",
                cannotCancelReason: "Cancellation could not be completed with the courier as the shipment has progressed.",
            };
        }
        return {
            canCancel: false,
            reasonCode: "already_requested",
            cannotCancelReason: "A cancellation request has already been submitted for this order.",
        };
    }

    // 4. Guest checkout constraints for customer route
    if (isCustomer && order.isGuest) {
        return {
            canCancel: false,
            reasonCode: "guest_order",
            cannotCancelReason: "Guest orders cannot be cancelled online. Please contact customer care with your order details.",
        };
    }

    return {
        canCancel: true,
        reasonCode: "eligible",
        cannotCancelReason: null,
    };
}

/**
 * Build customer-safe cancellation summary.
 */
export function buildCustomerCancellationSummary(order) {
    if (!order) return null;
    const { canCancel, cannotCancelReason, reasonCode } = evaluateCancellationEligibility(order, { isCustomer: true });
    return {
        canCancel,
        cannotCancelReason,
        reasonCode,
        status: order.cancellation?.status || "none",
        requestedAt: order.cancellation?.requestedAt || null,
        resolvedAt: order.cancellation?.resolvedAt || null,
        courierOutcome: order.cancellation?.courierOutcome || null,
        reason: order.cancellation?.reason || null,
    };
}

/**
 * Build customer-safe refund summary.
 */
export function buildCustomerRefundSummary(order) {
    if (!order) return null;
    const isPrepaid = order.payment?.method && order.payment.method !== "cod";
    if (!isPrepaid) {
        return null;
    }

    const hasRefundRecord = !!order.refund?.status || !!order.refund?.razorpayRefundId;
    const isPaymentRefunded = order.payment?.status === "refunded" || (order.payment?.refundedAmount || 0) > 0;
    const isCancelled = order.status === "cancelled" || order.cancellation?.status === "completed";

    if (!hasRefundRecord && !isPaymentRefunded && !isCancelled && order.payment?.status !== "paid") {
        return null;
    }

    let status = order.refund?.status || null;
    if (!status) {
        if (order.payment?.status === "refunded") {
            status = "processed";
        } else if (isCancelled && order.payment?.status === "paid") {
            status = "pending";
        }
    }

    const amountPaise = order.refund?.amountPaise ||
        order.refund?.requestedAmountPaise ||
        order.payment?.refundedAmount ||
        (order.payment?.status === "paid" ? (order.payment?.amountPaid || Math.round(Number(order.pricing?.total || 0) * 100)) : 0);

    return {
        status, // "requested" | "pending" | "processed" | "failed" | null
        amountPaise,
        amountRupees: toRupees(amountPaise),
        currency: "INR",
        initiatedAt: order.refund?.initiatedAt || null,
        verifiedAt: order.refund?.verifiedAt || null,
        finalized: order.refund?.finalized || false,
        paymentMethod: order.payment?.method || "prepaid",
        notice: status === "processed"
            ? "Refund has been processed by our payment gateway. Bank credit typically reflects in 5-7 business days."
            : status === "failed"
            ? "Refund processing encountered an issue. Our support team is reviewing it."
            : "Refund will be initiated to your original payment method.",
    };
}

/**
 * Reconcile a stored refund with Razorpay.
 */
export async function reconcileRefund(order) {
    if (!razorpayInstance || !order.refund?.razorpayRefundId) return;
    if (order.refund.finalized) return;
    try {
        const fresh = await razorpayInstance.refunds.fetch(order.refund.razorpayRefundId);
        const gw = refundOutcome(fresh);
        if (gw === "processed" || gw === "failed") {
            await finalizeRefundState(order._id, {
                providerStatus: gw,
                leaseOwner: order.refund.leaseOwner || undefined,
            });
            const reloaded = await Order.findById(order._id);
            if (reloaded) {
                order.refund = reloaded.refund;
                order.payment = reloaded.payment;
            }
        }
    } catch (err) {
        console.error(`[Refund] Reconcile fetch failed for ${order.orderId}:`, err.message);
    }
}

/**
 * Recover a refund the gateway created but wasn't saved locally.
 */
export async function adoptOrphanRefund(order) {
    if (!razorpayInstance || !order.payment?.razorpayPaymentId) return null;
    const res = await findPaymentRefunds(razorpayInstance, order.payment.razorpayPaymentId);
    if (res.outcome !== REFUND_LIST_OUTCOME.FOUND) return null;
    const known = order.refund?.razorpayRefundId;
    const orphan = res.refunds
        .filter((r) => r.id !== known && ["processed", "pending", "written_out"].includes(r.status))
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
    if (!orphan) return null;
    await adoptGatewayRefund(order._id, {
        refundId: orphan.id,
        amountPaise: orphan.amount,
        gatewayStatus: refundOutcome(orphan),
        createdAt: orphan.created_at,
    });
    const fresh = await Order.findById(order._id);
    if (fresh) {
        order.refund = fresh.refund;
        order.payment = fresh.payment;
    }
    return fresh?.refund || null;
}

/**
 * Initiate an online refund for a paid order.
 */
export async function refundPaidOrder(order, reason = "Order cancelled") {
    if (order.payment.status !== "paid" || !order.payment.razorpayPaymentId) {
        throw new AppError("Only a successfully paid order can be refunded.", 400);
    }
    if (!razorpayInstance) {
        throw new AppError("Payment gateway is not configured.", 500);
    }

    if (order.refund?.razorpayRefundId && ["requested", "pending", "processed"].includes(order.refund.status)) {
        await reconcileRefund(order);
        const s = order.refund?.status;
        if (s === "processed") throw new AppError("This order has already been refunded.", 400);
        if (s === "pending" || s === "requested") throw new AppError("A refund is already in progress for this order.", 400);
    }

    const { refundablePaise } = calculateCancellationRefund(order);
    if (refundablePaise <= 0) {
        throw new AppError("No refundable captured amount remains (or a refund is already in flight).", 400);
    }

    const claim = await claimRefundIntent(order._id, {});
    if (!claim) {
        throw new AppError("No refundable captured amount remains (or another worker holds the refund claim).", 400);
    }
    const leaseOwner = claim.order.refund.leaseOwner;

    let refund;
    try {
        refund = await razorpayInstance.payments.refund(order.payment.razorpayPaymentId, { amount: refundablePaise });
    } catch (err) {
        console.error(`[Refund] Initiation uncertain for ${order.orderId}:`, err.message);
        throw new AppError("Refund initiation is being confirmed. Do not repeat this action — it will reconcile automatically.", 502);
    }

    const gw = refundOutcome(refund);
    await recordRefundInitiation(order._id, {
        refundId: refund.id,
        gatewayStatus: gw,
        amountPaise: refund.amount || refundablePaise,
        leaseOwner,
    });

    if (gw === "processed") {
        await finalizeRefundState(order._id, { providerStatus: "processed", leaseOwner });
    }

    const fresh = await Order.findById(order._id);
    if (fresh) {
        order.refund = fresh.refund;
        order.payment = fresh.payment;
    }
    return refund;
}

/**
 * SHARED CANCELLATION ENGINE
 * Executes cancellation with explicit lifecycle steps:
 * 1. Eligibility validation (atomic)
 * 2. Intent recording
 * 3. Courier cancellation
 * 4. Gated inventory release
 * 5. Conditional online refund
 * 6. Completion or durable hold
 */
export async function processOrderCancellation(orderId, { reason = "Order cancelled", cancelledBy = "customer", actorId = null } = {}) {
    const order = await Order.findById(orderId);
    if (!order) {
        throw new AppError("Order not found", 404);
    }

    const isCustomer = cancelledBy === "customer";
    const eligibility = evaluateCancellationEligibility(order, { isCustomer });

    if (!eligibility.canCancel) {
        if (eligibility.reasonCode === "already_cancelled") {
            return {
                success: true,
                alreadyCancelled: true,
                finalized: true,
                courierOutcome: order.cancellation?.courierOutcome || "not_needed",
                order,
                message: "Order is already cancelled.",
            };
        }
        if (eligibility.reasonCode === "confirmation_pending") {
            return {
                success: true,
                confirmationPending: true,
                finalized: false,
                courierOutcome: "uncertain",
                order,
                message: eligibility.cannotCancelReason,
            };
        }
        throw new AppError(eligibility.cannotCancelReason || "Order is not eligible for cancellation.", 400);
    }

    // 1. Record cancellation intent atomically
    const formattedReason = reason || `Order cancelled by ${cancelledBy}`;
    await requestCancellation(order._id, { reason: formattedReason });
    await Order.updateOne(
        { _id: order._id },
        {
            $set: {
                "cancellation.requestedBy": cancelledBy,
                "cancellation.nextAttemptAt": new Date(),
                "cancellation.attempts": 1,
            },
        }
    );

    // 2. Assess courier status
    let courierOutcome = "not_needed";
    const hasShipment = !!order.shiprocket?.orderId;
    const isFulfillmentActive =
        ["create_uncertain", "needs_reconciliation"].includes(order.fulfillment?.stage) ||
        (order.fulfillment?.lockUntil && new Date(order.fulfillment.lockUntil) > new Date());

    if (hasShipment) {
        const cancelResult = await shiprocket.cancelShiprocketOrder(order.shiprocket.orderId);
        courierOutcome = cancelResult.outcome; // "confirmed" | "failed" | "uncertain"

        if (courierOutcome === "uncertain") {
            await Order.updateOne(
                { _id: order._id },
                {
                    $push: {
                        timeline: {
                            status: "Courier Cancel Uncertain",
                            description: `Shiprocket cancel returned uncertain (${cancelResult.error || cancelResult.message || "Timeout/Network"}). Verification pending.`,
                            date: new Date(),
                        },
                    },
                }
            );
        } else if (courierOutcome === "failed") {
            await Order.updateOne(
                { _id: order._id },
                {
                    $push: {
                        timeline: {
                            status: "Courier Cancel Failed",
                            description: `Shiprocket refused cancellation (${cancelResult.message || cancelResult.error || "Parcel already dispatched"}).`,
                            date: new Date(),
                        },
                    },
                }
            );
        }
    } else if (isFulfillmentActive) {
        courierOutcome = "uncertain";
        await Order.updateOne(
            { _id: order._id },
            {
                $set: { "fulfillment.stage": "needs_reconciliation" },
                $push: {
                    timeline: {
                        status: "Cancellation Pending Reconciliation",
                        description: "Fulfillment creation in progress; courier status uncertain pending reconciliation.",
                        date: new Date(),
                    },
                },
            }
        );
    } else {
        courierOutcome = "not_needed";
    }

    await recordCourierOutcome(order._id, courierOutcome);

    // 3. Inventory release ONLY on verified courier stop or not_needed
    let releasedReservation = false;
    if (courierOutcome === "confirmed" || courierOutcome === "not_needed") {
        const relRes = await releaseReservation(order._id, { reason: "cancelled" });
        releasedReservation = relRes.released;
    }

    // 4. Refund paid prepaid order ONLY on verified clear outcomes
    let refund = null;
    if (order.payment?.status === "paid") {
        if (courierOutcome === "not_needed" || courierOutcome === "confirmed") {
            try {
                const freshOrder = await Order.findById(order._id);
                refund = await refundPaidOrder(freshOrder, formattedReason);
            } catch (rErr) {
                console.error(`[Cancellation] Refund initiation error for ${order.orderId}:`, rErr.message);
                await Order.updateOne(
                    { _id: order._id },
                    {
                        $push: {
                            timeline: {
                                status: "Refund Pending",
                                description: `Order cancelled but refund needs reconciliation (${String(rErr.message).slice(0, 100)}).`,
                                date: new Date(),
                            },
                        },
                    }
                );
            }
        } else {
            await Order.updateOne(
                { _id: order._id },
                {
                    $push: {
                        timeline: {
                            status: "Refund Held",
                            description: "Courier cancellation unconfirmed — refund deferred until parcel stop is verified.",
                            date: new Date(),
                        },
                    },
                }
            );
        }
    }

    // 5. Finalize cancellation ONLY when confirmed or not_needed
    let finalized = false;
    if (courierOutcome === "confirmed" || courierOutcome === "not_needed") {
        await completeCancellation(order._id);
        await enqueueShippingEmail(order._id, "cancelled");
        finalized = true;
    } else {
        // Uncertain or failed courier outcome: retain fulfillment hold
        await Order.updateOne(
            { _id: order._id },
            {
                $set: {
                    "fulfillmentHold.active": true,
                    "fulfillmentHold.reason": `Cancellation unconfirmed (${courierOutcome})`,
                    "cancellation.nextAttemptAt": courierOutcome === "uncertain" ? backoffDate(1) : null,
                    "cancellation.resolvedAt": courierOutcome === "failed" ? new Date() : null,
                },
            }
        );
    }

    const fresh = await Order.findById(order._id);

    return {
        success: true,
        finalized,
        confirmationPending: !finalized && courierOutcome === "uncertain",
        courierOutcome,
        refund,
        releasedReservation,
        order: fresh,
        message: finalized
            ? (refund ? `Order cancelled — refund ${refund.status}` : "Order cancelled successfully.")
            : (courierOutcome === "failed"
                ? "Order cannot be cancelled: parcel is already with the courier or in transit."
                : "Cancellation requested — awaiting courier confirmation."),
    };
}

export default {
    CANCELLATION_POLICIES,
    ACTIVE_CANCELLATION_POLICY,
    calculateCancellationRefund,
    evaluateCancellationEligibility,
    buildCustomerCancellationSummary,
    buildCustomerRefundSummary,
    refundPaidOrder,
    reconcileRefund,
    adoptOrphanRefund,
    processOrderCancellation,
};

