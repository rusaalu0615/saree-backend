import crypto from "crypto";
import OTP from "../models/otpModel.js";
import User from "../models/userModal.js";
import generateToken from "../utils/generateToken.js";
import { sendAdminOTPEmail } from "../services/emailService.js";
import asyncHandler from "../utils/asyncHandler.js";
import { safeCompare } from "../utils/security.js";

// Helper to get whitelisted emails from environment
const getWhitelistedEmails = () => {
    return (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
};

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 3;

/**
 * POST /api/admin-auth/send-otp
 * Generates and sends an OTP if the email is on the admin whitelist
 */
export const sendAdminOTP = asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: "Email is required." });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    const whitelist = getWhitelistedEmails();
    const isWhitelisted = whitelist.includes(sanitizedEmail);

    if (!isWhitelisted) {
        console.log(`[Admin Auth] Access request for non-whitelisted email: ${sanitizedEmail}`);
        return res.status(403).json({
            success: false,
            message: "This email is not authorized for admin access. Please use an approved admin email.",
        });
    }

    // Rate Limiting Check: Check if an OTP was created for this email in the last 60 seconds
    const recentOtp = await OTP.findOne({
        email: sanitizedEmail,
        purpose: "admin_login",
        createdAt: { $gte: new Date(Date.now() - 60 * 1000) },
    });

    if (recentOtp) {
        return res.status(429).json({
            message: "Please wait 60 seconds before requesting a new code.",
        });
    }

    // Generate cryptographically secure 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();

    // Hash OTP before storing
    const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

    // Remove any previous OTPs for this email and purpose
    await OTP.deleteMany({ email: sanitizedEmail, purpose: "admin_login" });

    // Save the new purpose-bound OTP with explicit expiry date
    await OTP.create({
        email: sanitizedEmail,
        otp: hashedOtp,
        purpose: "admin_login",
        attempts: 0,
        expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
    });

    // Send the verification email (never logging the plaintext OTP)
    await sendAdminOTPEmail(sanitizedEmail, otp);

    return res.status(200).json({
        success: true,
        message: "If the email is authorized, an OTP has been sent.",
    });
});

/**
 * POST /api/admin-auth/verify-otp
 * Verifies OTP and signs a secure JWT token for valid admins
 */
export const verifyAdminOTP = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ message: "Email and verification code are required." });
    }

    if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
        return res.status(400).json({ message: "Verification code must be a 6-digit code." });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    const whitelist = getWhitelistedEmails();
    const isWhitelisted = whitelist.includes(sanitizedEmail);

    if (!isWhitelisted) {
        return res.status(403).json({ message: "Unauthorized email." });
    }

    const now = new Date();

    // 1. Atomically check unexpired record and increment attempt count
    const otpRecord = await OTP.findOneAndUpdate(
        {
            email: sanitizedEmail,
            purpose: "admin_login",
            expiresAt: { $gt: now },
            attempts: { $lt: MAX_ATTEMPTS },
        },
        { $inc: { attempts: 1 } },
        { returnDocument: "after" }
    );

    if (!otpRecord) {
        // Either expired, attempts exhausted, or no record exists
        await OTP.deleteMany({ email: sanitizedEmail, purpose: "admin_login" });
        return res.status(400).json({
            message: "Verification code has expired or maximum attempts reached. Please request a new code.",
        });
    }

    // 2. Compare hashed OTP using timing-safe comparison
    const hashedInput = crypto.createHash("sha256").update(otp).digest("hex");
    if (!safeCompare(otpRecord.otp, hashedInput)) {
        const remaining = Math.max(0, MAX_ATTEMPTS - otpRecord.attempts);
        if (remaining === 0) {
            await OTP.deleteMany({ email: sanitizedEmail, purpose: "admin_login" });
            return res.status(400).json({
                message: "Too many failed attempts. Please request a new verification code.",
            });
        }
        return res.status(400).json({
            message: `Invalid verification code. ${remaining} attempts remaining.`,
        });
    }

    // 3. Atomically consume OTP single-use to prevent concurrent double-verification
    const consumed = await OTP.findOneAndDelete({
        _id: otpRecord._id,
        purpose: "admin_login",
        otp: hashedInput,
    });

    if (!consumed) {
        return res.status(400).json({
            message: "Verification code has already been used.",
        });
    }

    // Retrieve or auto-create the whitelisted admin account
    let user = await User.findOne({ email: sanitizedEmail });

    if (!user) {
        user = await User.create({
            name: sanitizedEmail.split("@")[0],
            email: sanitizedEmail,
            phone: "N/A",
            role: "admin",
        });
        console.log(`[Admin Auth] Auto-created new whitelisted admin account: ${sanitizedEmail}`);
    } else if (user.role !== "admin") {
        user.role = "admin";
        await user.save();
        console.log(`[Admin Auth] Upgraded existing user to admin: ${sanitizedEmail}`);
    }

    // Sign session
    const token = generateToken(user._id);

    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.status(200).json({
        success: true,
        message: "Authentication successful.",
        token,
        user: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
        },
    });
});

export default {
    sendAdminOTP,
    verifyAdminOTP,
};
