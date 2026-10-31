import "dotenv/config";
import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import User from "../models/userModal.js";
import orderController, { syncOrderFromShipment } from "../controllers/orderController.js";
import shiprocket from "../services/shiprocket.js";
import { runTrackingSweep } from "../services/trackingWorker.js";
import { executeOrderTransition } from "../services/orderTransitions.js";
import { confirmPhysicalReturn } from "../services/orderLifecycle.js";
import AppError from "../utils/AppError.js";

const MONGO_URI = process.env.TEST_MONGO_URI || (
    process.env.MONGO_URI ? process.env.MONGO_URI.replace(/\/([^\/?]+)(\?|$)/, '/$1_test$2') : null
);

describe("PHASE 4: Operational Lifecycle Completion and Admin Consistency Acceptance Suite", () => {
    let testAdmin;
    let originalTrackByAWB;
    let originalTrackByOrderId;
    let originalCheckServiceability;

    before(async () => {
        if (!MONGO_URI) throw new Error("MONGO_URI not configured");
        await mongoose.connect(MONGO_URI);

        const suffix = Date.now();
        testAdmin = await User.create({
            name: "Phase 4 Admin",
            email: `admin_${suffix}@example.com`,
            phone: "9112233445",
            role: "admin",
        });

        originalTrackByAWB = shiprocket.trackByAWB;
        originalTrackByOrderId = shiprocket.trackByShiprocketOrderId;
        originalCheckServiceability = shiprocket.checkPincodeServiceability;
    });

    after(async () => {
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
        }
    });

    afterEach(() => {
        shiprocket.trackByAWB = originalTrackByAWB;
        shiprocket.trackByShiprocketOrderId = originalTrackByOrderId;
        shiprocket.checkPincodeServiceability = originalCheckServiceability;
    });

    function makeId() {
        return `P4-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }

    async function seedProduct(stock = 10) {
        const id = makeId();
        return Product.create({
            name: "Phase 4 Handloom Saree " + id,
            sku: "SKU-" + id,
            category: "silk",
            regularPrice: 2999,
            price: 1999,
            stock,
            shortDescription: "Phase 4 test product",
            tags: "saree, silk, test",
            mainImage: "https://example.com/saree.jpg",
            color: "Green",
            material: "Silk",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean",
        });
    }

    test("1. Delivery Eligibility: checkPincodeServiceability rejects unserviceable, handles COD-unavailable and provider-unknown", async () => {
        // Mock provider returning unserviceable
        shiprocket.checkPincodeServiceability = async (pincode, { isCod }) => {
            if (pincode === "000000") return { serviceable: false, codAvailable: false, outcome: "unserviceable" };
            if (pincode === "111111") return { serviceable: true, codAvailable: false, outcome: "cod_unavailable" };
            if (pincode === "999999") return { serviceable: null, codAvailable: null, outcome: "unknown", reason: "timeout" };
            return { serviceable: true, codAvailable: true, outcome: "serviceable" };
        };

        const unserviceable = await shiprocket.checkPincodeServiceability("000000", { isCod: false });
        assert.equal(unserviceable.serviceable, false);
        assert.equal(unserviceable.outcome, "unserviceable");

        const codUnavailable = await shiprocket.checkPincodeServiceability("111111", { isCod: true });
        assert.equal(codUnavailable.serviceable, true);
        assert.equal(codUnavailable.codAvailable, false);
        assert.equal(codUnavailable.outcome, "cod_unavailable");

        const unknownProvider = await shiprocket.checkPincodeServiceability("999999", { isCod: true });
        assert.equal(unknownProvider.serviceable, null);
        assert.equal(unknownProvider.outcome, "unknown");

        const serviceable = await shiprocket.checkPincodeServiceability("812001", { isCod: true });
        assert.equal(serviceable.serviceable, true);
        assert.equal(serviceable.codAvailable, true);
        assert.equal(serviceable.outcome, "serviceable");
    });

    test("2. Courier delivery with all browsers closed updates DB via background tracking sweep", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "shipped",
            reservation: { state: "return_pending" },
            shiprocket: {
                orderId: 10101,
                awbCode: "AWB_BACKGROUND_SYNC_TEST",
                courierName: "BlueDart",
                status: "Shipped",
            },
        });

        // Mock Shiprocket tracking delivering parcel
        shiprocket.trackByAWB = async (awb) => ({
            tracking_data: {
                shipment_track: [{
                    awb_code: awb,
                    current_status: "Delivered",
                    status_code: 7, // Delivered
                }],
            },
        });

        const sweepResult = await runTrackingSweep(10);
        assert.ok(sweepResult.synced >= 1, "Tracking sweep must sync active order");

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.status, "delivered", "Order status must advance to delivered in DB");
        assert.equal(reloaded.shiprocket.status, "Delivered");
    });

    test("3. Duplicate and out-of-order tracking events cannot regress delivered/advanced status", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "prepaid", status: "paid" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "delivered", // Already delivered!
            reservation: { state: "return_pending" },
            shiprocket: {
                orderId: 20202,
                awbCode: "AWB_OUT_OF_ORDER_TEST",
                courierName: "Delhivery",
                status: "Delivered",
            },
        });

        // Older, stale tracking payload arriving late:
        const stalePayload = {
            tracking_data: {
                shipment_track: [{
                    awb_code: "AWB_OUT_OF_ORDER_TEST",
                    current_status: "In Transit",
                    status_code: 18, // In Transit
                }],
            },
        };

        await syncOrderFromShipment(order, stalePayload);

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.status, "delivered", "Delivered status must NOT regress from out-of-order In Transit scan");
    });

    test("4. Delivered COD is not automatically marked remitted; manual reconciliation updates accounting", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending", amountPaid: 0 },
            pricing: { subtotal: 1999, total: 1999 },
            status: "out_for_delivery",
            reservation: { state: "return_pending" },
            codAccounting: {
                amountDuePaise: 199900,
                remittanceStatus: "none",
            },
            shiprocket: {
                orderId: 30303,
                awbCode: "AWB_COD_DELIVERY_TEST",
                status: "Out for Delivery",
            },
        });

        // 1. Delivery scan arrives
        await syncOrderFromShipment(order, {
            tracking_data: {
                shipment_track: [{
                    awb_code: "AWB_COD_DELIVERY_TEST",
                    current_status: "Delivered",
                    status_code: 7,
                }],
            },
        });

        const deliveredOrder = await Order.findById(order._id);
        assert.equal(deliveredOrder.status, "delivered");
        assert.equal(deliveredOrder.codAccounting.collectedAtDelivery, true);
        assert.equal(deliveredOrder.codAccounting.remittanceStatus, "pending", "Remittance must be PENDING, not automatically remitted");
        assert.equal(deliveredOrder.payment.status, "pending", "Payment status must remain pending until bank remittance is confirmed");

        // 2. Admin explicitly reconciles courier remittance
        const req = {
            params: { id: order._id.toString() },
            admin: testAdmin,
            body: {
                action: "confirm_remittance",
                amount: 1999,
                utr: "CMS_REF_123456",
                notes: "Verified in bank statement",
            },
        };
        let resJson = null;
        const res = { status: () => res, json: (data) => { resJson = data; return res; } };

        await orderController.codReconcileOrder(req, res);
        assert.equal(resJson.success, true);

        const remittedOrder = await Order.findById(order._id);
        assert.equal(remittedOrder.codAccounting.remittanceStatus, "remitted");
        assert.equal(remittedOrder.codAccounting.remittedAmountPaise, 199900);
        assert.equal(remittedOrder.codAccounting.utr, "CMS_REF_123456");
        assert.equal(remittedOrder.payment.status, "paid", "Payment status becomes paid once remittance is confirmed in bank");
    });

    test("5. Physical return confirmation restores stock exactly once; repeat call is idempotent", async () => {
        const prod = await seedProduct(10);
        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 2 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "card", status: "paid", amountPaid: 399800 },
            pricing: { subtotal: 3998, total: 3998 },
            status: "delivered",
            reservation: { state: "return_pending" },
        });

        // Call 1: Confirm return with restock = true
        const req1 = {
            params: { id: order._id.toString() },
            admin: testAdmin,
            body: { restock: true, condition: "intact", notes: "Item inspected and intact" },
        };
        let resJson1 = null;
        const res1 = { status: () => res1, json: (data) => { resJson1 = data; return res1; } };

        await orderController.confirmReturnOrder(req1, res1);
        assert.equal(resJson1.success, true);
        assert.equal(resJson1.stockRestored, true);

        const prodAfterCall1 = await Product.findById(prod._id);
        assert.equal(prodAfterCall1.stock, 12, "Stock must increment by 2 upon verified intact return");

        // Call 2: Duplicate confirmation
        let resJson2 = null;
        const res2 = { status: () => res2, json: (data) => { resJson2 = data; return res2; } };

        await orderController.confirmReturnOrder(req1, res2);
        assert.equal(resJson2.alreadyRestored, true);

        const prodAfterCall2 = await Product.findById(prod._id);
        assert.equal(prodAfterCall2.stock, 12, "Stock must NOT increment a second time");
    });

    test("6. Physical return of damaged items does NOT increment product stock", async () => {
        const prod = await seedProduct(8);
        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "card", status: "paid", amountPaid: 199900 },
            pricing: { subtotal: 1999, total: 1999 },
            status: "delivered",
            reservation: { state: "return_pending" },
        });

        const req = {
            params: { id: order._id.toString() },
            admin: testAdmin,
            body: { restock: false, condition: "damaged", notes: "Saree torn in transit" },
        };
        let resJson = null;
        const res = { status: () => res, json: (data) => { resJson = data; return res; } };

        await orderController.confirmReturnOrder(req, res);
        assert.equal(resJson.success, true);
        assert.equal(resJson.stockRestored, false);

        const reloadedProd = await Product.findById(prod._id);
        assert.equal(reloadedProd.stock, 8, "Stock must remain unchanged for damaged goods");

        const reloadedOrder = await Order.findById(order._id);
        assert.equal(reloadedOrder.status, "returned");
        assert.equal(reloadedOrder.returnInfo.stockRestored, false);
    });

    test("7. Blocked admin transitions show actionable backend explanations", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "placed",
            reservation: { state: "held" },
        });

        // Disallowed forward transition: skipping from placed directly to delivered
        await assert.rejects(
            async () => {
                await executeOrderTransition(order._id, "delivered", { adminUser: testAdmin });
            },
            (err) => {
                assert.match(err.message, /Invalid status transition from "placed" to "delivered"/i);
                return true;
            }
        );
    });

    test("8. Admin can identify and resolve fulfillment hold", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "card", status: "paid", amountPaid: 199900 },
            pricing: { subtotal: 1999, total: 1999 },
            status: "processing",
            reservation: { state: "held" },
            fulfillmentHold: {
                active: true,
                reason: "Payment captured after inventory was released — manual review required.",
            },
        });

        // Admin resolves the hold
        const req = {
            params: { id: order._id.toString() },
            admin: testAdmin,
            body: { action: "clear_hold", notes: "Customer confirmed inventory allocation" },
        };
        let resJson = null;
        const res = { status: () => res, json: (data) => { resJson = data; return res; } };

        await orderController.resolveHoldOrder(req, res);
        assert.equal(resJson.success, true);

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.fulfillmentHold.active, false, "Fulfillment hold must be cleared");
        assert.equal(reloaded.fulfillmentHold.reallocationOutcome, "success");
    });

    test("9. Create response arriving after admin progression does not reset status", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "processing", // Admin moved status to processing
            reservation: { state: "held" },
            fulfillment: {
                stage: "create_uncertain",
                lockOwner: "worker-test-1",
            },
        });

        // Simulate Shiprocket order create response completing
        const res = await Order.updateOne(
            { _id: order._id, "fulfillment.lockOwner": "worker-test-1" },
            {
                $set: {
                    "shiprocket.orderId": 444444,
                    "shiprocket.shipmentId": 555555,
                    "fulfillment.stage": "sr_created",
                    "fulfillment.lockUntil": null,
                },
            }
        );
        assert.equal(res.modifiedCount, 1);

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.status, "processing", "Order status must remain processing and NOT reset to placed/confirmed");
        assert.equal(reloaded.fulfillment.stage, "sr_created");
    });

    test("10. Worker takeover rejects stale writes from expired lease owner", async () => {
        const prod = await seedProduct(5);
        const order = await Order.create({
            orderId: makeId(),
            items: [{ productId: prod._id, name: prod.name, price: 1999, quantity: 1 }],
            shippingAddress: { firstName: "Test", email: "test@example.com", phone: "9111111111", address: "X", city: "Y", state: "Bihar", pincode: "812001" },
            payment: { method: "cod", status: "pending" },
            pricing: { subtotal: 1999, total: 1999 },
            status: "processing",
            reservation: { state: "held" },
            fulfillment: {
                stage: "create_uncertain",
                lockOwner: "stale-worker-A",
                lockUntil: new Date(Date.now() - 5000), // Expired
            },
        });

        // Worker B takes over because Worker A's lease expired
        const claimed = await Order.findOneAndUpdate(
            {
                _id: order._id,
                $or: [
                    { "fulfillment.lockUntil": null },
                    { "fulfillment.lockUntil": { $lt: new Date() } },
                ],
            },
            {
                $set: {
                    "fulfillment.lockOwner": "fresh-worker-B",
                    "fulfillment.lockUntil": new Date(Date.now() + 60000),
                },
            },
            { new: true }
        );
        assert.equal(claimed.fulfillment.lockOwner, "fresh-worker-B");

        // Stale Worker A attempts to write using its old lease
        const staleWriteRes = await Order.updateOne(
            { _id: order._id, "fulfillment.lockOwner": "stale-worker-A" },
            {
                $set: {
                    "fulfillment.stage": "sr_created",
                    "shiprocket.orderId": 999999,
                },
            }
        );

        assert.equal(staleWriteRes.modifiedCount, 0, "Stale worker write must match 0 documents and be rejected");

        const reloaded = await Order.findById(order._id);
        assert.equal(reloaded.fulfillment.lockOwner, "fresh-worker-B");
        assert.equal(reloaded.shiprocket?.orderId, undefined);
    });
});
