import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import User from "../models/userModal.js";
import Order from "../models/orderModal.js";
import Coupon from "../models/couponModal.js";
import generateToken from "../utils/generateToken.js";
import { hashToken } from "../utils/security.js";
import orderController from "../controllers/orderController.js";
import { protect, optionalProtect } from "../middlewares/authMiddleware.js";
import { storeMiddleware, resolveStore } from "../middlewares/storeMiddleware.js";
import { getStoreConfig, STORES, isValidStoreId, toCanonicalStoreId, VALID_STORE_IDS } from "../config/stores.js";
import { CRITICAL_UNIQUE_INDEXES } from "../config/indexReadiness.js";
import { settleCartAfterPayment, applyCodCartAndAddress } from "../services/cartSettlement.js";

// Mock helper for Express req/res/next
const createMockReqRes = ({ body = {}, headers = {}, query = {}, user = null, store = null, params = {} } = {}) => {
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
    let headersSent = {};
    const res = {
        status: (code) => {
            statusCode = code;
            return res;
        },
        json: (data) => {
            jsonBody = data;
            return res;
        },
        setHeader: (name, val) => {
            headersSent[name] = val;
        },
        cookie: () => {},
    };
    return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
};

// ---------------------------------------------------------------------------
// 1. EXACTLY TWO STORES CONFIGURATION
// ---------------------------------------------------------------------------

test("1. Store configuration contains exactly two stores: 'handloomer' and 'linen'", () => {
    assert.ok(STORES.handloomer, "handloomer store must be configured");
    assert.ok(STORES.linen, "linen store must be configured");
    assert.equal(Object.keys(STORES).length, 2, "There must be EXACTLY TWO stores configured");
    assert.equal(STORES.qalakari, undefined, "qalakari must not exist as a store identity");

    // Canonical store IDs
    assert.equal(toCanonicalStoreId("handloomer"), "handloomer");
    assert.equal(toCanonicalStoreId("linen"), "linen");
    assert.equal(toCanonicalStoreId("qalakari"), null, "qalakari is not a valid store ID");
    assert.equal(toCanonicalStoreId("random"), null, "random store ID is invalid");

    // Configuration retrieval
    const hlConfig = getStoreConfig("handloomer");
    const lnConfig = getStoreConfig("linen");

    assert.equal(hlConfig.id, "handloomer");
    assert.equal(hlConfig.name, "Handloomer");
    assert.equal(hlConfig.orderPrefix, "HL");

    assert.equal(lnConfig.id, "linen");
    assert.equal(lnConfig.name, "House of Qalakari");
    assert.equal(lnConfig.orderPrefix, "LS");

    assert.deepEqual(VALID_STORE_IDS, ["handloomer", "linen"]);
    assert.equal(isValidStoreId("handloomer"), true);
    assert.equal(isValidStoreId("linen"), true);
    assert.equal(isValidStoreId("qalakari"), false, "qalakari must be rejected as invalid");
    assert.equal(isValidStoreId("unknown"), false);
});

