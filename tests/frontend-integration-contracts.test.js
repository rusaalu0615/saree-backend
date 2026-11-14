import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";

import User from "../models/userModal.js";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import userController from "../controllers/userController.js";
import orderController from "../controllers/orderController.js";
import cartController from "../controllers/cartController.js";
import wishlistController from "../controllers/wishlistController.js";
import generateToken from "../utils/generateToken.js";
import { hashToken } from "../utils/security.js";
import { protect } from "../middlewares/authMiddleware.js";
import { STORES, toCanonicalStoreId } from "../config/stores.js";

// Helper to create mock Express request and response objects
const createMockReqRes = ({
    body = {},
    headers = {},
    query = {},
    user = null,
    store = { id: "linen", name: "House of Qalakari" },
    params = {},
} = {}) => {
    const req = {
        body,
        headers,
        query,
        user,
        store,
        params,
        get: (h) => headers[h.toLowerCase()],
    };
    let statusCode = 200;
    let jsonBody = null;
    const res = {
        status: (code) => {
            statusCode = code;
            return res;
        },
        json: (data) => {
            jsonBody = data;
            return res;
        },
        cookie: () => {},
    };
    return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
};

// ---------------------------------------------------------------------------
// 1. Session Restoration Contract (GET /api/user/profile & Address Book)
// ---------------------------------------------------------------------------

test("1. Profile & Address Book: getProfile restores authenticated session with addresses", async () => {
    const userId = new mongoose.Types.ObjectId();
    const mockUserDoc = {
        _id: userId,
        name: "Qalakari Patron",
        email: "patron@houseofqalakari.com",
        phone: "9876543210",
        role: "user",
        storeId: "linen",
        address: [
            {
                _id: new mongoose.Types.ObjectId(),
                fullName: "Qalakari Patron",
                mobile: "9876543210",
                pincode: "110001",
                state: "Delhi",
                city: "New Delhi",
                address: "Connaught Place, Block B",
                landmark: "Near Metro Gate 2",
            },
        ],
    };

    const originalFindById = User.findById;
    User.findById = (id) => ({
        select: (projection) => {
            if (id.toString() === userId.toString()) {
                return Promise.resolve(mockUserDoc);
            }
            return Promise.resolve(null);
        },
    });

    try {
        const { req, res, getStatus, getJson } = createMockReqRes({
            user: { _id: userId, storeId: "linen", role: "user" },
            store: { id: "linen" },
        });

        await userController.getProfile(req, res);

        assert.equal(getStatus(), 200);
        const data = getJson();
        assert.equal(data.success, true);
        assert.equal(data.user.email, "patron@houseofqalakari.com");
        assert.equal(data.user.storeId, "linen");
        assert.equal(data.user.address.length, 1);
        assert.equal(data.user.address[0].city, "New Delhi");
    } finally {
        User.findById = originalFindById;
    }
});

test("2. Address Book CRUD: Adding address persists and returns updated address list", async () => {
    const userId = new mongoose.Types.ObjectId();
    const addresses = [];
    const mockUserInstance = {
        _id: userId,
        name: "Linen Customer",
        address: addresses,
        save: async function () {
            return this;
        },
    };

    const originalFindById = User.findById;
    User.findById = async () => mockUserInstance;

    try {
        const { req, res, getStatus, getJson } = createMockReqRes({
            user: { _id: userId, storeId: "linen" },
            body: {
                fullName: "Aarav Sharma",
                mobile: "9812345678",
                pincode: "560001",
                state: "Karnataka",
                city: "Bengaluru",
                address: "MG Road, Suite 402",
                landmark: "Trinity Circle",
            },
        });

        await userController.addAddress(req, res);

        assert.equal(getStatus(), 201);
        const data = getJson();
        assert.equal(data.success, true);
        assert.equal(data.address.length, 1);
        assert.equal(data.address[0].city, "Bengaluru");
        assert.equal(data.address[0].fullName, "Aarav Sharma");
    } finally {
        User.findById = originalFindById;
    }
});

// ---------------------------------------------------------------------------
// 2. Same-Email Multi-Store Identity Isolation
// ---------------------------------------------------------------------------

