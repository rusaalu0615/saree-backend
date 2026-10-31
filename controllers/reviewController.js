import mongoose from "mongoose";
import Review from "../models/reviewModal.js";
import Product from "../models/productModal.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { uploadImages, deleteMultipleFromR2 } from "../utils/r2Upload.js";

/**
 * Recalculate and update the Product's average rating from actual stored reviews
 */
export const updateProductRatingStats = async (productId) => {
    if (!productId) return null;
    const prodObjectId = mongoose.Types.ObjectId.isValid(productId)
        ? new mongoose.Types.ObjectId(productId)
        : null;
    if (!prodObjectId) return null;

    // Convert productId to ObjectId before $match in aggregation pipeline
    const stats = await Review.aggregate([
        { $match: { product: prodObjectId } },
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
        { new: true }
    );

    return { averageRating, numReviews, product: updatedProduct };
};

/**
 * POST /api/review/product/:id — Create a new review
 * Body: { rating, title, comment }
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

    // 2. Prevent duplicate reviews by the same user
    const existingReview = await Review.findOne({ user: req.user._id, product: productId });
    if (existingReview) {
        throw new AppError("You have already reviewed this product. You can delete or edit it from your profile.", 400);
    }

    // Upload images if present
    let photoUrls = [];
    if (req.files && req.files.length > 0) {
        photoUrls = await uploadImages(req.files);
    }

    // 3. Create review
    const review = await Review.create({
        user: req.user._id,
        product: productId,
        rating: numRating,
        title,
        comment,
        photos: photoUrls,
    });

    // 4. Update the Product's stats from authoritative stored reviews
    try {
        await updateProductRatingStats(productId);
    } catch (err) {
        console.error(`Failed to update product rating stats for product ${productId}:`, err);
    }

    res.status(201).json({
        success: true,
        message: "Review added successfully",
        review,
    });
});

/**
 * GET /api/review/product/:id — List all reviews for a product (Public)
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

    const [reviews, total] = await Promise.all([
        Review.find({ product: productId })
            .populate("user", "name")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Review.countDocuments({ product: productId })
    ]);

    res.status(200).json({
        success: true,
        reviews,
        pagination: {
            page,
            limit,
            totalCount: total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
        },
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
    const isOwner = req.user && review.user.toString() === req.user._id.toString();
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
    deleteReview,
    recalculateProductStats,
    updateProductRatingStats,
};
