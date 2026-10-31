import "dotenv/config";
import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import crypto from "crypto";
import User from "../models/userModal.js";
import Product from "../models/productModal.js";
import OTP from "../models/otpModel.js";
import cartController from "../controllers/cartController.js";
import productController from "../controllers/productController.js";
import adminAuthController from "../controllers/adminAuthController.js";
import userController from "../controllers/userController.js";
import AppError from "../utils/AppError.js";

const MONGO_URI = process.env.TEST_MONGO_URI || (
    process.env.MONGO_URI ? process.env.MONGO_URI.replace(/\/([^\/?]+)(\?|$)/, '/$1_test$2') : null
);

describe("PHASE 2: Foundational Correctness and Authentication Fixes", () => {
    let testUser;
    let testProduct;

    before(async () => {
        if (!MONGO_URI) throw new Error("MONGO_URI not configured");
        await mongoose.connect(MONGO_URI);

        // Seed test user
        testUser = await User.create({
            name: "Phase2 Test User",
            email: `phase2_${Date.now()}@example.com`,
            phone: "9876543210",
            role: "user",
            cart: [],
        });

        // Seed test product
        testProduct = await Product.create({
            name: "Phase 2 Silk Saree",
            sku: `P2-SKU-${Date.now()}`,
            category: "Silk",
            regularPrice: 2999,
            price: 1999,
            stock: 15,
            shortDescription: "Elegant handloom silk saree",
            tags: "silk, saree, handloom",
            color: "Crimson",
            material: "Pure Silk",
            sareeSize: "5.5 meters",
            blouseSize: "0.8 meters",
            washCare: "Dry Clean Only",
            mainImage: "https://example.com/main.jpg",
        });
    });

    after(async () => {
        if (testUser?._id) await User.deleteOne({ _id: testUser._id });
        if (testProduct?._id) await Product.deleteOne({ _id: testProduct._id });
        await mongoose.disconnect();
    });

    // ==========================================
    // SECTION A: CART QUANTITY AND MERGE (F01, F02)
    // ==========================================
    describe("Section A: Cart Quantity and Atomic Merge", () => {
        test("Null or non-integer quantity is rejected with 400 validation error", async () => {
            const req = {
                user: testUser,
                body: { productId: testProduct._id.toString(), quantity: null },
            };
            let capturedError = null;
            await cartController.addToCart(req, { json: () => {} }, (err) => { capturedError = err; });

            assert.ok(capturedError instanceof AppError, "Must pass AppError to next()");
            assert.equal(capturedError.statusCode, 400);
            assert.match(capturedError.message, /Quantity must be a whole number/i);
        });

        test("Cart quantity 9 + 2 cannot exceed maximum (10) — capped atomically without overshoot", async () => {
            // Set cart line to quantity 9
            await User.updateOne(
                { _id: testUser._id },
                { $set: { cart: [{ productId: testProduct._id, quantity: 9 }] } }
            );

            let resJson = null;
            const res = {
                status: () => res,
                json: (data) => { resJson = data; },
            };

            // Add quantity 2
            await cartController.addToCart(
                { user: testUser, body: { productId: testProduct._id.toString(), quantity: 2 } },
                res,
                (err) => { if (err) throw err; }
            );

            assert.ok(resJson?.success);
            const userInDb = await User.findById(testUser._id);
            const line = userInDb.cart.find((c) => c.productId.toString() === testProduct._id.toString());
            assert.equal(line.quantity, 10, "Quantity must be capped at 10, never 11");
        });

        test("Server quantity 1 + guest quantity 3 merges correctly to 3", async () => {
            // Set server line to quantity 1
            await User.updateOne(
                { _id: testUser._id },
                { $set: { cart: [{ productId: testProduct._id, quantity: 1 }] } }
            );

            let resJson = null;
            const res = {
                status: () => res,
                json: (data) => { resJson = data; },
            };

            // Guest cart has quantity 3 for same product
            await cartController.syncCart(
                {
                    user: testUser,
                    body: { items: [{ productId: testProduct._id.toString(), quantity: 3 }] },
                },
                res,
                (err) => { if (err) throw err; }
            );

            assert.ok(resJson?.success);
            const userInDb = await User.findById(testUser._id);
            const line = userInDb.cart.find((c) => c.productId.toString() === testProduct._id.toString());
            assert.equal(line.quantity, 3, "Merged quantity must be 3 (higher guest quantity adopted)");
        });

        test("Deleted product is rejected on add with 404, and getCart cleans dead lines", async () => {
            const fakeId = new mongoose.Types.ObjectId().toString();

            // Attempt to add nonexistent product
            let capturedError = null;
            await cartController.addToCart(
                { user: testUser, body: { productId: fakeId, quantity: 1 } },
                { json: () => {} },
                (err) => { capturedError = err; }
            );

            assert.ok(capturedError instanceof AppError);
            assert.equal(capturedError.statusCode, 404);

            // Directly inject an orphaned dead line
            await User.updateOne(
                { _id: testUser._id },
                { $push: { cart: { productId: new mongoose.Types.ObjectId(fakeId), quantity: 1 } } }
            );

            let resJson = null;
            const res = {
                status: () => res,
                json: (data) => { resJson = data; },
            };

            await cartController.getCart({ user: testUser }, res, (err) => { if (err) throw err; });
            assert.ok(resJson?.success);
            const userAfter = await User.findById(testUser._id);
            const deadItem = userAfter.cart.find((c) => c.productId?.toString() === fakeId);
            assert.equal(deadItem, undefined, "Dead line must be cleaned up");
        });

        test("Null quantity in updateCartItem is rejected with 400 (does not silently remove)", async () => {
            let capturedError = null;
            await cartController.updateCartItem(
                { user: testUser, body: { productId: testProduct._id.toString(), quantity: null } },
                { json: () => {} },
                (err) => { capturedError = err; }
            );

            assert.ok(capturedError instanceof AppError);
            assert.equal(capturedError.statusCode, 400);
            assert.match(capturedError.message, /Quantity must be a valid whole number/i);
        });

        test("Zero quantity in updateCartItem removes item (preserves zero-means-remove contract)", async () => {
            await User.updateOne(
                { _id: testUser._id },
                { $set: { cart: [{ productId: testProduct._id, quantity: 3 }] } }
            );

            let resJson = null;
            const res = {
                status: () => res,
                json: (data) => { resJson = data; },
            };

            await cartController.updateCartItem(
                { user: testUser, body: { productId: testProduct._id.toString(), quantity: 0 } },
                res,
                (err) => { if (err) throw err; }
            );

            assert.ok(resJson?.success);
            const userInDb = await User.findById(testUser._id);
            const line = userInDb.cart.find((c) => c.productId.toString() === testProduct._id.toString());
            assert.equal(line, undefined, "Item must be removed on quantity 0");
        });
    });

    // ==========================================
    // SECTION B: PRODUCT PRICE AND STOCK WRITES (F03, F04)
    // ==========================================
    describe("Section B: Product Price and Stock Writes", () => {
        test("Negative price and fractional/negative stock updates are rejected with 400", async () => {
            let resStatus = null;
            let resJson = null;
            const res = {
                status: (code) => { resStatus = code; return res; },
                json: (data) => { resJson = data; },
            };

            // 1. Negative price in quickUpdate
            await productController.quickUpdateProduct(
                { params: { id: testProduct._id.toString() }, body: { price: -500 } },
                res
            );
            assert.equal(resStatus, 400);
            assert.match(resJson.message, /Price must be a finite, non-negative number/i);

            // 2. Fractional stock in quickUpdate
            await productController.quickUpdateProduct(
                { params: { id: testProduct._id.toString() }, body: { stock: 3.5 } },
                res
            );
            assert.equal(resStatus, 400);
            assert.match(resJson.message, /Stock must be a non-negative whole integer/i);

            // 3. Negative stock in quickUpdate
            await productController.quickUpdateProduct(
                { params: { id: testProduct._id.toString() }, body: { stock: -1 } },
                res
            );
            assert.equal(resStatus, 400);
            assert.match(resJson.message, /Stock must be a non-negative whole integer/i);
        });

        test("Stale admin stock update with mismatched expectedStock returns 409 Conflict", async () => {
            // Current stock of testProduct is 15
            await Product.updateOne({ _id: testProduct._id }, { $set: { stock: 15 } });

            let resStatus = null;
            let resJson = null;
            const res = {
                status: (code) => { resStatus = code; return res; },
                json: (data) => { resJson = data; },
            };

            // Admin opened page when stock was 20, but stock is now 15
            await productController.quickUpdateProduct(
                {
                    params: { id: testProduct._id.toString() },
                    body: { stock: 25, expectedStock: 20 },
                },
                res
            );

            assert.equal(resStatus, 409);
            assert.match(resJson.message, /Stock has changed concurrently/i);

            // Verify stock was NOT overwritten
            const prod = await Product.findById(testProduct._id);
            assert.equal(prod.stock, 15);
        });

        test("Fresh admin stock update with matching expectedStock succeeds", async () => {
            let resStatus = 200;
            let resJson = null;
            const res = {
                status: (code) => { resStatus = code; return res; },
                json: (data) => { resJson = data; },
            };

            await productController.quickUpdateProduct(
                {
                    params: { id: testProduct._id.toString() },
                    body: { stock: 20, expectedStock: 15 },
                },
                res
            );

            assert.equal(resStatus, 200);
            assert.equal(resJson.success, true);
            const prod = await Product.findById(testProduct._id);
            assert.equal(prod.stock, 20);
        });
    });

    // ==========================================
    // SECTION C: OTP EXPIRY AND CONSUMPTION (F09)
    // ==========================================
    describe("Section C: OTP Expiry and Consumption", () => {
        const testAdminEmail = "hemloeth@gmail.com";

        afterEach(async () => {
            await OTP.deleteMany({ email: testAdminEmail });
        });

        test("Expired-but-not-yet-deleted OTP is rejected by verification logic", async () => {
            const rawOtp = "123456";
            const hashedOtp = crypto.createHash("sha256").update(rawOtp).digest("hex");

            // Create an OTP that expired 10 seconds ago
            await OTP.create({
                email: testAdminEmail,
                otp: hashedOtp,
                purpose: "admin_login",
                attempts: 0,
                expiresAt: new Date(Date.now() - 10 * 1000), // EXPIRED
            });

            let resStatus = null;
            let resJson = null;
            const res = {
                status: (code) => { resStatus = code; return res; },
                json: (data) => { resJson = data; },
                cookie: () => {},
            };

            await adminAuthController.verifyAdminOTP(
                { body: { email: testAdminEmail, otp: rawOtp } },
                res,
                () => {}
            );

            assert.equal(resStatus, 400);
            assert.match(resJson.message, /expired/i);
        });

        test("Concurrent/brute-force failed attempts atomically increment and lock at limit (3)", async () => {
            const rawOtp = "654321";
            const hashedOtp = crypto.createHash("sha256").update(rawOtp).digest("hex");

            await OTP.create({
                email: testAdminEmail,
                otp: hashedOtp,
                purpose: "admin_login",
                attempts: 0,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            });

            let resStatus = null;
            let resJson = null;
            const res = {
                status: (code) => { resStatus = code; return res; },
                json: (data) => { resJson = data; },
                cookie: () => {},
            };

            // Attempt 1: wrong OTP
            await adminAuthController.verifyAdminOTP(
                { body: { email: testAdminEmail, otp: "000001" } },
                res,
                () => {}
            );
            assert.equal(resStatus, 400);
            assert.match(resJson.message, /2 attempts remaining/i);

            // Attempt 2: wrong OTP
            await adminAuthController.verifyAdminOTP(
                { body: { email: testAdminEmail, otp: "000002" } },
                res,
                () => {}
            );
            assert.equal(resStatus, 400);
            assert.match(resJson.message, /1 attempts remaining/i);

            // Attempt 3: wrong OTP -> Lock
            await adminAuthController.verifyAdminOTP(
                { body: { email: testAdminEmail, otp: "000003" } },
                res,
                () => {}
            );
            assert.equal(resStatus, 400);
            assert.match(resJson.message, /Too many failed attempts/i);

            // Record deleted after max attempts
            const remaining = await OTP.findOne({ email: testAdminEmail, purpose: "admin_login" });
            assert.equal(remaining, null);
        });

        test("Successful OTP consumption is single-use and deletes record atomically", async () => {
            const rawOtp = "789012";
            const hashedOtp = crypto.createHash("sha256").update(rawOtp).digest("hex");

            await OTP.create({
                email: testAdminEmail,
                otp: hashedOtp,
                purpose: "admin_login",
                attempts: 0,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            });

            let resStatus = 200;
            let resJson = null;
            const res = {
                status: (code) => { resStatus = code; return res; },
                json: (data) => { resJson = data; },
                cookie: () => {},
            };

            // First verification succeeds
            await adminAuthController.verifyAdminOTP(
                { body: { email: testAdminEmail, otp: rawOtp } },
                res,
                () => {}
            );
            assert.equal(resStatus, 200);
            assert.ok(resJson.token);

            // Second immediate verification fails (single-use)
            let secondStatus = null;
            let secondJson = null;
            const res2 = {
                status: (code) => { secondStatus = code; return res2; },
                json: (data) => { secondJson = data; },
                cookie: () => {},
            };

            await adminAuthController.verifyAdminOTP(
                { body: { email: testAdminEmail, otp: rawOtp } },
                res2,
                () => {}
            );
            assert.equal(secondStatus, 400);
            assert.match(secondJson.message, /expired or maximum attempts/i);
        });

        test("Customer password reset OTP preserves verification and atomically consumes on reset", async () => {
            const customerEmail = `customer_reset_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
            const rawOtp = "998877";
            const hashedOtp = crypto.createHash("sha256").update(rawOtp).digest("hex");

            // Seed user
            await User.create({
                name: "Customer Reset",
                email: customerEmail,
                phone: "9123456780",
                password: "OldPassword123!",
                role: "user",
            });

            await OTP.create({
                email: customerEmail,
                otp: hashedOtp,
                purpose: "password_reset",
                attempts: 0,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            });

            let verifyStatus = 200;
            let verifyJson = null;
            const verifyRes = {
                status: (code) => { verifyStatus = code; return verifyRes; },
                json: (data) => { verifyJson = data; },
            };

            // Step 1: verifyOtp validates and marks verified
            await userController.verifyOtp(
                { body: { email: customerEmail, otp: rawOtp } },
                verifyRes,
                () => {}
            );
            assert.equal(verifyStatus, 200);
            assert.match(verifyJson.message, /verified successfully/i);

            // Step 2: resetPassword consumes OTP and updates passwordChangedAt
            let resetStatus = 200;
            let resetJson = null;
            const resetRes = {
                status: (code) => { resetStatus = code; return resetRes; },
                json: (data) => { resetJson = data; },
            };

            await userController.resetPassword(
                { body: { email: customerEmail, otp: rawOtp, newPassword: "NewSecurePassword456!" } },
                resetRes,
                () => {}
            );

            assert.equal(resetStatus, 200);
            assert.match(resetJson.message, /Password reset successfully/i);

            // Verify OTP consumed
            const otpAfter = await OTP.findOne({ email: customerEmail });
            assert.equal(otpAfter, null, "Reset OTP must be deleted on successful reset");

            // Verify passwordChangedAt was set
            const userAfter = await User.findOne({ email: customerEmail });
            assert.ok(userAfter.passwordChangedAt instanceof Date);

            // Clean up
            await User.deleteOne({ email: customerEmail });
        });
    });
});
