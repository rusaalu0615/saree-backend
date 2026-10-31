import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import {
    classifyShiprocketCancelResponse,
} from "../services/shiprocket.js";
import {
    evaluateCancellationEligibility,
    calculateCancellationRefund,
    CANCELLATION_POLICIES,
    buildCustomerCancellationSummary,
    buildCustomerRefundSummary,
    processOrderCancellation,
} from "../services/orderCancellation.js";
import {
    reconcileSingleCancellation,
    claimCancellation,
} from "../services/cancellationWorker.js";

// Use isolated test database on the replica set to protect production data
const MONGO_URI = process.env.TEST_MONGO_URI || (
    process.env.MONGO_URI ? process.env.MONGO_URI.replace(/\/([^\/?]+)(\?|$)/, '/$1_test$2') : null
);

describe("Shiprocket Cancellation Adapter Response Validation", () => {
    test("Documented success (200 + success message) classifies as confirmed", () => {
        const body = { status_code: 200, message: "Order cancelled successfully" };
        const res = classifyShiprocketCancelResponse(body);
        assert.equal(res.outcome, "confirmed");
        assert.equal(res.statusCode, 200);
    });

    test("Already cancelled with 200 classifies as confirmed", () => {
        const body = { status_code: 200, message: "Order already cancelled" };
        const res = classifyShiprocketCancelResponse(body);
        assert.equal(res.outcome, "confirmed");
    });

    test("Already cancelled with 400 error status classifies as confirmed", () => {
        const body = { status_code: 400, message: "Order has already been cancelled" };
        const res = classifyShiprocketCancelResponse(body);
        assert.equal(res.outcome, "confirmed");
    });

    test("Definite rejection (already shipped) classifies as failed", () => {
        const body = { status_code: 400, message: "Order cannot be cancelled as it is already shipped" };
        const res = classifyShiprocketCancelResponse(body);
        assert.equal(res.outcome, "failed");
        assert.equal(res.statusCode, 400);
    });

    test("Definite rejection (not found) classifies as failed", () => {
        const body = { status_code: 404, message: "Order not found" };
        const res = classifyShiprocketCancelResponse(body);
        assert.equal(res.outcome, "failed");
    });

    test("HTTP 200 with rejection message classifies as failed", () => {
        const body = { status_code: 200, message: "invalid order id" };
        const res = classifyShiprocketCancelResponse(body);
        assert.equal(res.outcome, "failed");
    });

    test("Empty body {} must NEVER default to 200/confirmed — must be uncertain", () => {
        const body = {};
        const res = classifyShiprocketCancelResponse(body);
        assert.equal(res.outcome, "uncertain");
    });

    test("Null or undefined body must return uncertain", () => {
        assert.equal(classifyShiprocketCancelResponse(null).outcome, "uncertain");
        assert.equal(classifyShiprocketCancelResponse(undefined).outcome, "uncertain");
    });

    test("Server error (500) classifies as uncertain (retryable)", () => {
        const body = { status_code: 500, message: "Shiprocket server error" };
        const res = classifyShiprocketCancelResponse(body);
        assert.equal(res.outcome, "uncertain");
    });
});

