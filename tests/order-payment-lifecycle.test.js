import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/handloomer";

test("Order, Payment, and Abandonment Lifecycle Suite", async (t) => {
    let Order, Product, User;
    let testUser, testProduct, app, orderController;

    t.before(async () => {
        await mongoose.connect(MONGO_URI);
        Order = (await import("../models/orderModal.js")).default;
        Product = (await import("../models/productModal.js")).default;
        User = (await import("../models/userModal.js")).default;
        orderController = (await import("../controllers/orderController.js")).default;

        testUser = await User.create({
            name: "Lifecycle Tester",
            email: `tester-${Date.now()}@test.com`,
            phone: "9876543210",
            password: "password123",
            role: "user",
        });

        testProduct = await Product.create({
            name: "Banarasi Silk Saree",
            slug: `banarasi-silk-${Date.now()}`,
            sku: `BNS-${Date.now()}`,
            regularPrice: 3500,
            price: 2500,
            stock: 10,
            category: "Silk",
            shortDescription: "Handcrafted Banarasi Silk Saree",
            tags: "silk, saree, festive",
            mainImage: "https://example.com/test.jpg",
            color: "Red",
            material: "Pure Silk",
            sareeSize: "5.5 meters",
            blouseSize: "0.8 meters",
            washCare: "Dry clean only",
        });
    });

    t.after(async () => {
        if (testUser) await User.deleteOne({ _id: testUser._id });
        if (testProduct) await Product.deleteOne({ _id: testProduct._id });
        await Order.deleteMany({ user: testUser?._id });
        await mongoose.disconnect();
    });

    await t.test("1. Unpaid online order retains payment.status = pending and stock is reserved", async () => {
        const order = await Order.create({
            orderId: `HL-${Date.now()}-1`,
            user: testUser._id,
            items: [{
                productId: testProduct._id,
                name: testProduct.name,
                price: 2500,
                quantity: 2,
            }],
            pricing: {
                subtotal: 5000,
                shipping: 0,
                discount: 0,
                total: 5000,
            },
            shippingAddress: {
                firstName: "Tester",
                lastName: "User",
                email: testUser.email,
                phone: "9876543210",
                address: "123 Test St",
                city: "Varanasi",
                state: "UP",
                pincode: "221001",
            },
            payment: {
                method: "upi",
                status: "pending",
                gatewayOrderId: "order_mock_123",
                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            },
            reservation: {
                state: "held",
            },
            status: "placed",
        });

        assert.equal(order.status, "placed");
        assert.equal(order.payment.status, "pending");
        assert.equal(order.reservation.state, "held");

        // Verify getUserOrders enrichment
        const req = {
            query: { page: 1, limit: 10 },
            user: testUser,
        };
        let responseData = null;
        const res = {
            status: (code) => {
                assert.equal(code, 200);
                return {
                    json: (data) => { responseData = data; }
                };
            }
        };

        await orderController.getUserOrders(req, res);
        assert.ok(responseData?.orders?.length > 0);
        const fetched = responseData.orders.find(o => o.orderId === order.orderId);
        assert.ok(fetched);
        assert.equal(fetched.canResumePayment, true);
        assert.equal(fetched.canCancel, true);
    });

    await t.test("2. Customer can abandon unpaid checkout, releasing reservation cleanly", async () => {
        // Decrement product stock to simulate reservation
        await Product.updateOne({ _id: testProduct._id }, { $inc: { stock: -2 } });
        let p = await Product.findById(testProduct._id);
        const stockBefore = p.stock;

        const order = await Order.create({
            orderId: `HL-${Date.now()}-2`,
            user: testUser._id,
            items: [{
                productId: testProduct._id,
                name: testProduct.name,
                price: 2500,
                quantity: 2,
            }],
            pricing: {
                subtotal: 5000,
                shipping: 0,
                discount: 0,
                total: 5000,
            },
            shippingAddress: {
                firstName: "Tester",
                lastName: "User",
                email: testUser.email,
                phone: "9876543210",
                address: "123 Test St",
                city: "Varanasi",
                state: "UP",
                pincode: "221001",
            },
            payment: {
                method: "upi",
                status: "pending",
                gatewayOrderId: "order_mock_456",
                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            },
            reservation: {
                state: "held",
            },
            status: "placed",
        });

        const req = {
            body: { orderId: order.orderId, reason: "Customer abandoned checkout" },
            user: testUser,
        };
        let responseData = null;
        const res = {
            status: (code) => {
                assert.equal(code, 200);
                return {
                    json: (data) => { responseData = data; }
                };
            }
        };

        await orderController.abandonCheckout(req, res);
        assert.equal(responseData?.success, true);
        assert.equal(responseData?.finalized, true);

        // Verify DB order state
        const updatedOrder = await Order.findById(order._id);
        assert.equal(updatedOrder.status, "cancelled");
        assert.equal(updatedOrder.cancellation.status, "completed");
        assert.equal(updatedOrder.reservation.state, "released");

        // Verify product stock was restored
        p = await Product.findById(testProduct._id);
        assert.equal(p.stock, stockBefore + 2);

        // Verify idempotent second abandonment
        let secondData = null;
        const secondRes = {
            status: (code) => {
                assert.equal(code, 200);
                return {
                    json: (data) => { secondData = data; }
                };
            }
        };
        await orderController.abandonCheckout(req, secondRes);
        assert.equal(secondData?.alreadyCancelled, true);

        // Stock should NOT be double restored
        const finalP = await Product.findById(testProduct._id);
        assert.equal(finalP.stock, p.stock);
    });

    await t.test("3. Unauthorized caller cannot abandon an order", async () => {
        const order = await Order.create({
            orderId: `HL-${Date.now()}-3`,
            user: testUser._id,
            items: [],
            pricing: { subtotal: 1000, shipping: 0, discount: 0, total: 1000 },
            shippingAddress: {
                firstName: "A",
                lastName: "B",
                email: testUser.email,
                phone: "9876543210",
                address: "123 St",
                city: "City",
                state: "State",
                pincode: "110001",
            },
            payment: { method: "upi", status: "pending" },
            reservation: { state: "held" },
            status: "placed",
        });

        const wrongUser = { _id: new mongoose.Types.ObjectId(), email: "hacker@test.com" };
        const req = {
            body: { orderId: order.orderId },
            user: wrongUser,
        };
        const res = {
            status: () => ({ json: () => {} }),
        };

        await assert.rejects(
            async () => {
                await orderController.abandonCheckout(req, res);
            },
            (err) => err.statusCode === 403 || err.status === 403
        );
    });

    await t.test("4. Cannot abandon a paid or Cash on Delivery order", async () => {
        const codOrder = await Order.create({
            orderId: `HL-${Date.now()}-4`,
            user: testUser._id,
            items: [],
            pricing: { subtotal: 1000, shipping: 0, discount: 0, total: 1000 },
            shippingAddress: {
                firstName: "A",
                lastName: "B",
                email: testUser.email,
                phone: "9876543210",
                address: "123 St",
                city: "City",
                state: "State",
                pincode: "110001",
            },
            payment: { method: "cod", status: "pending" },
            reservation: { state: "held" },
            status: "placed",
        });

        const req = {
            body: { orderId: codOrder.orderId },
            user: testUser,
        };
        const res = {
            status: () => ({ json: () => {} }),
        };

        await assert.rejects(
            async () => {
                await orderController.abandonCheckout(req, res);
            },
            (err) => err.statusCode === 400 || err.status === 400
        );
    });
});
