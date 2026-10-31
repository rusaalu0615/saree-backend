import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import User from "../models/userModal.js";
import Review from "../models/reviewModal.js";
import Contact from "../models/contactModal.js";
import productController from "../controllers/productController.js";
import reviewController, { updateProductRatingStats } from "../controllers/reviewController.js";
import orderController from "../controllers/orderController.js";
import adminController from "../controllers/adminController.js";
import contactController from "../controllers/contactController.js";

const MONGO_URI = process.env.TEST_MONGO_URI || (
    process.env.MONGO_URI ? process.env.MONGO_URI.replace(/\/([^\/?]+)(\?|$)/, '/$1_test$2') : null
);

describe("PHASE 5: Storefront, Communication, and Reporting Acceptance Suite", () => {
    let testUser;
    let testAdmin;

    before(async () => {
        if (!MONGO_URI) throw new Error("MONGO_URI not configured");
        await mongoose.connect(MONGO_URI);

        const suffix = Date.now();
        testUser = await User.create({
            name: "Phase 5 Shopper",
            email: `shopper_${suffix}@example.com`,
            phone: "9876543210",
        });

        testAdmin = await User.create({
            name: "Phase 5 Admin",
            email: `admin_${suffix}@example.com`,
            phone: "9123456789",
            role: "admin",
        });
    });

    after(async () => {
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
        }
    });

    function makeId() {
        return `P5-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }

    // Helper to mock express res
    function createMockRes() {
        const res = {
            statusCode: 200,
            data: null,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                this.data = payload;
                return this;
            },
        };
        return res;
    }

    test("1. Product filters: independent filter groups combine with AND, OR only within one group", async () => {
        const batchTag = makeId();
        // Product A: Red Linen
        const prodA = await Product.create({
            name: `Saree Red Linen ${batchTag}`,
            sku: `SKU-A-${batchTag}`,
            category: "Linen",
            color: "Red",
            material: "Pure Linen",
            price: 2500,
            regularPrice: 3000,
            stock: 10,
            mainImage: "https://example.com/saree-a.jpg",
            shortDescription: "A fine red linen saree",
            tags: "linen, red",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean",
        });

        // Product B: Blue Linen
        const prodB = await Product.create({
            name: `Saree Blue Linen ${batchTag}`,
            sku: `SKU-B-${batchTag}`,
            category: "Linen",
            color: "Blue",
            material: "Pure Linen",
            price: 2600,
            regularPrice: 3100,
            stock: 10,
            mainImage: "https://example.com/saree-b.jpg",
            shortDescription: "A fine blue linen saree",
            tags: "linen, blue",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean",
        });

        // Product C: Red Silk (different category)
        const prodC = await Product.create({
            name: `Saree Red Silk ${batchTag}`,
            sku: `SKU-C-${batchTag}`,
            category: "Silk",
            color: "Red",
            material: "Tussar Silk",
            price: 4500,
            regularPrice: 5000,
            stock: 5,
            mainImage: "https://example.com/saree-c.jpg",
            shortDescription: "A fine red silk saree",
            tags: "silk, red",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean",
        });

        // Query: category=Linen AND color=Red,Blue (OR within color group)
        const req = {
            query: {
                category: "Linen",
                color: "Red,Blue",
                limit: "50",
            },
        };
        const res = createMockRes();
        await productController.getAllProducts(req, res);

        assert.equal(res.statusCode, 200);
        const returnedIds = res.data.products.map((p) => p._id.toString());
        assert.ok(returnedIds.includes(prodA._id.toString()), "Product A (Red Linen) should match");
        assert.ok(returnedIds.includes(prodB._id.toString()), "Product B (Blue Linen) should match");
        assert.ok(!returnedIds.includes(prodC._id.toString()), "Product C (Red Silk) must NOT match due to category AND");
    });

    test("2. Exact intersection check: isOnSale and isFestive combined queries return only products matching BOTH", async () => {
        const batchTag = makeId();

        // 1: On sale only
        const prodSale = await Product.create({
            name: `Sale Only ${batchTag}`,
            sku: `SKU-S-${batchTag}`,
            category: "Cotton",
            color: "Yellow",
            material: "Cotton",
            price: 1500,
            regularPrice: 2000,
            stock: 5,
            isOnSale: true,
            isFestive: false,
            mainImage: "https://example.com/sale.jpg",
            shortDescription: "Sale item",
            tags: "sale",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Hand wash",
        });

        // 2: Festive only
        const prodFestive = await Product.create({
            name: `Festive Only ${batchTag}`,
            sku: `SKU-F-${batchTag}`,
            category: "Cotton",
            color: "Green",
            material: "Cotton",
            price: 2200,
            regularPrice: 2500,
            stock: 5,
            isOnSale: false,
            isFestive: true,
            mainImage: "https://example.com/festive.jpg",
            shortDescription: "Festive item",
            tags: "festive",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Hand wash",
        });

        // 3: Both On Sale AND Festive (the intersection)
        const prodBoth = await Product.create({
            name: `Sale and Festive ${batchTag}`,
            sku: `SKU-SF-${batchTag}`,
            category: "Cotton",
            color: "Gold",
            material: "Cotton",
            price: 1800,
            regularPrice: 2400,
            stock: 5,
            isOnSale: true,
            isFestive: true,
            mainImage: "https://example.com/both.jpg",
            shortDescription: "Both sale and festive",
            tags: "sale, festive",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Hand wash",
        });

        // Query for BOTH isOnSale=true AND isFestive=true
        const req = {
            query: {
                isOnSale: "true",
                isFestive: "true",
                limit: "50",
            },
        };
        const res = createMockRes();
        await productController.getAllProducts(req, res);

        assert.equal(res.statusCode, 200);
        const returnedIds = res.data.products.map((p) => p._id.toString());
        assert.ok(returnedIds.includes(prodBoth._id.toString()), "Product with both attributes MUST be returned");
        assert.ok(!returnedIds.includes(prodSale._id.toString()), "Sale-only product MUST NOT be returned in intersection query");
        assert.ok(!returnedIds.includes(prodFestive._id.toString()), "Festive-only product MUST NOT be returned in intersection query");
    });

    test("3. Review ratings aggregation: converts productId to ObjectId and recalculates accurately", async () => {
        const batchTag = makeId();
        const product = await Product.create({
            name: `Review Saree ${batchTag}`,
            sku: `SKU-REV-${batchTag}`,
            category: "Organza",
            color: "Pink",
            material: "Organza",
            price: 3200,
            regularPrice: 3500,
            stock: 10,
            mainImage: "https://example.com/review.jpg",
            shortDescription: "Review item",
            tags: "review",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean",
            averageRating: 0,
            numReviews: 0,
        });

        // Seed 2 reviews for this product
        await Review.create([
            {
                user: testUser._id,
                product: product._id,
                rating: 5,
                title: "Magnificent drape",
                comment: "Absolutely love the texture and shine.",
            },
            {
                user: testAdmin._id,
                product: product._id,
                rating: 4,
                title: "Great quality",
                comment: "Very elegant, fast shipping.",
            },
        ]);

        // Trigger rating recalculation using string productId (simulating route param)
        const stats = await updateProductRatingStats(product._id.toString());
        assert.ok(stats, "Stats must not be null");
        assert.equal(stats.numReviews, 2, "Must aggregate 2 stored reviews");
        assert.equal(stats.averageRating, 4.5, "Average rating must be (5+4)/2 = 4.5");

        const reloaded = await Product.findById(product._id);
        assert.equal(reloaded.numReviews, 2);
        assert.equal(reloaded.averageRating, 4.5);
    });

    test("4. Review deletion: deleting review updates product rating stats immediately", async () => {
        const batchTag = makeId();
        const product = await Product.create({
            name: `Review Deletion Saree ${batchTag}`,
            sku: `SKU-DEL-${batchTag}`,
            category: "Chiffon",
            color: "Peach",
            material: "Chiffon",
            price: 2100,
            regularPrice: 2400,
            stock: 10,
            mainImage: "https://example.com/del.jpg",
            shortDescription: "Del item",
            tags: "del",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean",
        });

        const review = await Review.create({
            user: testUser._id,
            product: product._id,
            rating: 5,
            title: "Superb saree",
            comment: "Loved everything about it.",
        });

        // Initial sync
        await updateProductRatingStats(product._id);
        let prod = await Product.findById(product._id);
        assert.equal(prod.numReviews, 1);
        assert.equal(prod.averageRating, 5);

        // Delete review via reviewController.deleteReview
        const req = {
            params: { id: review._id.toString() },
            user: testUser,
        };
        const res = createMockRes();
        await reviewController.deleteReview(req, res);

        assert.equal(res.statusCode, 200);
        prod = await Product.findById(product._id);
        assert.equal(prod.numReviews, 0, "numReviews must reset to 0 after deleting all reviews");
        assert.equal(prod.averageRating, 0, "averageRating must reset to 0 after deleting all reviews");
    });

    test("5. Bounded review pagination: caps limit to 50 and handles page offset", async () => {
        const batchTag = makeId();
        const product = await Product.create({
            name: `Review Paging Saree ${batchTag}`,
            sku: `SKU-PAGE-${batchTag}`,
            category: "Georgette",
            color: "Teal",
            material: "Georgette",
            price: 2900,
            regularPrice: 3200,
            stock: 10,
            mainImage: "https://example.com/page.jpg",
            shortDescription: "Page item",
            tags: "page",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean",
        });

        const req = {
            params: { id: product._id.toString() },
            query: { page: "1", limit: "999" }, // Requesting excessive limit
        };
        const res = createMockRes();
        await reviewController.getProductReviews(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.data.pagination.limit, 50, "Limit must be capped at 50");
        assert.equal(res.data.pagination.page, 1);
    });

    test("6. Bounded catalogue fetching: getAllProducts enforces default and maximum page sizes", async () => {
        // Test default limit when none provided
        const reqDefault = { query: {} };
        const resDefault = createMockRes();
        await productController.getAllProducts(reqDefault, resDefault);

        assert.equal(resDefault.statusCode, 200);
        assert.ok(resDefault.data.pagination, "Pagination metadata must be present");
        assert.equal(resDefault.data.pagination.limit, 20, "Default page limit must be 20");

        // Test excessive limit capped at 100
        const reqMax = { query: { limit: "500" } };
        const resMax = createMockRes();
        await productController.getAllProducts(reqMax, resMax);

        assert.equal(resMax.statusCode, 200);
        assert.equal(resMax.data.pagination.limit, 100, "Maximum limit must be capped at 100");
    });

    test("7. Admin order search: searches recipient firstName, email, phone, and orderId across guest and account orders", async () => {
        const orderIdA = `ORD-P5-GUEST-${Date.now()}`;
        const orderIdB = `ORD-P5-USER-${Date.now()}`;

        // Guest order with specific recipient details
        await Order.create({
            orderId: orderIdA,
            isGuest: true,
            status: "placed",
            items: [{ productId: new mongoose.Types.ObjectId(), name: "Saree", quantity: 1, price: 1999 }],
            pricing: { subtotal: 1999, total: 1999 },
            shippingAddress: {
                firstName: "Ananya",
                lastName: "Sharma",
                email: "ananya.guest@example.com",
                phone: "9876500001",
                address: "Flat 101, MG Road",
                city: "Bengaluru",
                pincode: "560001",
                state: "Karnataka",
            },
            payment: { method: "cod", status: "pending" },
            reservation: { state: "held", expiresAt: new Date(Date.now() + 3600000) },
        });

        // Registered user order
        await Order.create({
            orderId: orderIdB,
            user: testUser._id,
            isGuest: false,
            status: "placed",
            items: [{ productId: new mongoose.Types.ObjectId(), name: "Saree", quantity: 1, price: 2499 }],
            pricing: { subtotal: 2499, total: 2499 },
            shippingAddress: {
                firstName: "Pooja",
                lastName: "Verma",
                email: "pooja.user@example.com",
                phone: "9876500002",
                address: "Plot 42, Park Street",
                city: "Kolkata",
                pincode: "700016",
                state: "West Bengal",
            },
            payment: { method: "prepaid", status: "paid" },
            reservation: { state: "held" },
        });

        // Search by guest recipient first name
        const reqGuest = { query: { search: "Ananya" }, admin: testAdmin };
        const resGuest = createMockRes();
        await orderController.getAllOrders(reqGuest, resGuest);

        assert.equal(resGuest.statusCode, 200);
        const guestOrderFound = resGuest.data.orders.some((o) => o.orderId === orderIdA);
        assert.ok(guestOrderFound, "Guest order must be found by recipient first name");

        // Search by user orderId
        const reqUser = { query: { search: orderIdB }, admin: testAdmin };
        const resUser = createMockRes();
        await orderController.getAllOrders(reqUser, resUser);

        assert.equal(resUser.statusCode, 200);
        const userOrderFound = resUser.data.orders.some((o) => o.orderId === orderIdB);
        assert.ok(userOrderFound, "User order must be found by exact order ID");
    });

    test("8. Admin order pagination: stable sorting and valid pagination metadata", async () => {
        const req = { query: { page: "1", limit: "5" }, admin: testAdmin };
        const res = createMockRes();
        await orderController.getAllOrders(req, res);

        assert.equal(res.statusCode, 200);
        assert.ok(res.data.pagination);
        assert.equal(res.data.pagination.page, 1);
        assert.equal(res.data.pagination.limit, 5);
        assert.ok(res.data.pagination.totalCount >= 2);
        assert.ok(res.data.pagination.totalPages >= 1);
    });

    test("9. Contact form submission: validates inputs and persists contact inquiry", async () => {
        const suffix = Date.now();
        const req = {
            ip: `192.168.1.${Math.floor(Math.random() * 250)}`,
            headers: {},
            body: {
                name: "Rukmini Devi",
                email: `rukmini_${suffix}@example.com`,
                phone: "9988776655",
                message: "I would like to inquire about customized festive bulk orders for our family wedding.",
            },
        };
        const res = createMockRes();
        await contactController.submitContactMessage(req, res);

        assert.equal(res.statusCode, 201);
        assert.equal(res.data.success, true);
        assert.ok(res.data.contactId, "Must return created contact ID");

        const saved = await Contact.findById(res.data.contactId);
        assert.ok(saved);
        assert.equal(saved.email, `rukmini_${suffix}@example.com`);
        assert.equal(saved.status, "new");
    });

    test("10. Contact form rate limiting and validation: rejects invalid email and short messages", async () => {
        // Missing name
        const reqNoName = {
            ip: "10.0.0.1",
            body: { email: "test@example.com", message: "Hello world!" },
        };
        const resNoName = createMockRes();
        await assert.rejects(
            async () => contactController.submitContactMessage(reqNoName, resNoName),
            /Name is required/
        );

        // Invalid email
        const reqBadEmail = {
            ip: "10.0.0.2",
            body: { name: "Tester", email: "not-an-email", message: "Valid inquiry message." },
        };
        const resBadEmail = createMockRes();
        await assert.rejects(
            async () => contactController.submitContactMessage(reqBadEmail, resBadEmail),
            /Please provide a valid email address/
        );

        // Message too short
        const reqShort = {
            ip: "10.0.0.3",
            body: { name: "Tester", email: "test@example.com", message: "Hi" },
        };
        const resShort = createMockRes();
        await assert.rejects(
            async () => contactController.submitContactMessage(reqShort, resShort),
            /Message must be at least 5 characters/
        );
    });

    test("11. Financial metrics separation: distinctly calculates Gross Order Value, Prepaid, COD, Refunds, and Net Revenue", async () => {
        const suffix = Date.now();

        // Order 1: Captured Prepaid ₹2000
        await Order.create({
            orderId: `ORD-FIN-1-${suffix}`,
            status: "delivered",
            items: [{ productId: new mongoose.Types.ObjectId(), name: "Saree", quantity: 1, price: 2000 }],
            pricing: { subtotal: 2000, total: 2000 },
            shippingAddress: { firstName: "A", lastName: "B", email: "a@b.com", phone: "9876543210", address: "X", city: "Y", pincode: "110001", state: "Delhi" },
            payment: { method: "prepaid", status: "paid", amountPaid: 2000 },
            reservation: { state: "held" },
        });

        // Order 2: Delivered COD with collected cash ₹1500, remittance pending
        await Order.create({
            orderId: `ORD-FIN-2-${suffix}`,
            status: "delivered",
            items: [{ productId: new mongoose.Types.ObjectId(), name: "Saree", quantity: 1, price: 1500 }],
            pricing: { subtotal: 1500, total: 1500 },
            shippingAddress: { firstName: "C", lastName: "D", email: "c@d.com", phone: "9876543210", address: "X", city: "Y", pincode: "110001", state: "Delhi" },
            payment: { method: "cod", status: "pending" },
            codAccounting: {
                collectedAtDelivery: true,
                collectedAmountPaise: 150000,
                remittanceStatus: "pending",
                amountDuePaise: 150000,
            },
            reservation: { state: "held" },
        });

        // Order 3: Cancelled order with processed refund ₹1000
        await Order.create({
            orderId: `ORD-FIN-3-${suffix}`,
            status: "cancelled",
            items: [{ productId: new mongoose.Types.ObjectId(), name: "Saree", quantity: 1, price: 1000 }],
            pricing: { subtotal: 1000, total: 1000 },
            shippingAddress: { firstName: "E", lastName: "F", email: "e@f.com", phone: "9876543210", address: "X", city: "Y", pincode: "110001", state: "Delhi" },
            payment: { method: "prepaid", status: "refunded", amountPaid: 1000, refundedAmount: 1000 },
            refund: { status: "processed", amountPaise: 100000 },
            reservation: { state: "released" },
        });

        const req = {};
        const res = createMockRes();
        await adminController.getDashboardStats(req, res);

        assert.equal(res.statusCode, 200);
        const financials = res.data.stats.financials;
        assert.ok(financials, "Financials object must be present");
        assert.ok(financials.grossOrderValue >= 3500, "Gross order value includes non-cancelled orders (2000 + 1500)");
        assert.ok(financials.capturedPrepaid >= 3000, "Captured prepaid includes paid orders (2000 + 1000)");
        assert.ok(financials.confirmedCodCollected >= 1500, "Confirmed COD collected includes collected COD (1500)");
        assert.ok(financials.processedRefunds >= 1000, "Processed refunds includes refunded amount (1000)");
        assert.ok(financials.codRemittancePending >= 1500, "COD remittance pending includes pending remittances (1500)");

        // Net revenue calculation: (Prepaid + Confirmed COD) - Refunds
        const expectedNetMin = (financials.capturedPrepaid + financials.confirmedCodCollected) - financials.processedRefunds;
        assert.equal(financials.netCollectedAmount, expectedNetMin, "Net collected amount must strictly equal (Prepaid + COD) - Refunds");
        assert.equal(res.data.stats.revenue.total, financials.netCollectedAmount, "Reported total revenue must match net collected cash, not gross order value");
    });

    test("12. Customer analytics: calculates customer spend based on collected spend and computes global VIP count", async () => {
        const req = { query: { page: "1", limit: "20" } };
        const res = createMockRes();
        await adminController.getCustomers(req, res);

        assert.equal(res.statusCode, 200);
        assert.ok(res.data.customers);
        assert.ok(res.data.summary);
        assert.ok(typeof res.data.summary.total === "number");
        assert.ok(typeof res.data.summary.active === "number");
        assert.ok(typeof res.data.summary.vip === "number");
        assert.ok(typeof res.data.summary.totalRevenue === "number");

        // Verify each customer has non-negative collected totalSpent
        for (const customer of res.data.customers) {
            assert.ok(customer.totalSpent >= 0, "Customer totalSpent must be non-negative");
            if (customer.totalSpent >= 10000) {
                assert.equal(customer.status, "vip", "Customer with >= 10,000 spend must be VIP");
            }
        }
    });
});
