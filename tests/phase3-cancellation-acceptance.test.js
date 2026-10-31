import "dotenv/config";
import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import User from "../models/userModal.js";
import orderController from "../controllers/orderController.js";
import shiprocket from "../services/shiprocket.js";
import razorpayInstance from "../config/razorpay.js";
import {
    processOrderCancellation,
    evaluateCancellationEligibility,
    calculateCancellationRefund,
    reconcileRefund,
} from "../services/orderCancellation.js";
import {
    claimCancellation,
    reconcileSingleCancellation,
    releaseCancellationClaim,
} from "../services/cancellationWorker.js";
import {
    confirmPaymentCaptured,
    finalizeRefundState,
    recordRefundInitiation,
} from "../services/orderLifecycle.js";
import AppError from "../utils/AppError.js";

const MONGO_URI = process.env.TEST_MONGO_URI || (
    process.env.MONGO_URI ? process.env.MONGO_URI.replace(/\/([^\/?]+)(\?|$)/, '/$1_test$2') : null
);

describe("PHASE 3: Customer Cancellation and Refund Lifecycle Acceptance Suite", () => {
    let userA, userB;
    let originalCancelShiprocket;
    let originalRzpRefund;
    let originalRzpFetchRefund;

    before(async () => {
        if (!MONGO_URI) throw new Error("MONGO_URI not configured");
        await mongoose.connect(MONGO_URI);

        const suffix = Date.now();
        userA = await User.create({
            name: "Customer A",
            email: `custA_${suffix}@example.com`,
            phone: "9111111111",
            role: "user",
        });

        userB = await User.create({
            name: "Customer B",
            email: `custB_${suffix}@example.com`,
            phone: "9222222222",
            role: "user",
        });

        // Backup provider functions for restoration
        originalCancelShiprocket = shiprocket.cancelShiprocketOrder;
        originalRzpRefund = razorpayInstance ? razorpayInstance.payments.refund : null;
        originalRzpFetchRefund = razorpayInstance ? razorpayInstance.refunds.fetch : null;
    });

    after(async () => {
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
        }
    });

    afterEach(() => {
        // Restore mocks
        shiprocket.cancelShiprocketOrder = originalCancelShiprocket;
        if (razorpayInstance) {
            razorpayInstance.payments.refund = originalRzpRefund;
            razorpayInstance.refunds.fetch = originalRzpFetchRefund;
        }
    });

    function makeId() {
        return `P3-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }

    async function seedProduct(stock = 10) {
        const id = makeId();
        return Product.create({
            name: "Phase 3 Saree " + id,
            sku: "SKU-" + id,
            category: "silk",
            regularPrice: 2999,
            price: 1999,
            stock,
            shortDescription: "Phase 3 test saree",
            tags: "saree, silk, test",
            mainImage: "https://example.com/saree.jpg",
            color: "Blue",
            material: "Silk",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean",
        });
    }

    test("1. Customer cannot cancel another customer's order (returns 404)", async () => {
        const prod = await seedProduct(5);
        const orderOfA = await Order.create({
            orderId: makeId(),
            user: userA._id,
            isGuest: false,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "A", email: userA.email, phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "placed",
            reservation: { state: "held" },
        });

        // User B attempts to cancel User A's order
        const req = {
            params: { id: orderOfA._id.toString() },
            user: userB,
            body: { reason: "Customer B wants to cancel A's order" },
        };
        let resJson = null;
        let statusCode = 200;
        const res = {
            status: (code) => { statusCode = code; return res; },
            json: (data) => { resJson = data; return res; },
        };

        await assert.rejects(
            async () => {
                await orderController.cancelUserOrder(req, res);
            },
            (err) => {
                assert.equal(err.statusCode, 404, "Must return 404 when customer does not own order");
                return true;
            }
        );

        // Verify order remains untouched
        const fresh = await Order.findById(orderOfA._id);
        assert.equal(fresh.status, "placed");
        assert.equal(fresh.cancellation?.status, "none");
    });

    test("2. Customer cannot cancel guest order via customer endpoint", async () => {
        const prod = await seedProduct(5);
        const guestOrder = await Order.create({
            orderId: makeId(),
            isGuest: true,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "Guest", email: "guest@example.com", phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "placed",
            reservation: { state: "held" },
        });

        const req = {
            params: { id: guestOrder._id.toString() },
            user: userA,
            body: { reason: "Trying to cancel guest order" },
        };
        const res = { status: () => res, json: () => res };

        await assert.rejects(
            async () => {
                await orderController.cancelUserOrder(req, res);
            },
            (err) => {
                assert.equal(err.statusCode, 404, "Guest orders must not be accessible via customer cancel route");
                return true;
            }
        );
    });

    test("3. Eligible COD cancellation restores product stock exactly once and has 0 refund", async () => {
        const prod = await seedProduct(8);
        const order = await Order.create({
            orderId: makeId(),
            user: userA._id,
            isGuest: false,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 2 }],
            shippingAddress: { firstName: "A", email: userA.email, phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending", amountPaid: 0 },
            pricing: { subtotal: 3998, total: 3998 },
            status: "placed",
            reservation: { state: "held" },
        });

        const req = {
            params: { id: order._id.toString() },
            user: userA,
            body: { reason: "Changed my mind" },
        };
        let resJson = null;
        let statusCode = 200;
        const res = {
            status: (code) => { statusCode = code; return res; },
            json: (data) => { resJson = data; return res; },
        };

        await orderController.cancelUserOrder(req, res);
        assert.equal(statusCode, 200);
        assert.equal(resJson.finalized, true);
        assert.equal(resJson.order.status, "cancelled");
        assert.equal(resJson.order.cancellation.status, "completed");
        assert.equal(resJson.refund, null, "COD cancellation must have null refund summary");

        // Verify product stock incremented by 2
        const updatedProd = await Product.findById(prod._id);
        assert.equal(updatedProd.stock, 10);
    });

    test("4. Eligible prepaid cancellation refunds captured amount in full (no cancellation fee)", async () => {
        const prod = await seedProduct(6);
        const order = await Order.create({
            orderId: makeId(),
            user: userA._id,
            isGuest: false,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "A", email: userA.email, phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "card", status: "paid", amountPaid: 199900, razorpayPaymentId: "pay_test_phase3_1" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "placed",
            reservation: { state: "held" },
        });

        let refundAmountRequested = 0;
        razorpayInstance.payments.refund = async (payId, opts) => {
            refundAmountRequested = opts.amount;
            return {
                id: "rfnd_test_p3_1",
                payment_id: payId,
                amount: opts.amount,
                status: "processed",
            };
        };

        const result = await processOrderCancellation(order._id, {
            reason: "Customer cancelled prepaid order",
            cancelledBy: "customer",
        });

        assert.equal(result.finalized, true);
        assert.equal(refundAmountRequested, 199900, "Must refund 199900 paise without any fee deduction");

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.status, "cancelled");
        assert.equal(reloaded.cancellation.status, "completed");
        assert.equal(reloaded.payment.status, "refunded");
        assert.equal(reloaded.payment.refundedAmount, 199900);
        assert.equal(reloaded.refund.status, "processed");

        // Product stock restored
        const updatedProd = await Product.findById(prod._id);
        assert.equal(updatedProd.stock, 7);
    });

    test("5. Duplicate customer/admin cancellation requests converge safely without double stock or refunds", async () => {
        const prod = await seedProduct(4);
        const order = await Order.create({
            orderId: makeId(),
            user: userA._id,
            isGuest: false,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "A", email: userA.email, phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "placed",
            reservation: { state: "held" },
        });

        // Request 1
        const res1 = await processOrderCancellation(order._id, { reason: "Mistake", cancelledBy: "customer" });
        assert.equal(res1.finalized, true);

        const prodAfterFirst = await Product.findById(prod._id);
        assert.equal(prodAfterFirst.stock, 5);

        // Request 2 (Duplicate / concurrent)
        const res2 = await processOrderCancellation(order._id, { reason: "Mistake again", cancelledBy: "customer" });
        assert.equal(res2.alreadyCancelled, true);
        assert.equal(res2.finalized, true);

        // Product stock must NOT have incremented again
        const prodAfterSecond = await Product.findById(prod._id);
        assert.equal(prodAfterSecond.stock, 5);
    });

    test("6. Cancellation during active shipment creation sets uncertain courier outcome and holds order", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            user: userA._id,
            isGuest: false,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "A", email: userA.email, phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "processing",
            reservation: { state: "held" },
            fulfillment: {
                stage: "create_uncertain", // external creation was sent but not yet acknowledged
                lockUntil: new Date(Date.now() + 60000),
            },
        });

        const result = await processOrderCancellation(order._id, {
            reason: "Cancel while fulfillment in flight",
            cancelledBy: "customer",
        });

        assert.equal(result.finalized, false, "Must not finalize cancellation while courier creation is uncertain");
        assert.equal(result.confirmationPending, true);
        assert.equal(result.courierOutcome, "uncertain");

        // Reservation must NOT be released prematurely
        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.reservation.state, "held");
        assert.equal(reloaded.fulfillmentHold.active, true);
        assert.equal(reloaded.cancellation.status, "requested");
    });

    test("7. Definite courier rejection prevents cancellation and records explanation", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            user: userA._id,
            isGuest: false,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "A", email: userA.email, phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "processing",
            reservation: { state: "held" },
            shiprocket: { orderId: 888888 },
        });

        // Mock shiprocket rejecting cancellation because already picked up
        shiprocket.cancelShiprocketOrder = async () => ({
            outcome: "failed",
            statusCode: 400,
            message: "Order cannot be cancelled as it is already shipped",
        });

        const result = await processOrderCancellation(order._id, {
            reason: "Want to cancel",
            cancelledBy: "customer",
        });

        assert.equal(result.finalized, false);
        assert.equal(result.courierOutcome, "failed");
        assert.match(result.message, /already with the courier/i);

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.status, "processing", "Order status must not flip to cancelled");
        assert.equal(reloaded.reservation.state, "held", "Stock must not be released");
        assert.equal(reloaded.fulfillmentHold.active, true);
    });

    test("8. Restart during pending cancellation: worker picks up, reconciles, and finalizes", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            user: userA._id,
            isGuest: false,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "A", email: userA.email, phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "processing",
            reservation: { state: "held" },
            cancellation: {
                status: "requested",
                courierOutcome: "uncertain",
                nextAttemptAt: new Date(Date.now() - 5000), // Past due
                attempts: 1,
            },
            shiprocket: { orderId: 999111 },
        });

        // Simulate courier now succeeding on second attempt
        shiprocket.cancelShiprocketOrder = async () => ({
            outcome: "confirmed",
            statusCode: 200,
            message: "Order cancelled successfully",
        });

        const claimToken = "worker-restart-test-token";
        const claimed = await claimCancellation(order._id, claimToken);
        assert.ok(claimed, "Worker must claim past-due cancellation");

        const reconResult = await reconcileSingleCancellation(claimed, claimToken);
        assert.equal(reconResult.outcome, "completed");

        const finalizedOrder = await Order.findById(order._id);
        assert.equal(finalizedOrder.status, "cancelled");
        assert.equal(finalizedOrder.cancellation.status, "completed");
        assert.equal(finalizedOrder.reservation.state, "released");

        // Stock restored by 1
        const updatedProd = await Product.findById(prod._id);
        assert.equal(updatedProd.stock, 6);
    });

    test("9. Payment capture racing with/after cancellation sets manual refund review hold", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            user: userA._id,
            isGuest: false,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "A", email: userA.email, phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "upi", status: "pending", amountPaid: 0 },
            pricing: { subtotal: 1999, total: 1999 },
            status: "cancelled", // Already cancelled
            reservation: { state: "released" },
            cancellation: { status: "completed" },
        });

        // Late payment capture arrives from Razorpay webhook
        const captured = await confirmPaymentCaptured(order._id, {
            paymentId: "pay_racing_late_capture",
            amountPaise: 199900,
            source: "webhook",
        });

        // Must return null (does not schedule normal fulfillment)
        assert.equal(captured, null);

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.payment.status, "paid");
        assert.equal(reloaded.payment.amountPaid, 199900);
        assert.equal(reloaded.fulfillmentHold.active, true);
        assert.match(reloaded.fulfillmentHold.reason, /manual refund review/i);
        assert.equal(reloaded.status, "cancelled", "Order must remain cancelled");
    });

    test("10. Refund timeout followed by gateway reconciliation finalizes refund", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            user: userA._id,
            isGuest: false,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "A", email: userA.email, phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "card", status: "paid", amountPaid: 199900, refundedAmount: 0, razorpayPaymentId: "pay_test_timeout" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "cancelled",
            cancellation: { status: "completed" },
            refund: {
                status: "requested",
                razorpayRefundId: "rfnd_deferred_456",
                amountPaise: 199900,
                finalized: false,
            },
        });

        // Mock gateway returning processed on fetch
        razorpayInstance.refunds.fetch = async (rfndId) => ({
            id: rfndId,
            status: "processed",
            amount: 199900,
        });

        await reconcileRefund(order);

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.refund.status, "processed");
        assert.equal(reloaded.refund.finalized, true);
        assert.equal(reloaded.payment.status, "refunded");
        assert.equal(reloaded.payment.refundedAmount, 199900);
    });

    test("11. Duplicate refund events do NOT double accounting", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            user: userA._id,
            isGuest: false,
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "A", email: userA.email, phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "card", status: "paid", amountPaid: 199900, refundedAmount: 0 },
            pricing: { subtotal: 1999, total: 1999 },
            status: "cancelled",
            refund: {
                status: "pending",
                razorpayRefundId: "rfnd_duplicate_check",
                amountPaise: 199900,
                finalized: false,
            },
        });

        // Event 1
        const firstApplied = await finalizeRefundState(order._id, { providerStatus: "processed" });
        assert.equal(firstApplied, true);

        const orderAfterFirst = await Order.findById(order._id);
        assert.equal(orderAfterFirst.payment.refundedAmount, 199900);
        assert.equal(orderAfterFirst.refund.finalized, true);

        // Event 2 (duplicate webhook or replay)
        const secondApplied = await finalizeRefundState(order._id, { providerStatus: "processed" });
        assert.equal(secondApplied, false, "Second finalize must be ignored");

        const orderAfterSecond = await Order.findById(order._id);
        assert.equal(orderAfterSecond.payment.refundedAmount, 199900, "Refund amount must NOT double");
    });
});
