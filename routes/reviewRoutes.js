import express from "express";
import reviewController from "../controllers/reviewController.js";
import { protect } from "../middlewares/authMiddleware.js";

const router = express.Router();
const { createReview, getProductReviews, deleteReview } = reviewController;

// Public routes
router.get("/product/:id", getProductReviews);

// Protected routes (requires login)
router.post("/product/:id", protect, createReview);
router.delete("/:id", protect, deleteReview);

export default router;
