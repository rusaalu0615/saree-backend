import express from "express";
import { sendAdminOTP, verifyAdminOTP } from "../controllers/adminAuthController.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";
import { authLimiter } from "../middlewares/rateLimiter.js";
import validate from "../middlewares/validate.js";
import { adminSendOtpSchema, adminVerifyOtpSchema } from "../validations/schemas.js";

const router = express.Router();

// Public routes for OTP authorization
router.post("/send-otp", authLimiter, validate(adminSendOtpSchema), sendAdminOTP);
router.post("/verify-otp", authLimiter, validate(adminVerifyOtpSchema), verifyAdminOTP);

// Protected token validation route (called by frontend Layout on mount)
router.get("/verify-token", adminProtect, (req, res) => {
    res.status(200).json({
        success: true,
        user: {
            _id: req.user._id,
            name: req.user.name,
            email: req.user.email,
            role: req.user.role
        }
    });
});

export default router;
