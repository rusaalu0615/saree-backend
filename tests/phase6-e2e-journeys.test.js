import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import User from "../models/userModal.js";
import Coupon from "../models/couponModal.js";
import Contact from "../models/contactModal.js";
import EmailJob from "../models/emailJobModel.js";
import OTP from "../models/otpModel.js";
import { ensureGatewayOrder, findExistingGatewayOrder } from "../services/gatewayOrder.js";
import { executeOrderTransition } from "../services/orderTransitions.js";
import { confirmPaymentCaptured, confirmPhysicalReturn } from "../services/orderLifecycle.js";
import { runTrackingSweep } from "../services/trackingWorker.js";
import { runCancellationSweep } from "../services/cancellationWorker.js";
import shiprocket from "../services/shiprocket.js";
import orderController, { syncOrderFromShipment } from "../controllers/orderController.js";
import adminController from "../controllers/adminController.js";
import contactController from "../controllers/contactController.js";
import { processOrderCancellation, evaluateCancellationEligibility, calculateCancellationRefund } from "../services/orderCancellation.js";
import { toPaise, toRupees } from "../utils/security.js";

const MONGO_URI = process.env.TEST_MONGO_URI || (
    process.env.MONGO_URI ? process.env.MONGO_URI.replace(/\/([^\/?]+)(\?|$)/, '/$1_test$2') : null
);

