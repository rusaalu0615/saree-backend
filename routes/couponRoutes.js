import express from "express";
import couponController from "../controllers/couponController.js";
import { protect } from "../middlewares/authMiddleware.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";

const router = express.Router();
const {
    createCoupon,
    getCoupons,
    updateCoupon,
    deleteCoupon,
    applyCoupon
} = couponController;

// Public/User Routes
router.post("/apply", protect, applyCoupon);

// Admin Routes (require whitelisted Admin JWT token)
router.route("/")
    .post(adminProtect, createCoupon)
    .get(adminProtect, getCoupons);

router.route("/:id")
    .put(adminProtect, updateCoupon)
    .delete(adminProtect, deleteCoupon);

export default router;
