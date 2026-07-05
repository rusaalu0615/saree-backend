import userController from "../controllers/userController.js";
import express from "express";
import { authLimiter } from "../middlewares/rateLimiter.js";

const router = express.Router();

router.post("/register", authLimiter, userController.registerUser);
router.post("/login", authLimiter, userController.loginUser);
router.post("/logout", userController.logoutUser);
router.post("/forgot-password", authLimiter, userController.forgotPassword);
router.post("/verify-otp", authLimiter, userController.verifyOtp);
router.post("/reset-password", authLimiter, userController.resetPassword);

export default router;