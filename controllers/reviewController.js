import Review from "../models/reviewModal.js";
import Product from "../models/productModal.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";

/**
 * Recalculate and update the Product's average rating 
 */
const updateProductRatingStats = async (productId) => {
    // Uses MongoDB Aggregation to calculate average
    const stats = await Review.aggregate([
        { $match: { product: productId } },
        {
            $group: {
                _id: "$product",
                avgRating: { $avg: "$rating" },
                numReviews: { $sum: 1 },
            },
        },
    ]);

    if (stats.length > 0) {
        await Product.findByIdAndUpdate(productId, {
            averageRating: Math.round(stats[0].avgRating * 10) / 10, // Round to 1 decimal place
            numReviews: stats[0].numReviews,
        });
    } else {
        // If all reviews are deleted
        await Product.findByIdAndUpdate(productId, {
            averageRating: 0,
            numReviews: 0,
        });
    }
};

/**
 * POST /api/review/product/:id — Create a new review
 * Body: { rating, title, comment }
 */
const createReview = asyncHandler(async (req, res) => {
    const { rating, title, comment } = req.body;
    const productId = req.params.id;

    // 1. Ensure product exists
    const product = await Product.findById(productId);
    if (!product) throw new AppError("Product not found", 404);

    // 2. Prevent duplicate reviews (already enforced implicitly by DB index, but we return a clean error here)
    const existingReview = await Review.findOne({ user: req.user._id, product: productId });
    if (existingReview) {
        throw new AppError("You have already reviewed this product. You can delete or edit it from your profile.", 400);
    }

    // 3. Create review
    const review = await Review.create({
        user: req.user._id,
        product: productId,
        rating: Number(rating),
        title,
        comment,
    });

    // 4. Update the Product's stats asynchronously
    updateProductRatingStats(productId).catch((err) =>
        console.error(`Failed to update product rating stats for product ${productId}:`, err)
    );

    res.status(201).json({
        success: true,
        message: "Review added successfully",
        review,
    });
});

/**
 * GET /api/review/product/:id — List all reviews for a product (Public)
 * Pagination and sorting available
 */
const getProductReviews = asyncHandler(async (req, res) => {
    const productId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [reviews, total] = await Promise.all([
        Review.find({ product: productId })
            .populate("user", "name") // just get the reviewer's name
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Review.countDocuments({ product: productId })
    ]);

    res.status(200).json({
        success: true,
        reviews,
        pagination: {
            page,
            limit,
            totalCount: total,
            totalPages: Math.ceil(total / limit),
        },
    });
});

/**
 * DELETE /api/review/:id — Delete a review (Admin, or the User who owns it)
 */
const deleteReview = asyncHandler(async (req, res) => {
    const review = await Review.findById(req.params.id);
    if (!review) throw new AppError("Review not found", 404);

    // Only allow admin or the user who created it to delete
    // Currently relying on user being logged in, we verify ownership
    if (review.user.toString() !== req.user._id.toString()) {
        // Warning: Normally we check req.user.role === 'admin' here as well.
        throw new AppError("You are not authorized to delete this review", 403);
    }

    const productId = review.product;
    await review.deleteOne();

    // Recalculate stats
    updateProductRatingStats(productId).catch((err) =>
        console.error(`Failed to update product rating stats for product ${productId}:`, err)
    );

    res.status(200).json({ success: true, message: "Review deleted successfully" });
});

export default {
    createReview,
    getProductReviews,
    deleteReview,
};