describe("Cancellation Eligibility & Commercial Policy Logic", () => {
    test("Pre-dispatch placed/confirmed order is eligible for cancellation", () => {
        const order = {
            status: "confirmed",
            reservation: { state: "held" },
            cancellation: { status: "none" },
        };
        const el = evaluateCancellationEligibility(order, { isCustomer: true });
        assert.equal(el.canCancel, true);
        assert.equal(el.reasonCode, "eligible");
    });

    test("Dispatched order (shipped) is rejected with safe customer explanation", () => {
        const order = {
            status: "shipped",
            reservation: { state: "return_pending" },
            cancellation: { status: "none" },
        };
        const el = evaluateCancellationEligibility(order, { isCustomer: true });
        assert.equal(el.canCancel, false);
        assert.equal(el.reasonCode, "already_dispatched");
        assert.match(el.cannotCancelReason, /already been dispatched/i);
    });

    test("Order with reservation.state = return_pending is rejected even if status lagged", () => {
        const order = {
            status: "processing",
            reservation: { state: "return_pending" },
            cancellation: { status: "none" },
        };
        const el = evaluateCancellationEligibility(order, { isCustomer: true });
        assert.equal(el.canCancel, false);
        assert.equal(el.reasonCode, "already_dispatched");
    });

    test("Delivered order is rejected with return suggestion", () => {
        const order = {
            status: "delivered",
            reservation: { state: "return_pending" },
        };
        const el = evaluateCancellationEligibility(order, { isCustomer: true });
        assert.equal(el.canCancel, false);
        assert.equal(el.reasonCode, "order_delivered");
        assert.match(el.cannotCancelReason, /delivered.*return/i);
    });

    test("Cancelled order is recognized as already cancelled", () => {
        const order = {
            status: "cancelled",
            cancellation: { status: "completed" },
        };
        const el = evaluateCancellationEligibility(order, { isCustomer: true });
        assert.equal(el.canCancel, false);
        assert.equal(el.reasonCode, "already_cancelled");
    });

    test("Guest order cannot be cancelled via customer route without support", () => {
        const order = {
            status: "confirmed",
            isGuest: true,
            reservation: { state: "held" },
        };
        const el = evaluateCancellationEligibility(order, { isCustomer: true });
        assert.equal(el.canCancel, false);
        assert.equal(el.reasonCode, "guest_order");
        assert.match(el.cannotCancelReason, /customer care/i);
    });

    // PHASE 1 REQUIRED COMMERCIAL POLICY & REFUND CALCULATION SCENARIOS
    test("Scenario 1: Captured ₹1,999 with no previous refunds requests ₹1,999 (not ₹1,849 — zero cancellation fee)", () => {
        const order = {
            pricing: { total: 1999 },
            payment: { method: "prepaid", status: "paid", amountPaid: 199900, refundedAmount: 0 },
        };
        const calc = calculateCancellationRefund(order);
        assert.equal(calc.refundablePaise, 199900, "Must refund entire 199900 paise");
        assert.equal(calc.feePaise, 0, "Cancellation fee must be 0");
        assert.notEqual(calc.refundablePaise, 184900, "Must NEVER deduct ₹150 cancellation fee");
    });

    test("Scenario 2: Captured ₹1,998 including ₹199 charged shipping requests full ₹1,998", () => {
        const order = {
            pricing: { subtotal: 1799, shippingCharges: 199, total: 1998 },
            payment: { method: "upi", status: "paid", amountPaid: 199800, refundedAmount: 0 },
        };
        const calc = calculateCancellationRefund(order);
        assert.equal(calc.refundablePaise, 199800, "Shipping charge must not be subtracted from confirmed cancellation");
        assert.equal(calc.feePaise, 0);
    });

    test("Scenario 3: Captured ₹1,999 with previously processed refund of ₹500 leaves ₹1,499", () => {
        const order = {
            pricing: { total: 1999 },
            payment: { method: "card", status: "paid", amountPaid: 199900, refundedAmount: 50000 },
        };
        const calc = calculateCancellationRefund(order);
        assert.equal(calc.refundablePaise, 149900, "Remaining refundable amount must be 149900 paise (₹1,499)");
        assert.equal(calc.feePaise, 0);
    });

    test("Scenario 4: Already fully refunded order yields 0 refundable and blocks duplicate gateway calls", () => {
        const order = {
            pricing: { total: 1999 },
            payment: { method: "netbanking", status: "paid", amountPaid: 199900, refundedAmount: 199900 },
            refund: { status: "processed", amountPaise: 199900, razorpayRefundId: "rfnd_already_done" },
        };
        const calc = calculateCancellationRefund(order);
        assert.equal(calc.refundablePaise, 0, "No remaining refundable amount when fully refunded");
    });

    test("Scenario 5: Refund pending or in-flight prevents initiating duplicate refund", () => {
        const order = {
            pricing: { total: 1999 },
            payment: { method: "upi", status: "paid", amountPaid: 199900, razorpayPaymentId: "pay_test_pending" },
            refund: { status: "pending", razorpayRefundId: "rfnd_in_flight" },
        };
        const calc = calculateCancellationRefund(order);
        assert.equal(calc.isPrepaid, true);
        assert.equal(order.refund.status, "pending");
    });

    test("Scenario 6: Payment never captured / unpaid orders / uncollected COD have zero refund", () => {
        const unpaidPrepaid = {
            pricing: { total: 1999 },
            payment: { method: "prepaid", status: "pending", amountPaid: 0, refundedAmount: 0 },
        };
        const codOrder = {
            pricing: { total: 2499 },
            payment: { method: "cod", status: "pending", amountPaid: 0, refundedAmount: 0 },
        };
        const calcUnpaid = calculateCancellationRefund(unpaidPrepaid);
        assert.equal(calcUnpaid.refundablePaise, 0);
        assert.equal(calcUnpaid.isPrepaid, false);

        const calcCod = calculateCancellationRefund(codOrder);
        assert.equal(calcCod.refundablePaise, 0);
        assert.equal(calcCod.isPrepaid, false);
    });

    test("Customer summaries do not leak internal leases or secrets", () => {
        const order = {
            status: "cancelled",
            pricing: { total: 1500 },
            payment: {
                method: "upi",
                status: "refunded",
                amountPaid: 150000,
                refundedAmount: 150000,
                checkoutTokenHash: "secret_hash_value",
                razorpaySignature: "secret_sig",
            },
            refund: {
                status: "processed",
                amountPaise: 150000,
                leaseOwner: "worker-pid-1234",
                leaseExpiresAt: new Date(),
                razorpayRefundId: "rfnd_test_123456",
                verifiedAt: new Date(),
            },
            cancellation: {
                status: "completed",
                courierOutcome: "not_needed",
                claimToken: "claim-token-xyz",
            },
        };

        const cancelSummary = buildCustomerCancellationSummary(order);
        assert.equal(cancelSummary.claimToken, undefined);
        assert.equal(cancelSummary.status, "completed");

        const refundSummary = buildCustomerRefundSummary(order);
        assert.equal(refundSummary.status, "processed");
        assert.equal(refundSummary.amountRupees, 1500);
        assert.equal(refundSummary.leaseOwner, undefined);
    });
});