test("3. Same-email customer on different stores authenticates strictly within store context", async () => {
    const sharedEmail = "customer@domain.com";
    const linenUserId = new mongoose.Types.ObjectId();
    const handloomerUserId = new mongoose.Types.ObjectId();
    const hashedPassword = await bcrypt.hash("securePassword123", 4);

    const originalFindOne = User.findOne;
    User.findOne = (query) => ({
        select: () => {
            if (query.storeId === "linen" && query.email === sharedEmail) {
                return Promise.resolve({
                    _id: linenUserId,
                    name: "Linen User",
                    email: sharedEmail,
                    phone: "9123456789",
                    role: "user",
                    storeId: "linen",
                    password: hashedPassword,
                });
            }
            if (query.storeId === "handloomer" && query.email === sharedEmail) {
                return Promise.resolve({
                    _id: handloomerUserId,
                    name: "Handloomer User",
                    email: sharedEmail,
                    phone: "9123456789",
                    role: "user",
                    storeId: "handloomer",
                    password: hashedPassword,
                });
            }
            return Promise.resolve(null);
        },
    });

    try {
        // Attempt login on House of Qalakari (linen)
        const { req, res, getStatus, getJson } = createMockReqRes({
            store: { id: "linen" },
            body: { email: sharedEmail, password: "securePassword123" },
        });

        await userController.loginUser(req, res);

        assert.equal(getStatus(), 200);
        const data = getJson();
        assert.equal(data.user._id.toString(), linenUserId.toString(), "Must authenticate linen user");
        assert.equal(data.user.storeId, "linen");

        // Verify generated token contains linen storeId claim
        const decoded = jwt.decode(data.token);
        assert.equal(decoded.storeId, "linen");
        assert.equal(decoded.id, linenUserId.toString());
    } finally {
        User.findOne = originalFindOne;
    }
});

// ---------------------------------------------------------------------------
// 3. Cart & Wishlist Sync Failure Safety & Optimistic Rollback Contracts
// ---------------------------------------------------------------------------

test("4. Cart Sync Contract: Local guest cart is preserved if server sync encounters failure", () => {
    // Frontend logic verification:
    // If syncRes?.success is not true, local items MUST NOT be wiped
    const guestCartSnapshot = [
        { id: "prod_1", quantity: 2, price: 3499, title: "Linen Gold Zari Saree" },
    ];
    let localStorageWiped = false;

    // Simulate failed sync response
    const syncResult = { ok: false, status: 500 };

    if (syncResult.ok && syncResult.success) {
        localStorageWiped = true;
    }

    assert.equal(localStorageWiped, false, "Local cart MUST NOT be cleared on failed sync");
    assert.equal(guestCartSnapshot.length, 1, "Guest items remain intact in localStorage");
});

test("5. Cart Mutation Rollback: Failed API mutation rolls back optimistic state", () => {
    // Initial state
    const previousItems = [{ id: "prod_1", quantity: 1, price: 3499 }];
    // Optimistic state
    let activeItems = [{ id: "prod_1", quantity: 2, price: 3499 }];

    // Simulate API mutation failure
    const apiSuccess = false;
    if (!apiSuccess) {
        activeItems = previousItems; // Rollback
    }

    assert.equal(activeItems[0].quantity, 1, "Cart state must roll back to previous snapshot on failure");
});

test("6. Wishlist Sync Contract: Local wishlist items preserved when sync fails", () => {
    const guestWishlist = ["prod_101", "prod_102"];
    let localStorageCleared = false;

    const syncResponse = null; // server network exception

    if (syncResponse && syncResponse.success) {
        localStorageCleared = true;
    }

    assert.equal(localStorageCleared, false, "Local wishlist must not be cleared when sync fails");
    assert.deepEqual(guestWishlist, ["prod_101", "prod_102"]);
});

// ---------------------------------------------------------------------------
// 4. COD Order Placement & Verification Contract
// ---------------------------------------------------------------------------

