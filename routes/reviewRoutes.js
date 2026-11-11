import express from "express";
import reviewController from "../controllers/reviewController.js";
import { protect, optionalProtect } from "../middlewares/authMiddleware.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";
import upLoadImage from "../middlewares/uploadImage.js";
import validate from "../middlewares/validate.js";
import { createReviewSchema } from "../validations/schemas.js";

const router = express.Router();
const {
    createReview,
    getProductReviews,
    getAllReviewsAdmin,
    updateReviewStatusAdmin,
    deleteReview,
    recalculateProductStats,
} = reviewController;

// Public routes
router.get("/product/:id", getProductReviews);

// Submission route: Open to anyone (guest or authenticated)
router.post(
    "/product/:id",
    optionalProtect,
    upLoadImage.array("photos", 5),
    validate(createReviewSchema),
    createReview
);

// Admin moderation routes
router.get("/admin/all", adminProtect, getAllReviewsAdmin);
router.put("/admin/:id/status", adminProtect, updateReviewStatusAdmin);

// Delete review (Admin or owner)
router.delete("/:id", optionalProtect, deleteReview);

// Recalculate stats route
router.post("/product/:id/recalculate", protect, recalculateProductStats);

export default router;
