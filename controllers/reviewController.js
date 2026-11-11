import mongoose from "mongoose";
import Review from "../models/reviewModal.js";
import Product from "../models/productModal.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { uploadImages, deleteMultipleFromR2 } from "../utils/r2Upload.js";

/**
 * Recalculate and update the Product's average rating from actual stored approved reviews
 */
export const updateProductRatingStats = async (productId) => {
    if (!productId) return null;
    const prodObjectId = mongoose.Types.ObjectId.isValid(productId)
        ? new mongoose.Types.ObjectId(productId)
        : null;
    if (!prodObjectId) return null;

    // Convert productId to ObjectId before $match in aggregation pipeline
    // Only aggregate approved reviews
    const stats = await Review.aggregate([
        {
            $match: {
                product: prodObjectId,
                $or: [
                    { status: "approved" },
                    { isApproved: true }
                ]
            }
        },
        {
            $group: {
                _id: "$product",
                avgRating: { $avg: "$rating" },
                numReviews: { $sum: 1 },
            },
        },
    ]);

    const averageRating = stats.length > 0 ? Math.round(stats[0].avgRating * 10) / 10 : 0;
    const numReviews = stats.length > 0 ? stats[0].numReviews : 0;

    const updatedProduct = await Product.findByIdAndUpdate(
        prodObjectId,
        { averageRating, numReviews },
        { returnDocument: 'after' }
    );

    return { averageRating, numReviews, product: updatedProduct };
};

/**
 * POST /api/review/product/:id — Create a new review (Public - login NOT required)
 * Body: { rating, title, comment, name, email }
 * Reviews start in "pending" status (isApproved: false) awaiting admin approval.
 */
const createReview = asyncHandler(async (req, res) => {
    if (!req.body) {
        throw new AppError("Request body is missing", 400);
    }
    
    const body = req.body || {};
    const { rating, title, comment } = body;
    const productId = req.params.id;

    if (!rating || !comment) {
        throw new AppError("Rating and comment are required", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw new AppError("Invalid product ID", 400);
    }

    const numRating = Number(rating);
    if (isNaN(numRating) || numRating < 1 || numRating > 5) {
        throw new AppError("Rating must be a number between 1 and 5", 400);
    }

    // 1. Ensure product exists
    const product = await Product.findById(productId);
    if (!product) throw new AppError("Product not found", 404);

    // 2. Prevent duplicate reviews by the same authenticated user if logged in
    if (req.user && req.user._id) {
        const existingReview = await Review.findOne({ user: req.user._id, product: productId });
        if (existingReview) {
            throw new AppError("You have already reviewed this product. You can delete or edit it from your profile.", 400);
        }
    }

    // Upload images if present
    let photoUrls = [];
    if (req.files && req.files.length > 0) {
        photoUrls = await uploadImages(req.files);
    }

    const reviewerName = body.name || body.userName || req.user?.name || "Anonymous";
    const reviewerEmail = body.email || body.userEmail || req.user?.email || "";

    // 3. Create review with pending status awaiting admin moderation
    const review = await Review.create({
        user: req.user ? req.user._id : null,
        userName: reviewerName,
        userEmail: reviewerEmail,
        product: productId,
        rating: numRating,
        title: title || "",
        comment,
        photos: photoUrls,
        isApproved: false,
        status: "pending",
    });

    res.status(201).json({
        success: true,
        message: "Review submitted successfully and is awaiting admin approval",
        review,
    });
});

/**
 * GET /api/review/product/:id — List all approved reviews for a product (Public)
 * Bounded pagination and sorting available
 */
const getProductReviews = asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw new AppError("Invalid product ID", 400);
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10)); // bounded between 1 and 50
    const skip = (page - 1) * limit;

    const query = {
        product: productId,
        $or: [
            { status: "approved" },
            { isApproved: true }
        ]
    };

    const [reviews, total] = await Promise.all([
        Review.find(query)
            .populate("user", "name")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Review.countDocuments(query)
    ]);

    const formattedReviews = reviews.map(r => ({
        ...r,
        user: r.user || { name: r.userName || "Anonymous" }
    }));

    res.status(200).json({
        success: true,
        reviews: formattedReviews,
        pagination: {
            page,
            limit,
            totalCount: total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
        },
    });
});

/**
 * GET /api/review/admin/all — List all reviews for moderation (Admin)
 * Query: status ('all' | 'pending' | 'approved' | 'rejected'), page, limit
 */