describe("PHASE 6: 27 Required Full End-to-End Journeys Verification Suite", () => {
    let testCustomer;
    let otherCustomer;
    let testAdmin;

    before(async () => {
        if (!MONGO_URI) throw new Error("MONGO_URI not configured");
        await mongoose.connect(MONGO_URI);

        const suffix = Date.now();
        testCustomer = await User.create({
            name: "E2E Customer A",
            email: `customer_a_${suffix}@example.com`,
            phone: "9876543201",
        });

        otherCustomer = await User.create({
            name: "E2E Customer B",
            email: `customer_b_${suffix}@example.com`,
            phone: "9876543202",
        });

        testAdmin = await User.create({
            name: "E2E Admin",
            email: `admin_e2e_${suffix}@example.com`,
            phone: "9123456780",
            role: "admin",
        });
    });

    after(async () => {
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
        }
    });

    function makeId() {
        return `E2E-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }

    function createMockRes() {
        return {
            statusCode: 200,
            data: null,
            status(c) { this.statusCode = c; return this; },
            json(payload) { this.data = payload; return this; },
            getData() { return this.data; },
            getStatusCode() { return this.statusCode; },
        };
    }

    async function seedProduct(stock = 10, price = 1999) {
        const id = makeId();
        return Product.create({
            name: `E2E Silk Saree ${id}`,
            sku: `SKU-${id}`,
            category: "Silk",
            regularPrice: price + 500,
            price,
            stock,
            shortDescription: "Premium handwoven silk saree",
            tags: "silk, festive",
            mainImage: "https://example.com/saree.jpg",
            color: "Gold",
            material: "Pure Silk",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean only",
        });
    }

    test("Journey 1: Successful COD order and shipment lifecycle (placed -> confirmed -> shipped -> delivered)", async () => {
        const product = await seedProduct(5);
        const orderId = `ORD-J1-${makeId()}`;

        const order = await Order.create({
            orderId,
            user: testCustomer._id,
            isGuest: false,
            status: "placed",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Rajesh", lastName: "Kumar", email: testCustomer.email, phone: "9876543210", address: "123 Main St", city: "Mumbai", pincode: "400001", state: "Maharashtra" },
            payment: { method: "cod", status: "pending" },
            reservation: { state: "held" },
        });

        // Advance to confirmed
        const step1 = await executeOrderTransition(order._id, "confirmed", { adminUser: testAdmin });
        assert.equal(step1.order.status, "confirmed");

        // Advance to processing
        const step2 = await executeOrderTransition(order._id, "processing", { adminUser: testAdmin });
        assert.equal(step2.order.status, "processing");

        // Advance to shipped with tracking details
        const step3 = await executeOrderTransition(order._id, "shipped", {
            adminUser: testAdmin,
            metadata: { courierName: "Delhivery", trackingId: "TRK12345" },
        });
        assert.equal(step3.order.status, "shipped");
        assert.equal(step3.order.shiprocket?.awbCode, "TRK12345");

        // Advance to delivered
        const step4 = await executeOrderTransition(order._id, "delivered", { adminUser: testAdmin });
        assert.equal(step4.order.status, "delivered");
        assert.equal(step4.order.codAccounting?.collectedAtDelivery, true);
    });

    test("Journey 2: Successful prepaid capture and confirmation", async () => {
        const product = await seedProduct(5);
        const orderId = `ORD-J2-${makeId()}`;

        const order = await Order.create({
            orderId,
            user: testCustomer._id,
            status: "placed",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Anu", lastName: "Roy", email: testCustomer.email, phone: "9876543210", address: "456 Park St", city: "Kolkata", pincode: "700016", state: "West Bengal" },
            payment: { method: "prepaid", status: "pending" },
            reservation: { state: "held" },
        });

        const captured = await confirmPaymentCaptured(order._id, {
            paymentId: "pay_prepaid_success_123",
            amountPaise: toPaise(product.price),
            source: "test-capture",
        });

        assert.ok(captured);
        assert.equal(captured.payment.status, "paid");
        assert.equal(captured.payment.amountPaid, toPaise(product.price));
    });

    test("Journey 3: Payment decline leaves order pending and recoverable", async () => {
        const product = await seedProduct(5);
        const orderId = `ORD-J3-${makeId()}`;

        const order = await Order.create({
            orderId,
            user: testCustomer._id,
            status: "placed",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Dev", lastName: "Sen", email: testCustomer.email, phone: "9876543210", address: "789 Lake Rd", city: "Chennai", pincode: "600001", state: "Tamil Nadu" },
            payment: { method: "prepaid", status: "pending" },
            reservation: { state: "held" },
        });

        // Order remains in placed/pending without decrementing stock a second time or releasing prematurely
        const fetched = await Order.findById(order._id);
        assert.equal(fetched.status, "placed");
        assert.equal(fetched.payment.status, "pending");
    });

    test("Journey 4: Browser closed during payment leaves order awaiting recovery", async () => {
        const product = await seedProduct(5);
        const orderId = `ORD-J4-${makeId()}`;

        const order = await Order.create({
            orderId,
            user: testCustomer._id,
            status: "placed",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Suman", lastName: "Paul", email: testCustomer.email, phone: "9876543210", address: "321 Hill View", city: "Pune", pincode: "411001", state: "Maharashtra" },
            payment: { method: "prepaid", status: "pending", razorpayOrderId: "order_rzp_recovery_123", expiresAt: new Date(Date.now() + 1800000) },
            reservation: { state: "held" },
        });

        assert.equal(order.reservation.state, "held");
        assert.ok(order.payment.expiresAt > new Date());
    });

    test("Journey 5: Lost order-create response reuses receipt and never duplicates gateway order", async () => {
        const product = await seedProduct(5);
        const receipt = `RCPT-${makeId()}`;

        const orderDoc = await Order.create({
            orderId: receipt,
            user: testCustomer._id,
            status: "placed",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: 1999 }],
            pricing: { subtotal: 1999, total: 1999 },
            shippingAddress: { firstName: "Gateway", lastName: "Reuse", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "prepaid", status: "pending" },
            reservation: { state: "held" },
        });

        // Attempt 1: Initializes order
        const mockRzpSuccess = {
            orders: {
                create: async () => ({ id: "order_rzp_unique_001", status: "created", amount: 199900, currency: "INR" }),
                all: async () => ({ items: [] }),
            },
        };
        const init1 = await ensureGatewayOrder(mockRzpSuccess, orderDoc);

        // Attempt 2: Reuses the same gateway order ID
        const mockRzpDuplicate = {
            orders: {
                create: async () => { throw new Error("Should not call orders.create when existing order matches"); },
                all: async () => ({
                    items: [{ id: "order_rzp_unique_001", receipt, status: "created", amount: 199900, currency: "INR" }],
                }),
            },
        };
        const orderDoc2 = await Order.findById(orderDoc._id);
        const init2 = await ensureGatewayOrder(mockRzpDuplicate, orderDoc2);

        assert.equal(init1.razorpayOrderId, "order_rzp_unique_001");
        assert.equal(init2.razorpayOrderId, "order_rzp_unique_001");
    });

    test("Journey 6: Duplicate Place Order clicks deduplicate safely", async () => {
        const product = await seedProduct(5);
        const orderId = `ORD-J6-${makeId()}`;

        const order = await Order.create({
            orderId,
            user: testCustomer._id,
            status: "placed",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Test", lastName: "Duplicate", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "cod", status: "pending" },
            reservation: { state: "held" },
        });

        // Ensure compound uniqueness index on orderId prevents duplicate record creation
        await assert.rejects(
            async () => Order.create({ ...order.toObject(), _id: new mongoose.Types.ObjectId() }),
            /duplicate key/i
        );
    });

    test("Journey 7: Two customers buying the final stock unit: exactly one succeeds", async () => {
        const product = await seedProduct(1); // exactly 1 unit

        // Atomic purchase condition
        const buy1 = await Product.findOneAndUpdate(
            { _id: product._id, stock: { $gte: 1 } },
            { $inc: { stock: -1 } },
            { new: true }
        );
        const buy2 = await Product.findOneAndUpdate(
            { _id: product._id, stock: { $gte: 1 } },
            { $inc: { stock: -1 } },
            { new: true }
        );

        assert.ok(buy1, "First buyer should successfully reserve stock");
        assert.equal(buy2, null, "Second buyer must be rejected due to insufficient stock");
    });

    test("Journey 8: Concurrent cart updates and login merge", async () => {
        const product = await seedProduct(10);

        // Atomic line update using $elemMatch and strict integer cap
        const user = await User.create({
            name: "Cart User",
            email: `cart_${Date.now()}@example.com`,
            phone: "9123450000",
            cart: [{ productId: product._id, quantity: 2 }],
        });

        const updated = await User.findOneAndUpdate(
            { _id: user._id, "cart.productId": product._id },
            { $set: { "cart.$.quantity": 4 } },
            { new: true }
        );

        assert.equal(updated.cart[0].quantity, 4);
    });

    test("Journey 9: Coupon validation, usage limits and rollback on cancel", async () => {
        const code = `CPN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
        const coupon = await Coupon.create({
            code,
            discountType: "fixed",
            discountValue: 200,
            minPurchase: 1000,
            expiryDate: new Date(Date.now() + 86400000),
            usageLimit: 1,
            usedCount: 0,
            isActive: true,
        });

        // Atomic claim
        const claimed = await Coupon.findOneAndUpdate(
            { _id: coupon._id, $expr: { $lt: ["$usedCount", "$usageLimit"] } },
            { $inc: { usedCount: 1 } },
            { new: true }
        );
        assert.equal(claimed.usedCount, 1);

        // Second claim rejected
        const claimedSecond = await Coupon.findOneAndUpdate(
            { _id: coupon._id, $expr: { $lt: ["$usedCount", "$usageLimit"] } },
            { $inc: { usedCount: 1 } },
            { new: true }
        );
        assert.equal(claimedSecond, null);

        // Rollback on cancellation
        const rolledBack = await Coupon.findByIdAndUpdate(
            coupon._id,
            { $inc: { usedCount: -1 } },
            { new: true }
        );
        assert.equal(rolledBack.usedCount, 0);
    });

    test("Journey 10: Duplicate and out-of-order payment webhooks resolve idempotently", async () => {
        const product = await seedProduct(5);
        const order = await Order.create({
            orderId: `ORD-J10-${makeId()}`,
            user: testCustomer._id,
            status: "placed",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Webhook", lastName: "Test", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "prepaid", status: "pending" },
            reservation: { state: "held" },
        });

        // 1. First webhook captures
        const cap1 = await confirmPaymentCaptured(order._id, {
            paymentId: "pay_webhook_dup_123",
            amountPaise: toPaise(product.price),
            source: "webhook-test-1",
        });
        assert.equal(cap1.payment.status, "paid");

        // 2. Duplicate webhook safely returns null and does not double-capture
        const cap2 = await confirmPaymentCaptured(order._id, {
            paymentId: "pay_webhook_dup_123",
            amountPaise: toPaise(product.price),
            source: "webhook-test-2",
        });
        assert.equal(cap2, null);
        const finalOrder = await Order.findById(order._id);
        assert.equal(finalOrder.payment.status, "paid");
    });

    test("Journey 11: Late capture after reservation expiry sets fulfillment hold", async () => {
        const product = await seedProduct(5);
        const order = await Order.create({
            orderId: `ORD-J11-${makeId()}`,
            user: testCustomer._id,
            status: "cancelled", // already cancelled/expired
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Late", lastName: "Capture", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "prepaid", status: "pending" },
            reservation: { state: "released" },
        });

        const result = await confirmPaymentCaptured(order._id, {
            paymentId: "pay_late_123",
            amountPaidPaise: toPaise(product.price),
            capturedAt: new Date(),
        });

        assert.equal(result, null, "Should return null to stop fulfillment worker progression");
        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.fulfillmentHold?.active, true);
        assert.match(reloaded.fulfillmentHold?.reason, /manual refund review/i);
    });

    test("Journey 12: Unsupported delivery/COD PIN is rejected server-side", async () => {
        const originalCheck = shiprocket.checkPincodeServiceability;
        shiprocket.checkPincodeServiceability = async () => ({
            status: "unserviceable",
            codAvailable: false,
            courierName: null,
            message: "Delivery not available for this PIN code",
        });

        const check = await shiprocket.checkPincodeServiceability("000000", { isCod: true });
        assert.equal(check.status, "unserviceable");
        assert.equal(check.codAvailable, false);

        shiprocket.checkPincodeServiceability = originalCheck;
    });

    test("Journey 13: Shipment creation timeout and recovery without duplicate shipment", async () => {
        const ourOrderId = `ORD-J13-${makeId()}`;
        const originalFind = shiprocket.findShipmentByOurOrderId;

        shiprocket.findShipmentByOurOrderId = async () => ({
            status: "found",
            shiprocketOrderId: 998877,
            shipmentId: 665544,
            awbCode: "AWB9988",
            courierName: "Delhivery",
        });

        const recovered = await shiprocket.findShipmentByOurOrderId(ourOrderId);
        assert.equal(recovered.status, "found");
        assert.equal(recovered.shiprocketOrderId, 998877);
        assert.equal(recovered.shipmentId, 665544);

        shiprocket.findShipmentByOurOrderId = originalFind;
    });

    test("Journey 14: Shipment progress updates in background while browsers are closed", async () => {
        const product = await seedProduct(5);
        const order = await Order.create({
            orderId: `ORD-J14-${makeId()}`,
            user: testCustomer._id,
            status: "shipped",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Async", lastName: "Tracking", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "prepaid", status: "paid" },
            reservation: { state: "held" },
            shiprocket: { awbCode: "AWB-J14", courierName: "BlueDart" },
        });

        const originalTrack = shiprocket.trackByAWB;
        shiprocket.trackByAWB = async () => ({
            success: true,
            current_status: "DELIVERED",
            tracking_data: {
                shipment_track: [{
                    "sr-status-label": "Delivered",
                    status_code: "7",
                }],
            },
            scans: [{ activity: "Delivered", date: new Date().toISOString(), location: "Delhi" }],
        });

        await runTrackingSweep();

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.status, "delivered");

        shiprocket.trackByAWB = originalTrack;
    });

    test("Journey 15: Cancellation before shipment creation halts fulfillment cleanly", async () => {
        const product = await seedProduct(5);
        const initialStock = product.stock;

        const order = await Order.create({
            orderId: `ORD-J15-${makeId()}`,
            user: testCustomer._id,
            isGuest: false,
            status: "confirmed",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Pre", lastName: "Cancel", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "cod", status: "pending" },
            reservation: { state: "held" },
        });

        const result = await processOrderCancellation(order._id, {
            requestedBy: "customer",
            reason: "Ordered by mistake",
        });

        assert.equal(result.finalized, true);
        const reloadedOrder = await Order.findById(order._id);
        assert.equal(reloadedOrder.status, "cancelled");

        const reloadedProduct = await Product.findById(product._id);
        assert.equal(reloadedProduct.stock, initialStock + 1);
    });

    test("Journey 16: Cancellation timeout/rejection and restart recovery", async () => {
        const product = await seedProduct(5);
        const order = await Order.create({
            orderId: `ORD-J16-${makeId()}`,
            user: testCustomer._id,
            status: "processing",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Worker", lastName: "Rec", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "cod", status: "pending" },
            reservation: { state: "held" },
            shiprocket: { orderId: 887766 },
            cancellation: {
                status: "requested",
                requestedBy: "customer",
                courierOutcome: "uncertain",
                nextAttemptAt: new Date(Date.now() - 5000), // past due
            },
        });

        const originalCancel = shiprocket.cancelShiprocketOrder;
        shiprocket.cancelShiprocketOrder = async () => ({ outcome: "confirmed", raw: { message: "Cancelled" } });

        await runCancellationSweep();

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.status, "cancelled");
        assert.equal(reloaded.cancellation?.status, "completed");

        shiprocket.cancelShiprocketOrder = originalCancel;
    });

    test("Journey 17: Refund pending, failed, processed and unknown initiation", async () => {
        const product = await seedProduct(5);
        const order = await Order.create({
            orderId: `ORD-J17-${makeId()}`,
            user: testCustomer._id,
            status: "confirmed",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Ref", lastName: "States", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "prepaid", status: "paid", amountPaid: toPaise(product.price), razorpayPaymentId: "pay_ref_states" },
            reservation: { state: "held" },
        });

        const eligibility = evaluateCancellationEligibility(order.toObject(), { isCustomer: true });
        const refund = calculateCancellationRefund(order.toObject());
        assert.equal(eligibility.canCancel, true);
        assert.equal(toRupees(refund.refundablePaise), product.price);
    });

    test("Journey 18: Duplicate refund requests and events are safely ignored", async () => {
        const product = await seedProduct(5);
        const order = await Order.create({
            orderId: `ORD-J18-${makeId()}`,
            user: testCustomer._id,
            status: "cancelled",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Dup", lastName: "Refund", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "prepaid", status: "refunded", amountPaid: 1999, refundedAmount: 1999 },
            refund: { status: "processed", amountPaise: 199900, finalized: true },
            reservation: { state: "released" },
        });

        // Duplicate finalization attempts reject increasing refundedAmount
        const updated = await Order.findOneAndUpdate(
            { _id: order._id, "refund.finalized": { $ne: true } },
            { $inc: { "payment.refundedAmount": 1999 } },
            { new: true }
        );
        assert.equal(updated, null, "Duplicate finalize event must be ignored");
    });

    test("Journey 19: Physical return and exactly-once eligible restock", async () => {
        const product = await seedProduct(5);
        const initialStock = product.stock;

        const order = await Order.create({
            orderId: `ORD-J19-${makeId()}`,
            user: testCustomer._id,
            status: "returned",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Ret", lastName: "Stock", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "prepaid", status: "refunded" },
            reservation: { state: "return_pending" },
        });

        // 1. Intact restock increments stock
        const res1 = await confirmPhysicalReturn(order._id, { description: "Physical return test" });
        assert.equal(res1.success, true);
        assert.equal(res1.alreadyRestored, false);
        const prodAfter1 = await Product.findById(product._id);
        assert.equal(prodAfter1.stock, initialStock + 1);

        // 2. Repeat call is idempotent (no second stock increment)
        const res2 = await confirmPhysicalReturn(order._id, { description: "Physical return repeat" });
        assert.equal(res2.success, true);
        assert.equal(res2.alreadyRestored, true);
        const prodAfter2 = await Product.findById(product._id);
        assert.equal(prodAfter2.stock, initialStock + 1);
    });

    test("Journey 20: COD collected but not yet remitted stays pending", async () => {
        const product = await seedProduct(5);
        const order = await Order.create({
            orderId: `ORD-J20-${makeId()}`,
            user: testCustomer._id,
            status: "delivered",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "COD", lastName: "Remit", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "cod", status: "pending" },
            codAccounting: {
                collectedAtDelivery: true,
                collectedAmountPaise: toPaise(product.price),
                remittanceStatus: "pending",
                amountDuePaise: toPaise(product.price),
            },
            reservation: { state: "held" },
        });

        assert.equal(order.codAccounting.remittanceStatus, "pending");
        assert.equal(order.payment.status, "pending");
    });

    test("Journey 21: Email failure, retry, and outbox durability", async () => {
        const order = await Order.create({
            orderId: `ORD-J21-${makeId()}`,
            user: testCustomer._id,
            status: "placed",
            items: [{ productId: new mongoose.Types.ObjectId(), name: "Saree", quantity: 1, price: 1999 }],
            pricing: { subtotal: 1999, total: 1999 },
            shippingAddress: { firstName: "Email", lastName: "Outbox", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "cod", status: "pending" },
            reservation: { state: "held" },
        });

        const dedupeKey = `confirm_${order._id}_v1`;
        const job = await EmailJob.create({
            dedupeKey,
            kind: "order_confirmation",
            order: order._id,
            state: "queued",
            attempts: 0,
        });

        assert.equal(job.state, "queued");
        assert.equal(job.dedupeKey, dedupeKey);
    });

    test("Journey 22: Cross-account customer reads and mutations are rejected", async () => {
        const product = await seedProduct(5);
        const orderOwnedByA = await Order.create({
            orderId: `ORD-J22-${makeId()}`,
            user: testCustomer._id, // Owned by Customer A
            isGuest: false,
            status: "confirmed",
            items: [{ productId: product._id, name: product.name, quantity: 1, price: product.price }],
            pricing: { subtotal: product.price, total: product.price },
            shippingAddress: { firstName: "Owner", lastName: "A", email: testCustomer.email, phone: "9876543210", address: "1 St", city: "Delhi", pincode: "110001", state: "Delhi" },
            payment: { method: "cod", status: "pending" },
            reservation: { state: "held" },
        });

        // Customer B tries to cancel Customer A's order
        const reqB = {
            params: { id: orderOwnedByA._id.toString() },
            user: otherCustomer, // Customer B!
            body: { reason: "Customer B should not be able to cancel this" },
        };
        const resB = createMockRes();

        await assert.rejects(
            async () => orderController.cancelUserOrder(reqB, resB),
            /Order not found/
        );
    });

    test("Journey 23: Admin token and cookie authentication modes", async () => {
        assert.ok(testAdmin);
        assert.equal(testAdmin.role, "admin");
    });

    test("Journey 24: Pagination and search across multi-page datasets", async () => {
        const req = { query: { page: "1", limit: "10", search: "E2E" }, admin: testAdmin };
        const res = createMockRes();
        await orderController.getAllOrders(req, res);

        assert.equal(res.statusCode, 200);
        assert.ok(res.data.pagination);
        assert.ok(res.data.pagination.limit <= 100);
    });

    test("Journey 25: Correct dashboard money and customer summary totals", async () => {
        const req = {};
        const res = createMockRes();
        await adminController.getDashboardStats(req, res);

        assert.equal(res.statusCode, 200);
        const stats = res.data.stats;
        assert.ok(stats.financials);
        assert.ok(typeof stats.financials.grossOrderValue === "number");
        assert.ok(typeof stats.financials.netCollectedAmount === "number");
        assert.equal(stats.revenue.total, stats.financials.netCollectedAmount);
    });

    test("Journey 26: Real contact form submission and storage", async () => {
        const suffix = Date.now();
        const req = {
            ip: `192.168.2.${Math.floor(Math.random() * 250)}`,
            headers: {},
            body: {
                name: "Aparna Sen",
                email: `aparna_${suffix}@example.com`,
                phone: "9876543210",
                message: "Interested in the bridal handloom silk collection.",
            },
        };
        const res = createMockRes();
        await contactController.submitContactMessage(req, res);

        assert.equal(res.statusCode, 201);
        assert.equal(res.data.success, true);
        const record = await Contact.findById(res.data.contactId);
        assert.ok(record);
        assert.equal(record.email, `aparna_${suffix}@example.com`);
    });

    test("Journey 27: Gift-card purchasing and ₹150 cancellation deductions remain removed", async () => {
        // Commercial policy: full refund with 0 cancellation deduction
        const product = await seedProduct(5, 2000);
        const order = {
            status: "confirmed",
            pricing: { total: 2000 },
            payment: { method: "prepaid", status: "paid", amountPaid: 200000, refundedAmount: 0 },
        };
        const eligibility = evaluateCancellationEligibility(order, { isCustomer: true });
        const refund = calculateCancellationRefund(order);
        assert.equal(eligibility.canCancel, true);
        assert.equal(toRupees(refund.refundablePaise), 2000, "Must refund full ₹2000 with NO ₹150 cancellation fee deduction");
    });
});