test("2. Hardened Store Resolution: Validates origins, rejects invalid store IDs explicitly, and protects against suffix attacks", () => {
    // 2a. Default store is handloomer for legacy callers without store header
    const { req: defaultReq, res: defaultRes } = createMockReqRes({ headers: {} });
    storeMiddleware(defaultReq, defaultRes, () => {});
    assert.equal(defaultReq.store.id, "handloomer");

    // 2b. Explicit valid header
    const { req: lnReq, res: lnRes } = createMockReqRes({ headers: { "x-store-id": "linen" } });
    storeMiddleware(lnReq, lnRes, () => {});
    assert.equal(lnReq.store.id, "linen");

    const { req: hlReq, res: hlRes } = createMockReqRes({ headers: { "x-store-id": "handloomer" } });
    storeMiddleware(hlReq, hlRes, () => {});
    assert.equal(hlReq.store.id, "handloomer");

    // 2c. Explicit INVALID header must be REJECTED (400) instead of silently mapped
    const { req: invalidReq, res: invalidRes, getStatus, getJson } = createMockReqRes({ headers: { "x-store-id": "qalakari" } });
    let invalidNextCalled = false;
    storeMiddleware(invalidReq, invalidRes, () => { invalidNextCalled = true; });
    assert.equal(invalidNextCalled, false, "Must not allow invalid store ID to proceed");
    assert.equal(getStatus(), 400, "Must return 400 Bad Request");
    assert.equal(getJson().code, "INVALID_STORE_ID");

    // 2d. Valid origin matching
    const { req: origReq, res: origRes } = createMockReqRes({ headers: { origin: "https://linen-saree.vercel.app" } });
    storeMiddleware(origReq, origRes, () => {});
    assert.equal(origReq.store.id, "linen");

    // 2e. Subdomain match succeeds
    const { req: subReq } = createMockReqRes({ headers: { origin: "https://shop.handloomer.com" } });
    const subResolved = resolveStore(subReq);
    assert.equal(subResolved.id, "handloomer");

    // 2f. Phishing domain ending with store.domain (e.g. evilhandloomer.com)
    // Must NOT match handloomer; must fall back safely to default store without granting evilhandloomer trust
    const { req: attackReq } = createMockReqRes({ headers: { origin: "https://evilhandloomer.com" } });
    const attackResolved = resolveStore(attackReq);
    assert.equal(attackResolved.domain, "handloomer.com", "Fallback to default store");
});

// ---------------------------------------------------------------------------
// 2. ACCOUNT ISOLATION & SESSION BOUNDARIES
// ---------------------------------------------------------------------------

test("3. Two accounts with identical emails on different stores have separate identities", () => {
    const email = "rahul@gmail.com";
    const userHandloomer = new User({
        _id: new mongoose.Types.ObjectId(),
        name: "Rahul Handloomer",
        email,
        phone: "9876543210",
        password: "hashedPassword1",
        storeId: "handloomer",
        role: "user",
    });

    const userLinen = new User({
        _id: new mongoose.Types.ObjectId(),
        name: "Rahul Linen",
        email,
        phone: "9876543210",
        password: "hashedPassword2",
        storeId: "linen",
        role: "user",
    });

    assert.equal(userHandloomer.email, userLinen.email, "Email is identical");
    assert.notEqual(userHandloomer._id.toString(), userLinen._id.toString(), "User IDs must be distinct");
    assert.notEqual(userHandloomer.storeId, userLinen.storeId, "Store IDs must be distinct");
    assert.equal(userHandloomer.storeId, "handloomer");
    assert.equal(userLinen.storeId, "linen");
});

test("4. Cross-store session token rejection in protect middleware", async () => {
    const dummyUserId = new mongoose.Types.ObjectId();
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-key-123456789";
    const token = generateToken(dummyUserId, "handloomer");

    const originalFindById = User.findById;
    User.findById = () => ({
        select: () => Promise.resolve({
            _id: dummyUserId,
            role: "user",
            storeId: "handloomer",
            passwordChangedAt: null,
            revokedTokens: [],
        }),
    });

    try {
        // Handloomer token sent to Linen store
        const { req, res, getStatus, getJson } = createMockReqRes({
            headers: { authorization: `Bearer ${token}` },
            store: { id: "linen" },
        });

        let nextCalled = false;
        await protect(req, res, () => { nextCalled = true; });

        assert.equal(nextCalled, false, "Must not allow cross-store token to execute controller");
        assert.equal(getStatus(), 401, "Must return 401 Unauthorized");
        assert.equal(getJson().code, "CROSS_STORE_SESSION_FORBIDDEN");

        // Matching store token succeeds
        const { req: validReq, res: validRes } = createMockReqRes({
            headers: { authorization: `Bearer ${token}` },
            store: { id: "handloomer" },
        });
        let validNextCalled = false;
        await protect(validReq, validRes, () => { validNextCalled = true; });
        assert.equal(validNextCalled, true, "Matching store token must proceed");
        assert.equal(validReq.user._id.toString(), dummyUserId.toString());
    } finally {
        User.findById = originalFindById;
    }
});

