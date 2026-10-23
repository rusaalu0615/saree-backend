import userController from "../controllers/userController.js";
import express from "express";
import { authLimiter } from "../middlewares/rateLimiter.js";
import { protect } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.post("/register", authLimiter, userController.registerUser);
router.post("/login", authLimiter, userController.loginUser);
router.post("/logout", userController.logoutUser);
router.put("/profile", protect, userController.updateProfile);
router.post("/forgot-password", authLimiter, userController.forgotPassword);
router.post("/verify-otp", authLimiter, userController.verifyOtp);
router.post("/reset-password", authLimiter, userController.resetPassword);

export default router;