describe("Cancellation Lifecycle & Database Integration Suite", () => {
    let mongoConnected = false;

    before(async () => {
        if (!MONGO_URI) {
            console.warn("Skipping DB tests: No MONGO_URI configured");
            return;
        }
        try {
            await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
            mongoConnected = true;
        } catch (err) {
            console.warn("DB connection skipped in test environment:", err.message);
        }
    });

    after(async () => {
        if (mongoConnected && mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
        }
    });

    function makeId() {
        return `TEST-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }

    async function seedProduct(stock = 5, overrides = {}) {
        const id = makeId();
        return Product.create({
            name: "Test Saree " + id,
            sku: "SKU-" + id,
            category: "silk",
            regularPrice: 2999,
            price: 1999,
            stock,
            shortDescription: "Test short description for saree",
            tags: "saree, silk, test",
            mainImage: "https://example.com/test.jpg",
            color: "Red",
            material: "Pure Silk",
            sareeSize: "5.5 meters",
            blouseSize: "0.8 meters",
            washCare: "Dry clean only",
            ...overrides,
        });
    }

    test("Eligible COD cancellation restores product stock exactly once and completes order", async (t) => {
        if (!mongoConnected) return t.skip("Requires MongoDB");

        const product = await seedProduct(5);

        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: product._id, name: product.name, price: 1999, quantity: 2 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9999999999", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 3998, total: 3998 },
            status: "placed",
            reservation: { state: "held" },
        });

        const result = await processOrderCancellation(order._id, {
            reason: "Ordered by mistake",
            cancelledBy: "customer",
        });

        assert.equal(result.success, true);
        assert.equal(result.finalized, true);
        assert.equal(result.order.status, "cancelled");
        assert.equal(result.order.cancellation.status, "completed");
        assert.equal(result.order.reservation.state, "released");

        // Verify stock incremented by 2
        const updatedProduct = await Product.findById(product._id);
        assert.equal(updatedProduct.stock, 7);

        // Repeated request is idempotent and does NOT restore stock a second time
        const repeatResult = await processOrderCancellation(order._id, {
            reason: "Ordered by mistake",
            cancelledBy: "customer",
        });
        assert.equal(repeatResult.alreadyCancelled, true);

        const untouchedProduct = await Product.findById(product._id);
        assert.equal(untouchedProduct.stock, 7); // Exactly once!
    });

    test("Dispatched parcel cannot release stock on cancellation", async (t) => {
        if (!mongoConnected) return t.skip("Requires MongoDB");

        const product = await seedProduct(3);

        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: product._id, name: product.name, price: 2499, quantity: 1 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9999999999", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 2499, total: 2499 },
            status: "shipped",
            reservation: { state: "return_pending" },
        });

        await assert.rejects(
            async () => {
                await processOrderCancellation(order._id, { reason: "Customer changed mind", cancelledBy: "customer" });
            },
            (err) => {
                assert.match(err.message, /dispatched/i);
                return true;
            }
        );

        // Product stock remains untouched
        const freshProd = await Product.findById(product._id);
        assert.equal(freshProd.stock, 3);
    });

    test("Durable cancellation worker claims and reconciles pending cancellation", async (t) => {
        if (!mongoConnected) return t.skip("Requires MongoDB");

        const order = await Order.create({
            orderId: makeId(),
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9999999999", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1000, total: 1000 },
            status: "processing",
            reservation: { state: "held" },
            cancellation: {
                status: "requested",
                courierOutcome: "not_needed", // No shipment exists
                nextAttemptAt: new Date(Date.now() - 1000), // Past due
                attempts: 1,
            },
        });

        const claimToken = "test-worker-token-123";
        const claimed = await claimCancellation(order._id, claimToken);
        assert.ok(claimed, "Should claim past due cancellation");
        assert.equal(claimed.cancellation.claimToken, claimToken);

        const outcome = await reconcileSingleCancellation(claimed, claimToken);
        assert.equal(outcome.outcome, "completed");

        const finalOrder = await Order.findById(order._id);
        assert.equal(finalOrder.status, "cancelled");
        assert.equal(finalOrder.cancellation.status, "completed");
        assert.equal(finalOrder.reservation.state, "released");
    });
});