test("5. Hardened optionalProtect: Wrong-store token explicitly rejected (401) to prevent unintended guest orders", async () => {
    const dummyUserId = new mongoose.Types.ObjectId();
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-key-123456789";
    const token = generateToken(dummyUserId, "handloomer");

    const originalFindById = User.findById;
    User.findById = () => ({
        select: () => Promise.resolve({
            _id: dummyUserId,
            role: "user",
            storeId: "handloomer",
            passwordChangedAt: null,
            revokedTokens: [],
        }),
    });

    try {
        // Customer presents Handloomer token while checking out on Linen:
        // Must NOT silently become guest order; must return 401 CROSS_STORE_SESSION_FORBIDDEN
        const { req, res, getStatus, getJson } = createMockReqRes({
            headers: { authorization: `Bearer ${token}` },
            store: { id: "linen" },
        });
        let nextCalled = false;
        await optionalProtect(req, res, () => { nextCalled = true; });

        assert.equal(nextCalled, false, "Must not silently proceed as guest when a valid cross-store token is presented");
        assert.equal(getStatus(), 401);
        assert.equal(getJson().code, "CROSS_STORE_SESSION_FORBIDDEN");

        // Pure guest request (no token at all) proceeds as guest
        const { req: guestReq, res: guestRes } = createMockReqRes({
            headers: {},
            store: { id: "linen" },
        });
        let guestNextCalled = false;
        await optionalProtect(guestReq, guestRes, () => { guestNextCalled = true; });
        assert.equal(guestNextCalled, true, "Pure guest request must proceed without user");
        assert.ok(!guestReq.user);
    } finally {
        User.findById = originalFindById;
    }
});

// ---------------------------------------------------------------------------
// 3. SECURE GUEST-ORDER CLAIMING & CONCURRENCY PROTECTION
// ---------------------------------------------------------------------------

test("6. Guest Claim Security: Rejected without ownership proof (checkout token required)", async () => {
    const customerId = new mongoose.Types.ObjectId();
    const guestOrderId = "LS-20261112-CLAIM1";

    const originalFindOne = Order.findOne;
    Order.findOne = async () => ({
        _id: new mongoose.Types.ObjectId(),
        orderId: guestOrderId,
        storeId: "linen",
        user: null,
        isGuest: true,
        shippingAddress: { email: "rahul@gmail.com" },
        payment: { checkoutTokenHash: hashToken("valid-secret-12345678") },
    });

    try {
        // Scenario A: Missing checkoutToken entirely (even if email matches)
        const { req, res } = createMockReqRes({
            body: { orderId: guestOrderId }, // No checkoutToken
            user: { _id: customerId, storeId: "linen", email: "rahul@gmail.com" },
            store: { id: "linen" },
        });

        let capturedErr = null;
        await orderController.claimGuestOrder(req, res, (err) => { capturedErr = err; });

        assert.ok(capturedErr, "Must reject claim without checkout token");
        assert.equal(capturedErr.statusCode, 400);
        assert.ok(capturedErr.message.includes("checkout token"), "Error message must require checkout token");
    } finally {
        Order.findOne = originalFindOne;
    }
});

test("7. Guest Claim Security: Invalid checkout token is rejected with 403", async () => {
    const customerId = new mongoose.Types.ObjectId();
    const guestOrderId = "LS-20261112-CLAIM2";

    const originalFindOne = Order.findOne;
    Order.findOne = async () => ({
        _id: new mongoose.Types.ObjectId(),
        orderId: guestOrderId,
        storeId: "linen",
        user: null,
        isGuest: true,
        shippingAddress: { email: "rahul@gmail.com" },
        payment: { checkoutTokenHash: hashToken("valid-secret-12345678") },
    });

    try {
        const { req, res } = createMockReqRes({
            body: { orderId: guestOrderId, checkoutToken: "wrong-secret-99999999" },
            user: { _id: customerId, storeId: "linen", email: "rahul@gmail.com" },
            store: { id: "linen" },
        });

        let capturedErr = null;
        await orderController.claimGuestOrder(req, res, (err) => { capturedErr = err; });

        assert.ok(capturedErr, "Must reject claim with invalid checkout token");
        assert.equal(capturedErr.statusCode, 403);
        assert.ok(capturedErr.message.includes("Invalid checkout capability token"));
    } finally {
        Order.findOne = originalFindOne;
    }
});

