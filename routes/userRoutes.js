import userController from "../controllers/userController.js";
import express from "express";
import { authLimiter } from "../middlewares/rateLimiter.js";
import { protect } from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validate.js";
import {
    registerSchema,
    loginSchema,
    forgotPasswordSchema,
    verifyOtpSchema,
    resetPasswordSchema,
    updateProfileSchema,
} from "../validations/schemas.js";

const router = express.Router();

router.post("/register", authLimiter, validate(registerSchema), userController.registerUser);
router.post("/login", authLimiter, validate(loginSchema), userController.loginUser);
router.post("/logout", userController.logoutUser);
router.put("/profile", protect, validate(updateProfileSchema), userController.updateProfile);
router.post("/forgot-password", authLimiter, validate(forgotPasswordSchema), userController.forgotPassword);
router.post("/verify-otp", authLimiter, validate(verifyOtpSchema), userController.verifyOtp);
router.post("/reset-password", authLimiter, validate(resetPasswordSchema), userController.resetPassword);

export default router;