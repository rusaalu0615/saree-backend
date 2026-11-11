import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Review from "../models/reviewModal.js";
import Product from "../models/productModal.js";
import User from "../models/userModal.js";
import reviewController from "../controllers/reviewController.js";

const MONGO_URI = process.env.TEST_MONGO_URI || (
    process.env.MONGO_URI ? process.env.MONGO_URI.replace(/\/([^\/?]+)(\?|$)/, '/$1_test$2') : null
);

const createMockRes = () => {
    const res = {
        statusCode: 200,
        headers: {},
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
};

describe("Review Moderation & Guest Submission Flow", () => {
    let adminUser;
    let sampleProduct;
    let submittedReviewId = null;

    before(async () => {
        if (!MONGO_URI) throw new Error("MONGO_URI not configured");
        await mongoose.connect(MONGO_URI);

        const suffix = Date.now();
        adminUser = await User.create({
            name: "Admin Moderator",
            email: `mod_admin_${suffix}@example.com`,
            phone: `98${Math.floor(10000000 + Math.random() * 90000000)}`,
            password: "Password123!",
            role: "admin",
        });

        sampleProduct = await Product.create({
            name: "Silk Banarasi Saree",
            sku: `SKU-REV-TEST-${suffix}`,
            category: "Silk",
            color: "Royal Blue",
            material: "Pure Silk",
            price: 4999,
            regularPrice: 5999,
            stock: 15,
            mainImage: "https://example.com/saree.jpg",
            shortDescription: "Authentic silk saree",
            tags: "silk,festive",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean",
            averageRating: 0,
            numReviews: 0,
        });
    });

    after(async () => {
        if (sampleProduct) {
            await Product.findByIdAndDelete(sampleProduct._id).catch(() => {});
            await Review.deleteMany({ product: sampleProduct._id }).catch(() => {});
        }
        if (adminUser) {
            await User.findByIdAndDelete(adminUser._id).catch(() => {});
        }
        await mongoose.disconnect();
    });

    test("1. Unauthenticated guest can submit a review with name, comment, and rating without login", async () => {
        const req = {
            params: { id: sampleProduct._id.toString() },
            body: {
                rating: 5,
                title: "Exquisite craftsmanship!",
                comment: "The zari work is stunning in person. Exceeded my expectations.",
                name: "Pooja Sharma",
                email: "pooja@example.com",
            },
            files: [],
            user: null, // Guest user with no auth
        };
        const res = createMockRes();

        await reviewController.createReview(req, res);

        assert.equal(res.statusCode, 201);
        assert.equal(res.data.success, true);
        assert.ok(res.data.review);
        assert.equal(res.data.review.status, "pending");
        assert.equal(res.data.review.isApproved, false);
        assert.equal(res.data.review.userName, "Pooja Sharma");
        assert.equal(res.data.review.rating, 5);

        submittedReviewId = res.data.review._id.toString();
    });

    test("2. Pending review is NOT visible in public getProductReviews and does not increment product rating", async () => {
        const req = {
            params: { id: sampleProduct._id.toString() },
            query: { page: "1", limit: "10" },
        };
        const res = createMockRes();

        await reviewController.getProductReviews(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.data.reviews.length, 0, "Pending review must not appear in public reviews");
        assert.equal(res.data.pagination.totalCount, 0);

        const prod = await Product.findById(sampleProduct._id);
        assert.equal(prod.numReviews, 0);
        assert.equal(prod.averageRating, 0);
    });

    test("3. Admin can list all reviews including pending from getAllReviewsAdmin", async () => {
        const req = {
            query: { status: "pending", page: "1", limit: "20" },
            user: adminUser,
        };
        const res = createMockRes();

        await reviewController.getAllReviewsAdmin(req, res);

        assert.equal(res.statusCode, 200);
        assert.ok(res.data.reviews.length >= 1);
        const found = res.data.reviews.find(r => r._id.toString() === submittedReviewId);
        assert.ok(found, "Pending review must appear in admin reviews list");
        assert.equal(found.reviewerName, "Pooja Sharma");
        assert.equal(found.status, "pending");
        assert.equal(res.data.counts.pending >= 1, true);
    });

    test("4. Admin approves review -> review becomes approved and product stats update", async () => {
        const req = {
            params: { id: submittedReviewId },
            body: { status: "approved" },
            user: adminUser,
        };
        const res = createMockRes();

        await reviewController.updateReviewStatusAdmin(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.data.review.status, "approved");
        assert.equal(res.data.review.isApproved, true);

        // Now public getProductReviews must show the approved review
        const pubReq = {
            params: { id: sampleProduct._id.toString() },
            query: {},
        };
        const pubRes = createMockRes();
        await reviewController.getProductReviews(pubReq, pubRes);

        assert.equal(pubRes.statusCode, 200);
        assert.equal(pubRes.data.reviews.length, 1);
        assert.equal(pubRes.data.reviews[0].user.name, "Pooja Sharma");

        // Product stats must be updated
        const prod = await Product.findById(sampleProduct._id);
        assert.equal(prod.numReviews, 1);
        assert.equal(prod.averageRating, 5);
    });

    test("5. Admin disapproves review -> review disappears from public list and rating resets", async () => {
        const req = {
            params: { id: submittedReviewId },
            body: { status: "rejected" },
            user: adminUser,
        };
        const res = createMockRes();

        await reviewController.updateReviewStatusAdmin(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.data.review.status, "rejected");
        assert.equal(res.data.review.isApproved, false);

        // Verify public list is now empty again
        const pubReq = {
            params: { id: sampleProduct._id.toString() },
            query: {},
        };
        const pubRes = createMockRes();
        await reviewController.getProductReviews(pubReq, pubRes);

        assert.equal(pubRes.statusCode, 200);
        assert.equal(pubRes.data.reviews.length, 0);

        const prod = await Product.findById(sampleProduct._id);
        assert.equal(prod.numReviews, 0);
        assert.equal(prod.averageRating, 0);
    });
});