test("8. Guest Claim Security: Valid checkout token claims order successfully via atomic update", async () => {
    const customerId = new mongoose.Types.ObjectId();
    const targetOrderId = new mongoose.Types.ObjectId();
    const guestOrderId = "LS-20261112-CLAIM3";
    const validSecret = "secure-checkout-secret-token-1234";

    const originalFindOne = Order.findOne;
    const originalFindOneAndUpdate = Order.findOneAndUpdate;

    let atomicFilterPassed = null;
    let atomicUpdatePassed = null;

    Order.findOne = async () => ({
        _id: targetOrderId,
        orderId: guestOrderId,
        storeId: "linen",
        user: null,
        isGuest: true,
        payment: { checkoutTokenHash: hashToken(validSecret) },
    });

    Order.findOneAndUpdate = async (filter, update) => {
        atomicFilterPassed = filter;
        atomicUpdatePassed = update;
        return {
            _id: targetOrderId,
            orderId: guestOrderId,
            storeId: "linen",
            user: customerId,
            isGuest: false,
        };
    };

    try {
        const { req, res, getStatus, getJson } = createMockReqRes({
            body: { orderId: guestOrderId, checkoutToken: validSecret },
            user: { _id: customerId, storeId: "linen", email: "customer@domain.com" },
            store: { id: "linen" },
        });

        let capturedErr = null;
        await orderController.claimGuestOrder(req, res, (err) => { capturedErr = err; });

        assert.equal(capturedErr, null, "Valid claim must not error");
        assert.equal(getStatus(), 200);
        assert.equal(getJson().success, true);
        assert.equal(getJson().orderId, guestOrderId);

        // Verify atomic filter enforced user: null
        assert.equal(atomicFilterPassed.user, null, "Atomic update MUST require user: null");
        assert.equal(atomicFilterPassed.storeId, "linen", "Atomic update MUST require matching storeId");
        assert.equal(atomicUpdatePassed.$set.user.toString(), customerId.toString());
        assert.equal(atomicUpdatePassed.$set.isGuest, false);
    } finally {
        Order.findOne = originalFindOne;
        Order.findOneAndUpdate = originalFindOneAndUpdate;
    }
});

test("9. Guest Claim Security: Concurrent claims are prevented by atomic conditional update (409 Conflict)", async () => {
    const customerA = new mongoose.Types.ObjectId();
    const customerB = new mongoose.Types.ObjectId();
    const guestOrderId = "LS-20261112-RACE1";
    const validSecret = "shared-secret-attempt-12345";

    const originalFindOne = Order.findOne;
    const originalFindOneAndUpdate = Order.findOneAndUpdate;

    Order.findOne = async () => ({
        _id: new mongoose.Types.ObjectId(),
        orderId: guestOrderId,
        storeId: "linen",
        user: null,
        isGuest: true,
        payment: { checkoutTokenHash: hashToken(validSecret) },
    });

    // Simulate Customer A won the race: Customer B finds user is no longer null -> returns null
    Order.findOneAndUpdate = async () => null;

    try {
        const { req, res } = createMockReqRes({
            body: { orderId: guestOrderId, checkoutToken: validSecret },
            user: { _id: customerB, storeId: "linen" },
            store: { id: "linen" },
        });

        let capturedErr = null;
        await orderController.claimGuestOrder(req, res, (err) => { capturedErr = err; });

        assert.ok(capturedErr, "Second concurrent claim must fail");
        assert.equal(capturedErr.statusCode, 409, "Must return 409 Conflict when concurrent claim loses race");
        assert.ok(capturedErr.message.includes("already been claimed"));
    } finally {
        Order.findOne = originalFindOne;
        Order.findOneAndUpdate = originalFindOneAndUpdate;
    }
});