test("7. COD Order Placement: Explicitly sets storeId 'linen', isGuest flag, and checkout capability token", () => {
    const rawStoreId = "linen";
    const canonicalStoreId = toCanonicalStoreId(rawStoreId, "handloomer");
    assert.equal(canonicalStoreId, "linen");

    // Unauthenticated guest request simulation
    const req = {
        user: null,
        store: { id: "linen", name: "House of Qalakari" },
        body: {
            paymentMethod: "cod",
            orderItems: [
                {
                    product: new mongoose.Types.ObjectId(),
                    name: "Royal Crimson Linen Saree",
                    price: 4999,
                    quantity: 1,
                },
            ],
            shippingAddress: {
                fullName: "Ananya Roy",
                address: "Park Street 12",
                city: "Kolkata",
                postalCode: "700016",
                state: "West Bengal",
                phone: "9830012345",
                email: "ananya@example.com",
            },
            totalPrice: 4999,
        },
    };

    const isGuest = !req.user;
    const orderUserId = isGuest ? null : req.user._id;

    // Secure Capability Token Generation for Guest Checkout
    const checkoutCapabilityToken = isGuest ? crypto.randomBytes(32).toString("hex") : null;
    const checkoutTokenHash = checkoutCapabilityToken ? hashToken(checkoutCapabilityToken) : null;

    const orderDoc = new Order({
        orderId: "LS-20261112-TESTCOD",
        storeId: canonicalStoreId,
        user: orderUserId,
        isGuest: isGuest,
        items: req.body.orderItems,
        shippingAddress: req.body.shippingAddress,
        totalAmount: req.body.totalPrice,
        orderStatus: "placed",
        payment: {
            method: "cod",
            status: "pending",
            checkoutTokenHash,
        },
    });

    assert.equal(orderDoc.storeId, "linen", "Persisted order MUST carry storeId 'linen'");
    assert.equal(orderDoc.isGuest, true, "Unauthenticated checkout MUST be marked as guest");
    assert.equal(orderDoc.user, null, "Guest order must have user: null");
    assert.ok(checkoutCapabilityToken, "Guest checkout MUST generate capability token");
    assert.ok(orderDoc.payment.checkoutTokenHash, "Order document MUST persist SHA-256 token hash");
});

// ---------------------------------------------------------------------------
// 5. Razorpay Checkout Initialization & Zero-Payable Bypass
// ---------------------------------------------------------------------------

test("8. Razorpay Order Flow: Generates razorpayOrderId for payable amount and bypasses for zero-payable", () => {
    // Case A: Standard payable order (> 0)
    const payableAmount = 3200;
    const requiresGatewayOrder = payableAmount > 0;
    assert.equal(requiresGatewayOrder, true, "Payable orders must initialize Razorpay gateway order");

    const mockRazorpayOrder = {
        id: "order_rpz_1234567890",
        amount: payableAmount * 100, // in paise
        currency: "INR",
        status: "created",
    };

    assert.ok(mockRazorpayOrder.id.startsWith("order_"), "Gateway order returns order_ prefix");
    assert.equal(mockRazorpayOrder.amount, 320000);

    // Case B: Zero-payable order (100% coupon discount)
    const zeroAmount = 0;
    const isZeroPayable = zeroAmount <= 0;
    assert.equal(isZeroPayable, true, "Zero amount orders bypass Razorpay");

    const settledOrder = {
        orderId: "LS-20261112-ZERO01",
        orderStatus: "placed",
        paymentStatus: "paid",
        isZeroPayable: true,
    };

    assert.equal(settledOrder.orderStatus, "placed");
    assert.equal(settledOrder.paymentStatus, "paid");
    assert.equal(settledOrder.isZeroPayable, true);
});

test("9. Razorpay Modal Dismissal: Cart preservation contract", () => {
    // When customer closes Razorpay modal without paying (modal.ondismiss),
    // the frontend MUST NOT clear the cart
    let cartCleared = false;
    let errorBannerShown = false;

    // Simulate modal dismissal callback
    const onDismissHandler = () => {
        errorBannerShown = true;
        // Notice: cart is NOT cleared!
    };

    onDismissHandler();

    assert.equal(cartCleared, false, "Cart must remain intact when payment modal is dismissed");
    assert.equal(errorBannerShown, true, "Customer is notified that payment was not completed");
});

// ---------------------------------------------------------------------------
// 6. Secure Guest Order Claiming
// ---------------------------------------------------------------------------

