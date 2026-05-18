import express from "express";
import couponController from "../controllers/couponController.js";
import { protect } from "../middlewares/authMiddleware.js";

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

// Admin Routes (using protect for now, should add admin middleware later)
router.route("/")
    .post(createCoupon)
    .get(getCoupons);

router.route("/:id")
    .put(updateCoupon)
    .delete(deleteCoupon);

export default router;