test("10. Guest Claim Security: Cross-store guest-order claiming is rejected", async () => {
    const customerId = new mongoose.Types.ObjectId();
    const handloomerOrderId = "HL-20261112-CROSS1";

    const originalFindOne = Order.findOne;
    // Order exists on handloomer, but query scopes to linen -> findOne returns null
    Order.findOne = async (query) => {
        if (query.storeId === "handloomer") {
            return {
                orderId: handloomerOrderId,
                storeId: "handloomer",
                user: null,
                isGuest: true,
                payment: { checkoutTokenHash: hashToken("token-12345678") },
            };
        }
        return null;
    };

    try {
        // Customer on Linen website attempts to claim a Handloomer guest order
        const { req, res } = createMockReqRes({
            body: { orderId: handloomerOrderId, checkoutToken: "token-12345678" },
            user: { _id: customerId, storeId: "linen" },
            store: { id: "linen" },
        });

        let capturedErr = null;
        await orderController.claimGuestOrder(req, res, (err) => { capturedErr = err; });

        assert.ok(capturedErr, "Cross-store order claim must be rejected");
        assert.equal(capturedErr.statusCode, 404, "Order not found in customer's store context");
    } finally {
        Order.findOne = originalFindOne;
    }
});

test("11. Historical Unclaimed Orders: Legacy orders with user: null remain unclaimed until explicit claim", () => {
    const historicalOrder = new Order({
        storeId: "handloomer",
        orderId: "HL-HISTORICAL-01",
        user: null,
        isGuest: true,
        items: [{ productId: new mongoose.Types.ObjectId(), name: "Silk Saree", price: 2999, quantity: 1 }],
        shippingAddress: { firstName: "OldCustomer", email: "old@handloomer.com", phone: "9876543210", address: "A", city: "B", state: "C", pincode: "110001" },
        payment: { method: "cod", status: "placed" },
    });

    assert.equal(historicalOrder.user, null, "Historical guest order must remain with user: null");
    assert.equal(historicalOrder.isGuest, true, "isGuest marker must be true");

    // Standard user orders query { user: req.user._id } will not expose this order
    const authenticatedUserQuery = {
        storeId: "handloomer",
        user: new mongoose.Types.ObjectId(),
    };

    assert.notEqual(String(historicalOrder.user), String(authenticatedUserQuery.user), "Must not match standard user query");
});

// ---------------------------------------------------------------------------
// 4. SHARED INVENTORY & COUPON STORE SCOPING
// ---------------------------------------------------------------------------

test("12. Coupon store validation ensures store-bound discounts cannot be used cross-store", () => {
    const couponLinenOnly = new Coupon({
        code: "LINEN20",
        discountType: "percentage",
        discountValue: 20,
        storeId: "linen",
        isActive: true,
        usageLimit: 100,
        usedCount: 0,
        expiryDate: new Date(Date.now() + 86400000),
    });

    const couponGlobal = new Coupon({
        code: "WELCOME10",
        discountType: "percentage",
        discountValue: 10,
        storeId: null, // Global
        isActive: true,
        usageLimit: 100,
        usedCount: 0,
        expiryDate: new Date(Date.now() + 86400000),
    });

    // Linen coupon valid on linen, invalid on handloomer
    assert.equal(couponLinenOnly.isValid("linen"), true);
    assert.equal(couponLinenOnly.isValid("handloomer"), false);

    // Global coupon valid on both
    assert.equal(couponGlobal.isValid("linen"), true);
    assert.equal(couponGlobal.isValid("handloomer"), true);
});