const getAllReviewsAdmin = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const statusFilter = req.query.status;

    const filter = {};
    if (statusFilter && ["pending", "approved", "rejected"].includes(statusFilter)) {
        filter.status = statusFilter;
    }

    const [reviews, totalFiltered, pendingCount, approvedCount, rejectedCount, totalAll] = await Promise.all([
        Review.find(filter)
            .populate("user", "name email")
            .populate("product", "name sku mainImage price slug")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Review.countDocuments(filter),
        Review.countDocuments({ status: "pending" }),
        Review.countDocuments({ $or: [{ status: "approved" }, { isApproved: true }] }),
        Review.countDocuments({ status: "rejected" }),
        Review.countDocuments(),
    ]);

    const formattedReviews = reviews.map(r => ({
        ...r,
        reviewerName: r.user?.name || r.userName || "Anonymous",
        reviewerEmail: r.user?.email || r.userEmail || "",
    }));

    res.status(200).json({
        success: true,
        reviews: formattedReviews,
        counts: {
            all: totalAll,
            pending: pendingCount,
            approved: approvedCount,
            rejected: rejectedCount,
        },
        pagination: {
            page,
            limit,
            totalCount: totalFiltered,
            totalPages: Math.max(1, Math.ceil(totalFiltered / limit)),
        },
    });
});

/**
 * PUT /api/review/admin/:id/status — Approve or disapprove a review (Admin)
 * Body: { status: 'approved' | 'rejected' } or { isApproved: boolean }
 */
const updateReviewStatusAdmin = asyncHandler(async (req, res) => {
    const reviewId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(reviewId)) {
        throw new AppError("Invalid review ID", 400);
    }

    const { status, isApproved } = req.body || {};
    let newStatus = status;
    if (!newStatus && typeof isApproved === "boolean") {
        newStatus = isApproved ? "approved" : "rejected";
    }

    if (!["approved", "rejected", "pending"].includes(newStatus)) {
        throw new AppError("Status must be 'approved', 'rejected', or 'pending'", 400);
    }

    const review = await Review.findById(reviewId);
    if (!review) {
        throw new AppError("Review not found", 404);
    }

    review.status = newStatus;
    review.isApproved = newStatus === "approved";
    await review.save();

    // Recalculate stats for the product
    try {
        await updateProductRatingStats(review.product);
    } catch (err) {
        console.error(`Failed to update product rating stats for product ${review.product}:`, err);
    }

    res.status(200).json({
        success: true,
        message: `Review ${newStatus === "approved" ? "approved" : "disapproved"} successfully`,
        review,
    });
});

/**
 * DELETE /api/review/:id — Delete a review (Admin, or the User who owns it)
 */
const deleteReview = asyncHandler(async (req, res) => {
    const reviewId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(reviewId)) {
        throw new AppError("Invalid review ID", 400);
    }

    const review = await Review.findById(reviewId);
    if (!review) throw new AppError("Review not found", 404);

    // Only allow admin or the user who created it to delete
    const isOwner = req.user && review.user && review.user.toString() === req.user._id.toString();
    const isAdmin = (req.user && req.user.role === 'admin') || !!req.admin;
    if (!isOwner && !isAdmin) {
        throw new AppError("You are not authorized to delete this review", 403);
    }

    // Clean up photos from R2
    if (review.photos && review.photos.length > 0) {
        deleteMultipleFromR2(review.photos).catch(() => {});
    }

    const productId = review.product;
    await review.deleteOne();

    // Recalculate stats immediately
    try {
        await updateProductRatingStats(productId);
    } catch (err) {
        console.error(`Failed to update product rating stats for product ${productId}:`, err);
    }

    res.status(200).json({ success: true, message: "Review deleted successfully" });
});

/**
 * POST /api/review/product/:id/recalculate — Recover/recalculate stats for a product
 */
const recalculateProductStats = asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw new AppError("Invalid product ID", 400);
    }

    const result = await updateProductRatingStats(productId);
    if (!result) {
        throw new AppError("Product not found or invalid", 404);
    }

    res.status(200).json({
        success: true,
        message: "Product review stats recalculated successfully",
        stats: {
            averageRating: result.averageRating,
            numReviews: result.numReviews,
        },
    });
});

export default {
    createReview,
    getProductReviews,
    getAllReviewsAdmin,
    updateReviewStatusAdmin,
    deleteReview,
    recalculateProductStats,
    updateProductRatingStats,
};
