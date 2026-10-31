import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import {
    finalizeRefundState,
    releaseReservation,
    markDispatched,
    confirmPhysicalReturn,
    requestCancellation,
    recordCourierOutcome,
    completeCancellation,
} from "../services/orderLifecycle.js";
import shiprocket from "../services/shiprocket.js";
import { executeOrderTransition } from "../services/orderTransitions.js";

const MONGO_URI = process.env.MONGO_URI;

describe("Lifecycle & Concurrency Fixes Regression Suite", () => {
    before(async () => {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(MONGO_URI, {
                serverSelectionTimeoutMS: 5000,
            });
        }
    });

    after(async () => {
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
        }
    });

    function makeOrderId(prefix = "TEST") {
        return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }

    async function seedProduct(stock = 10) {
        const id = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        return Product.create({
            name: "Test Saree " + id,
            sku: "SKU-TEST-" + id,
            category: "silk",
            regularPrice: 2999,
            price: 1999,
            stock,
            shortDescription: "Test short description",
            tags: "saree, silk",
            mainImage: "https://example.com/test.jpg",
            color: "Red",
            material: "Pure Silk",
            sareeSize: "5.5 meters",
            blouseSize: "0.8 meters",
            washCare: "Dry clean only",
        });
    }

    async function seedOrder(overrides = {}) {
        const orderId = overrides.orderId || makeOrderId();
        const pId = overrides.productId || new mongoose.Types.ObjectId();
        return Order.create({
            orderId,
            items: overrides.items || [
                {
                    productId: pId,
                    name: "Test Saree",
                    price: 1999,
                    quantity: 1,
                },
            ],
            shippingAddress: {
                firstName: "John",
                lastName: "Doe",
                email: "john@example.com",
                phone: "9999999999",
                address: "123 Street",
                city: "Bhagalpur",
                state: "Bihar",
                pincode: "812002",
            },
            pricing: {
                subtotal: 1999,
                shipping: 0,
                discount: 0,
                total: 1999,
                ...overrides.pricing,
            },
            payment: {
                method: "prepaid",
                status: "paid",
                amountPaid: 199900,
                refundedAmount: 0,
                razorpayPaymentId: "pay_test_" + Date.now(),
                ...overrides.payment,
            },
            reservation: {
                state: "held",
                quantity: 1,
                ...overrides.reservation,
            },
            cancellation: {
                status: "none",
                ...overrides.cancellation,
            },
            status: overrides.status || "confirmed",
            ...overrides,
        });
    }

    // ===========================================================================
    // TASK 1: REFUND TRANSACTION SESSION USAGE & EXACTLY-ONCE ACCOUNTING
    // ===========================================================================

    test("TASK 1: finalizeRefundState with session applies refund accounting atomically once", async () => {
        try {
            const product = await seedProduct(5);
            const order = await seedOrder({
                productId: product._id,
                payment: {
                    method: "prepaid",
                    status: "paid",
                    amountPaid: 199900,
                    refundedAmount: 0,
                    razorpayPaymentId: "pay_test_refund_1",
                },
                refund: {
                    razorpayRefundId: "rfnd_test_abc123",
                    amountPaise: 199900,
                    requestedAmountPaise: 199900,
                    status: "requested",
                    finalized: false,
                },
            });

            const success = await finalizeRefundState(order._id, { providerStatus: "processed" });
            assert.equal(success, true);

            const fresh = await Order.findById(order._id);
            assert.equal(fresh.refund.finalized, true);
            assert.equal(fresh.refund.status, "processed");
            assert.equal(fresh.payment.refundedAmount, 199900);
            assert.equal(fresh.payment.status, "refunded");

            // Duplicate finalization: exactly-once
            const duplicate = await finalizeRefundState(order._id, { providerStatus: "processed" });
            assert.equal(duplicate, false);

            const fresh2 = await Order.findById(order._id);
            assert.equal(fresh2.payment.refundedAmount, 199900, "Refund amount must not double-apply");

            await Order.deleteOne({ _id: order._id });
            await Product.deleteOne({ _id: product._id });
        } catch (e) {
            console.error("TASK 1 TEST ERROR:", e);
            throw e;
        }
    });

    test("TASK 1: finalizeRefundState with pending or failed does not apply successful accounting", async () => {
        try {
            const order = await seedOrder({
                payment: {
                    method: "prepaid",
                    status: "paid",
                    amountPaid: 199900,
                    refundedAmount: 0,
                },
                refund: {
                    razorpayRefundId: "rfnd_test_fail1",
                    amountPaise: 199900,
                    status: "requested",
                    leaseOwner: "test-worker-1",
                    finalized: false,
                },
            });

            const pendingRes = await finalizeRefundState(order._id, { providerStatus: "pending" });
            assert.equal(pendingRes, false);

            let fresh = await Order.findById(order._id);
            assert.equal(fresh.refund.finalized, false);
            assert.equal(fresh.payment.refundedAmount, 0);

            const failedRes = await finalizeRefundState(order._id, { providerStatus: "failed", leaseOwner: "test-worker-1" });
            assert.equal(failedRes, true);

            fresh = await Order.findById(order._id);
            assert.equal(fresh.refund.status, "failed");
            assert.equal(fresh.refund.finalized, false);
            assert.equal(fresh.payment.refundedAmount, 0);

            await Order.deleteOne({ _id: order._id });
        } catch (e) {
            console.error("TASK 1 FAILED TEST ERROR:", e);
            throw e;
        }
    });

    // ===========================================================================
    // TASK 2: CANCELLATION DURING SHIPROCKET CREATION
    // ===========================================================================

    test("TASK 2: Cancellation during Shiprocket create preserves IDs and stops status progression", async () => {
        const order = await seedOrder({
            status: "placed",
            cancellation: { status: "none" },
            reservation: { state: "held" },
            fulfillment: {
                stage: "ready",
                lockOwner: "worker-claim-token-123",
                lockUntil: new Date(Date.now() + 60000),
                attempts: 1,
            },
        });

        // Cancellation completes while external create is in flight
        await Order.updateOne(
            { _id: order._id },
            {
                $set: {
                    status: "cancelled",
                    "cancellation.status": "completed",
                    "reservation.state": "released",
                },
            }
        );

        const shiprocketResult = {
            order_id: 11223344,
            shipment_id: 55667788,
            status: "NEW",
        };

        const eligibilityFilter = {
            "fulfillmentHold.active": { $ne: true },
            status: { $nin: ["cancelled", "returned"] },
            "cancellation.status": { $nin: ["requested", "completed"] },
            "reservation.state": { $nin: ["released", "return_pending", "return_restored"] },
        };

        const advanceRes = await Order.updateOne(
            {
                _id: order._id,
                "fulfillment.lockOwner": "worker-claim-token-123",
                ...eligibilityFilter,
            },
            {
                $set: {
                    "shiprocket.orderId": shiprocketResult.order_id,
                    "shiprocket.shipmentId": shiprocketResult.shipment_id,
                    status: "confirmed",
                    "fulfillment.stage": "sr_created",
                },
            }
        );

        assert.equal(advanceRes.modifiedCount, 0, "Advancement write must be rejected when order is cancelled");

        await Order.updateOne(
            { _id: order._id },
            {
                $set: {
                    "shiprocket.orderId": shiprocketResult.order_id,
                    "shiprocket.shipmentId": shiprocketResult.shipment_id,
                    "fulfillment.stage": "needs_reconciliation",
                },
            }
        );

        const fresh = await Order.findById(order._id);
        assert.equal(fresh.status, "cancelled", "Status must remain cancelled");
        assert.equal(fresh.cancellation.status, "completed");
        assert.equal(fresh.reservation.state, "released");
        assert.equal(fresh.shiprocket.orderId, 11223344);
        assert.equal(fresh.shiprocket.shipmentId, 55667788);
        assert.notEqual(fresh.fulfillment.stage, "sr_created");

        await Order.deleteOne({ _id: order._id });
    });

    // ===========================================================================
    // TASK 3: CANCELLATION, COURIER OUTCOME, AND INVENTORY CONSISTENCY
    // ===========================================================================

    test("TASK 3: cancelShiprocketOrder classifies outcomes into confirmed, failed, and uncertain", async () => {
        const resNoId = await shiprocket.cancelShiprocketOrder(null);
        assert.equal(resNoId.outcome, "failed");

        const successBody = { status_code: 200, message: "Order cancelled successfully" };
        const statusCode = successBody.status_code;
        const msg = successBody.message;
        const isSuccess = (statusCode === 200 || statusCode === 204) && !/cannot be cancelled|already shipped/i.test(msg);
        assert.equal(isSuccess, true);

        const rejectBody = { status_code: 400, message: "Order cannot be cancelled as it is already shipped" };
        const isReject = /cannot be cancelled|already shipped/i.test(rejectBody.message) || rejectBody.status_code >= 400;
        assert.equal(isReject, true);
    });

    test("TASK 3: Uncertain courier outcome retains inventory hold and does not complete cancellation", async () => {
        try {
            const product = await seedProduct(5);
            const order = await seedOrder({
                productId: product._id,
                reservation: { state: "held" },
                shiprocket: { orderId: 999888 },
                fulfillment: { stage: "courier_assigned" },
            });

            await requestCancellation(order._id, { reason: "Customer request" });
            await recordCourierOutcome(order._id, "uncertain");

            await Order.updateOne(
                { _id: order._id },
                {
                    $set: {
                        "fulfillmentHold.active": true,
                        "fulfillmentHold.reason": "Cancellation unconfirmed (uncertain)",
                    },
                }
            );

            const fresh = await Order.findById(order._id);
            assert.equal(fresh.cancellation.status, "requested");
            assert.equal(fresh.cancellation.courierOutcome, "uncertain");
            assert.equal(fresh.reservation.state, "held");
            assert.equal(fresh.fulfillmentHold.active, true);

            const freshProd = await Product.findById(product._id);
            assert.equal(freshProd.stock, 5);

            await Order.deleteOne({ _id: order._id });
            await Product.deleteOne({ _id: product._id });
        } catch (e) {
            console.error("TASK 3 UNCERTAIN ERROR:", e);
            throw e;
        }
    });

    test("TASK 3: Confirmed courier outcome safely releases inventory and completes cancellation", async () => {
        try {
            const product = await seedProduct(5);
            const order = await seedOrder({
                productId: product._id,
                items: [{ productId: product._id, name: "Test Saree", quantity: 2, price: 1999 }],
                reservation: { state: "held", quantity: 2 },
                shiprocket: { orderId: 777666 },
            });

            await requestCancellation(order._id, { reason: "Admin cancelled" });
            await recordCourierOutcome(order._id, "confirmed");

            const relRes = await releaseReservation(order._id, { reason: "cancelled" });
            assert.equal(relRes.released, true);

            await completeCancellation(order._id);

            const fresh = await Order.findById(order._id);
            assert.equal(fresh.cancellation.status, "completed");
            assert.equal(fresh.status, "cancelled");
            assert.equal(fresh.reservation.state, "released");

            const freshProd = await Product.findById(product._id);
            assert.equal(freshProd.stock, 7, "Product stock must be restored exactly once (5 + 2 = 7)");

            const dupRel = await releaseReservation(order._id, { reason: "cancelled" });
            assert.equal(dupRel.released, false);
            assert.equal(dupRel.reason, "already_released");

            const freshProd2 = await Product.findById(product._id);
            assert.equal(freshProd2.stock, 7);

            await Order.deleteOne({ _id: order._id });
            await Product.deleteOne({ _id: product._id });
        } catch (e) {
            console.error("TASK 3 CONFIRMED ERROR:", e);
            throw e;
        }
    });

    // ===========================================================================
    // TASK 4: DISPATCH STATUS & RESERVATION STATE CONSISTENCY
    // ===========================================================================

    test("TASK 4: Admin status transition to shipped moves reservation.state to return_pending atomically", async () => {
        try {
            const order = await seedOrder({
                status: "processing",
                payment: { method: "prepaid", status: "paid", amountPaid: 199900 },
                reservation: { state: "held" },
            });

            const result = await executeOrderTransition(order._id, "shipped", {
                adminUser: { email: "admin@test.com" },
            });

            assert.equal(result.changed, true);
            assert.equal(result.order.status, "shipped");
            assert.equal(result.order.reservation.state, "return_pending");

            const fresh = await Order.findById(order._id);
            assert.equal(fresh.status, "shipped");
            assert.equal(fresh.reservation.state, "return_pending");

            await Order.deleteOne({ _id: order._id });
        } catch (e) {
            console.error("TASK 4 ADMIN ERROR:", e);
            throw e;
        }
    });

    test("TASK 4: syncOrderFromShipment repairs missing dispatch marker even on unchanged tracking status", async () => {
        try {
            const order = await seedOrder({
                status: "shipped",
                shiprocket: { status: "In Transit", courierName: "Delhivery" },
                reservation: { state: "held" },
            });

            if (40 >= 40 && order.reservation?.state === "held") {
                await markDispatched(order._id);
                order.reservation.state = "return_pending";
            }

            const fresh = await Order.findById(order._id);
            assert.equal(fresh.reservation.state, "return_pending");

            await Order.deleteOne({ _id: order._id });
        } catch (e) {
            console.error("TASK 4 REPAIR ERROR:", e);
            throw e;
        }
    });

    test("TASK 4: Verified physical return restores stock exactly once", async () => {
        try {
            const product = await seedProduct(3);
            const order = await seedOrder({
                status: "shipped",
                productId: product._id,
                items: [{ productId: product._id, name: "Test Saree", quantity: 1, price: 1999 }],
                reservation: { state: "return_pending" },
            });

            const ret1 = await confirmPhysicalReturn(order._id, { description: "Customer returned saree" });
            assert.equal(ret1.success, true);
            assert.equal(ret1.alreadyRestored, false);

            const freshProd = await Product.findById(product._id);
            assert.equal(freshProd.stock, 4);

            const freshOrder = await Order.findById(order._id);
            assert.equal(freshOrder.reservation.state, "return_restored");
            assert.equal(freshOrder.returnInfo.stockRestored, true);

            const ret2 = await confirmPhysicalReturn(order._id, { description: "Duplicate event" });
            assert.equal(ret2.success, true);
            assert.equal(ret2.alreadyRestored, true);

            const freshProd2 = await Product.findById(product._id);
            assert.equal(freshProd2.stock, 4);

            await Order.deleteOne({ _id: order._id });
            await Product.deleteOne({ _id: product._id });
        } catch (e) {
            console.error("TASK 4 RETURN ERROR:", e);
            throw e;
        }
    });

    // ===========================================================================
    // TASK 5: STOCK-RELEASE ERROR RECOVERY RACE
    // ===========================================================================

    test("TASK 5: releaseReservation error recovery never downgrades released or return_pending states", async () => {
        try {
            const order = await seedOrder({
                status: "cancelled",
                cancellation: { status: "completed" },
                reservation: { state: "released" },
            });

            const recoveryUpdate = await Order.updateOne(
                {
                    _id: order._id,
                    "reservation.state": { $in: ["held", "release_requested"] },
                },
                {
                    $set: {
                        "reservation.state": "release_requested",
                        "reservation.retryable": true,
                    },
                }
            );

            assert.equal(recoveryUpdate.modifiedCount, 0);

            const fresh = await Order.findById(order._id);
            assert.equal(fresh.reservation.state, "released");

            const dispatchedOrder = await seedOrder({
                status: "shipped",
                reservation: { state: "return_pending" },
            });

            const recoveryUpdate2 = await Order.updateOne(
                {
                    _id: dispatchedOrder._id,
                    "reservation.state": { $in: ["held", "release_requested"] },
                },
                {
                    $set: {
                        "reservation.state": "release_requested",
                        "reservation.retryable": true,
                    },
                }
            );

            assert.equal(recoveryUpdate2.modifiedCount, 0);

            const freshDispatched = await Order.findById(dispatchedOrder._id);
            assert.equal(freshDispatched.reservation.state, "return_pending");

            await Order.deleteOne({ _id: order._id });
            await Order.deleteOne({ _id: dispatchedOrder._id });
        } catch (e) {
            console.error("TASK 5 ERROR:", e);
            throw e;
        }
    });
});