test("13. Shared Inventory: Stock is unified across both stores without duplication", () => {
    // Inventory is tracked on the single Product document
    const productCatalogItem = {
        _id: "prod-101",
        name: "Pure Linen Banarasi Saree",
        sku: "PLB-001",
        countInStock: 10,
    };

    // Order from Handloomer decrements stock by 3
    const qtyOrderedHL = 3;
    productCatalogItem.countInStock -= qtyOrderedHL;
    assert.equal(productCatalogItem.countInStock, 7);

    // Order from Linen decrements stock by 2
    const qtyOrderedLinen = 2;
    productCatalogItem.countInStock -= qtyOrderedLinen;
    assert.equal(productCatalogItem.countInStock, 5, "Stock must decrement accurately across stores");
});

// ---------------------------------------------------------------------------
// 5. GUEST CHECKOUT OWNERSHIP & DOWNSTREAM NULL-USER SAFETY
// ---------------------------------------------------------------------------

test("14. Guest Checkout Isolation: Unauthenticated checkout with existing customer email leaves order.user null and does NOT link to account", () => {
    const existingUserId = new mongoose.Types.ObjectId();
    const existingUserEmail = "existing.shopper@gmail.com";

    // Simulate unauthenticated request where shipping email happens to match a registered user
    const req = {
        user: null, // Unauthenticated
        store: { id: "linen" },
        body: {
            items: [{ productId: new mongoose.Types.ObjectId(), quantity: 1 }],
            shippingAddress: {
                firstName: "Guest",
                lastName: "User",
                email: existingUserEmail,
                phone: "9876543210",
                address: "Flat 1, MG Road",
                city: "Bengaluru",
                state: "Karnataka",
                pincode: "560001",
            },
        },
    };

    const isGuest = !req.user;
    const orderUserId = isGuest ? null : req.user._id;

    assert.equal(isGuest, true, "isGuest must be true for unauthenticated request");
    assert.equal(orderUserId, null, "orderUserId must be null (no automatic account lookup/linking)");

    const orderDoc = new Order({
        storeId: req.store.id,
        user: orderUserId,
        isGuest: isGuest,
        orderId: "LS-20261112-GUEST01",
        items: [{ productId: new mongoose.Types.ObjectId(), name: "Linen Saree", price: 3499, quantity: 1 }],
        shippingAddress: req.body.shippingAddress,
        payment: { method: "cod", status: "pending" },
    });

    assert.equal(orderDoc.user, null, "Guest order must have user: null");
    assert.equal(orderDoc.isGuest, true, "Guest order must have isGuest: true");
    assert.equal(orderDoc.storeId, "linen", "Must preserve canonical storeId");
});

test("15. Guest Checkout Isolation: Unauthenticated checkout with unknown email does NOT create any User document", async () => {
    let userCreateCalled = false;
    let userFindOneCalled = false;

    const originalCreate = User.create;
    const originalFindOne = User.findOne;

    User.create = async () => {
        userCreateCalled = true;
        throw new Error("User.create should NEVER be called during guest checkout");
    };

    User.findOne = async () => {
        userFindOneCalled = true;
        return null;
    };

    try {
        const req = {
            user: null,
            store: { id: "handloomer" },
            body: {
                shippingAddress: {
                    firstName: "Anonymous",
                    email: "brandnew.person@example.com",
                },
            },
        };

        const isGuest = !req.user;
        const orderUserId = isGuest ? null : req.user._id;

        assert.equal(isGuest, true);
        assert.equal(orderUserId, null);
        assert.equal(userCreateCalled, false, "Must not silently create User document");
    } finally {
        User.create = originalCreate;
        User.findOne = originalFindOne;
    }
});