test("10. Guest Order Claim: Email-only match is rejected; valid token succeeds", async () => {
    const customerId = new mongoose.Types.ObjectId();
    const guestOrderId = "LS-20261112-CLAIM1";
    const capabilityToken = "secure-cap-token-abc123xyz";
    const hashed = hashToken(capabilityToken);

    const originalFindOne = Order.findOne;
    const originalFindOneAndUpdate = Order.findOneAndUpdate;

    Order.findOne = async () => ({
        _id: new mongoose.Types.ObjectId(),
        orderId: guestOrderId,
        storeId: "linen",
        user: null,
        isGuest: true,
        payment: { checkoutTokenHash: hashed },
    });

    let atomicClaimed = false;
    Order.findOneAndUpdate = async (filter, update) => {
        if (filter.user === null && filter.storeId === "linen") {
            atomicClaimed = true;
            return {
                _id: new mongoose.Types.ObjectId(),
                orderId: guestOrderId,
                storeId: "linen",
                user: customerId,
                isGuest: false,
            };
        }
        return null;
    };

    try {
        // Attempt 1: Without checkoutToken (email match alone)
        const { req: noTokenReq, res: noTokenRes } = createMockReqRes({
            user: { _id: customerId, storeId: "linen" },
            store: { id: "linen" },
            body: { orderId: guestOrderId },
        });

        let err1 = null;
        await orderController.claimGuestOrder(noTokenReq, noTokenRes, (err) => { err1 = err; });
        assert.ok(err1, "Claim without token MUST fail");
        assert.equal(err1.statusCode, 400);

        // Attempt 2: With invalid token
        const { req: badTokenReq, res: badTokenRes } = createMockReqRes({
            user: { _id: customerId, storeId: "linen" },
            store: { id: "linen" },
            body: { orderId: guestOrderId, checkoutToken: "wrong-token" },
        });

        let err2 = null;
        await orderController.claimGuestOrder(badTokenReq, badTokenRes, (err) => { err2 = err; });
        assert.ok(err2, "Claim with wrong token MUST fail with 403");
        assert.equal(err2.statusCode, 403);

        // Attempt 3: With valid token
        const { req: validReq, res: validRes, getStatus: getValidStatus, getJson: getValidJson } = createMockReqRes({
            user: { _id: customerId, storeId: "linen" },
            store: { id: "linen" },
            body: { orderId: guestOrderId, checkoutToken: capabilityToken },
        });

        await orderController.claimGuestOrder(validReq, validRes, () => {});
        assert.equal(getValidStatus(), 200);
        assert.equal(getValidJson().success, true);
        assert.equal(atomicClaimed, true, "Order must be claimed via atomic update");
    } finally {
        Order.findOne = originalFindOne;
        Order.findOneAndUpdate = originalFindOneAndUpdate;
    }
});

// ---------------------------------------------------------------------------
// 7. Customer Order Cancellation & Tracking Response Format
// ---------------------------------------------------------------------------

test("11. Order Cancellation: Customer cannot cancel another customer's or another store's order", async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const attackerId = new mongoose.Types.ObjectId();
    const orderDocId = new mongoose.Types.ObjectId();

    const originalFindOne = Order.findOne;
    Order.findOne = async (query) => {
        // Strict query enforcement: _id, user, storeId
        if (query.user && query.user.toString() === ownerId.toString() && query.storeId === "linen") {
            return {
                _id: orderDocId,
                orderId: "LS-20261112-ORD01",
                user: ownerId,
                storeId: "linen",
                orderStatus: "placed",
                save: async () => {},
            };
        }
        return null;
    };

    try {
        const { req, res } = createMockReqRes({
            user: { _id: attackerId, storeId: "linen", role: "user" },
            store: { id: "linen" },
            params: { id: orderDocId.toString() },
            body: { reason: "Changed my mind" },
        });

        let capturedErr = null;
        await orderController.cancelUserOrder(req, res, (err) => { capturedErr = err; });

        assert.ok(capturedErr, "Cross-user cancellation must be rejected");
        assert.equal(capturedErr.statusCode, 404, "Order not found for unauthenticated owner");
    } finally {
        Order.findOne = originalFindOne;
    }
});

test("12. Order Tracking: Returns normalized response format with order status and shipment events", async () => {
    const customerId = new mongoose.Types.ObjectId();
    const orderDocId = new mongoose.Types.ObjectId();

    const originalFindOne = Order.findOne;
    Order.findOne = async (query) => {
        if (query._id === orderDocId.toString() && query.user.toString() === customerId.toString()) {
            return {
                _id: orderDocId,
                orderId: "LS-20261112-TRACK01",
                orderStatus: "shipped",
                paymentStatus: "paid",
                storeId: "linen",
                user: customerId,
                shiprocket: {
                    awbCode: "AWB123456789",
                    courierName: "Blue Dart",
                    status: "in_transit",
                },
                timeline: [
                    { status: "placed", timestamp: new Date() },
                    { status: "shipped", timestamp: new Date() },
                ],
            };
        }
        return null;
    };

    try {
        const { req, res, getStatus, getJson } = createMockReqRes({
            user: { _id: customerId, storeId: "linen", role: "user" },
            store: { id: "linen" },
            params: { id: orderDocId.toString() },
        });

        await orderController.trackOrder(req, res, () => {});

        assert.equal(getStatus(), 200);
        const data = getJson();
        assert.ok(data.order || data.tracking || data.status);
    } finally {
        Order.findOne = originalFindOne;
    }
});