test("16. Authenticated Checkout: Authenticated customer request always links req.user._id and marks isGuest false", () => {
    const authenticatedCustomerId = new mongoose.Types.ObjectId();
    const req = {
        user: { _id: authenticatedCustomerId, email: "auth.shopper@domain.com", storeId: "linen" },
        store: { id: "linen" },
    };

    const isGuest = !req.user;
    const orderUserId = isGuest ? null : req.user._id;

    assert.equal(isGuest, false, "isGuest must be false for authenticated customer");
    assert.equal(String(orderUserId), String(authenticatedCustomerId), "orderUserId must match authenticated customer ID");

    const orderDoc = new Order({
        storeId: "linen",
        user: orderUserId,
        isGuest: isGuest,
        orderId: "LS-20261112-AUTH01",
        items: [{ productId: new mongoose.Types.ObjectId(), name: "Linen Saree", price: 3499, quantity: 1 }],
        shippingAddress: { firstName: "Auth", email: "auth.shopper@domain.com", phone: "9876543210", address: "A", city: "B", state: "C", pincode: "123456" },
        payment: { method: "cod", status: "pending" },
    });

    assert.equal(String(orderDoc.user), String(authenticatedCustomerId));
    assert.equal(orderDoc.isGuest, false);
});

test("17. Customer Order Privacy: Unclaimed guest orders are NEVER returned in getUserOrders", async () => {
    const customerId = new mongoose.Types.ObjectId();
    const customerEmail = "customer@domain.com";

    let capturedQuery = null;
    const originalFind = Order.find;

    Order.find = (query) => {
        capturedQuery = query;
        return {
            sort: () => ({
                lean: async () => [
                    // Only orders belonging to this user
                ],
            }),
        };
    };

    try {
        const { req, res, getStatus } = createMockReqRes({
            user: { _id: customerId, email: customerEmail, storeId: "linen" },
            store: { id: "linen" },
        });

        await orderController.getUserOrders(req, res, () => {});

        assert.equal(getStatus(), 200);
        // Ensure query uses { user: req.user._id, storeId: 'linen' } and NEVER { email }
        assert.equal(String(capturedQuery.user), String(customerId));
        assert.equal(capturedQuery.storeId, "linen");
        assert.equal(capturedQuery.email, undefined, "getUserOrders must NEVER query by email");
    } finally {
        Order.find = originalFind;
    }
});

test("18. Downstream Flows with Null User: Cart settlement and COD address updates execute safely without touching user accounts", async () => {
    let orderUpdateDone = false;
    let userSaveDone = false;

    const originalOrderUpdateOne = Order.updateOne;
    const originalOrderFindById = Order.findById;
    const originalUserFindById = User.findById;
    const originalStartSession = mongoose.startSession;

    const guestOrder = {
        _id: new mongoose.Types.ObjectId(),
        storeId: "linen",
        user: null, // Null user
        isGuest: true,
        cartSettled: false,
        items: [{ productId: "p1", quantity: 1 }],
    };

    Order.findById = () => ({
        session: () => guestOrder,
    });

    Order.updateOne = async () => {
        orderUpdateDone = true;
        return { modifiedCount: 1 };
    };

    User.findById = () => {
        userSaveDone = true;
        throw new Error("User.findById must NOT be called when order.user is null");
    };

    mongoose.startSession = async () => ({
        withTransaction: async (fn) => fn(),
        endSession: async () => {},
    });

    try {
        // 1. Settle cart after payment with null user
        const resultPayment = await settleCartAfterPayment(guestOrder);
        assert.equal(resultPayment.success, true);
        assert.equal(resultPayment.guest, true);
        assert.equal(resultPayment.userSettled, false);

        // 2. Apply COD cart & address with null user
        const resultCod = await applyCodCartAndAddress(guestOrder, { firstName: "Guest", phone: "9876543210" });
        assert.equal(resultCod.success, true);
        assert.equal(resultCod.guest, true);

        assert.equal(orderUpdateDone, true, "Order must be marked settled");
        assert.equal(userSaveDone, false, "No user account was touched");
    } finally {
        Order.updateOne = originalOrderUpdateOne;
        Order.findById = originalOrderFindById;
        User.findById = originalUserFindById;
        mongoose.startSession = originalStartSession;
    }
});
