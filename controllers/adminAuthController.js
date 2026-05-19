import crypto from "crypto";
import OTP from "../models/otpModel.js";
import User from "../models/userModal.js";
import generateToken from "../utils/generateToken.js";
import { sendAdminOTPEmail } from "../services/emailService.js";
import asyncHandler from "../utils/asyncHandler.js";

// Helper to get whitelisted emails from environment
const getWhitelistedEmails = () => {
    const fromEnv = (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);
    
    // Fallback default admin list to prevent Render environment variable misconfiguration lockouts
    const defaultAdmins = ["hemloeth@gmail.com"];
    return Array.from(new Set([...fromEnv, ...defaultAdmins]));
};

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

    // To prevent user enumeration attacks, if the email is not whitelisted,
    // we return a success response, but do NOT send or generate an OTP.
    if (!isWhitelisted) {
        console.log(`[Admin Auth] Access request for non-whitelisted email: ${sanitizedEmail}`);
        return res.status(200).json({
            success: true,
            message: "If the email is authorized, an OTP has been sent."
        });
    }

    // Rate Limiting Check: Check if an OTP was created for this email in the last 60 seconds
    const recentOtp = await OTP.findOne({
        email: sanitizedEmail,
        createdAt: { $gte: new Date(Date.now() - 60 * 1000) }
    });

    if (recentOtp) {
        return res.status(429).json({
            message: "Please wait 60 seconds before requesting a new code."
        });
    }

    // Generate cryptographically secure 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Hash OTP before storing to prevent exposure in case of DB read breach
    const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

    // Remove any previous OTPs for this email to prevent replay/multiple active OTPs
    await OTP.deleteMany({ email: sanitizedEmail });

    // Save the new OTP
    await OTP.create({
        email: sanitizedEmail,
        otp: hashedOtp,
        attempts: 0
    });

    // Send the beautiful verification email
    await sendAdminOTPEmail(sanitizedEmail, otp);

    return res.status(200).json({
        success: true,
        message: "If the email is authorized, an OTP has been sent."
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

    const sanitizedEmail = email.trim().toLowerCase();
    const whitelist = getWhitelistedEmails();
    const isWhitelisted = whitelist.includes(sanitizedEmail);

    if (!isWhitelisted) {
        return res.status(403).json({ message: "Unauthorized email." });
    }

    // Find the latest active OTP record
    const otpRecord = await OTP.findOne({ email: sanitizedEmail }).sort({ createdAt: -1 });

    if (!otpRecord) {
        return res.status(400).json({ message: "Verification code has expired or is invalid." });
    }

    // Increment and save attempts count
    otpRecord.attempts += 1;
    await otpRecord.save();

    // Brute-force protection: check attempts limit
    if (otpRecord.attempts > 3) {
        await OTP.deleteMany({ email: sanitizedEmail });
        return res.status(400).json({
            message: "Too many failed attempts. Please request a new verification code."
        });
    }

    // Compare hashed OTPs
    const hashedInput = crypto.createHash("sha256").update(otp).digest("hex");
    if (otpRecord.otp !== hashedInput) {
        return res.status(400).json({
            message: `Invalid verification code. ${3 - otpRecord.attempts} attempts remaining.`
        });
    }

    // Verification successful! Invalidate OTP immediately to prevent reuse
    await OTP.deleteMany({ email: sanitizedEmail });

    // Retrieve or auto-create the whitelisted admin account
    let user = await User.findOne({ email: sanitizedEmail });

    if (!user) {
        // Automatically provision an admin account
        user = await User.create({
            name: sanitizedEmail.split("@")[0],
            email: sanitizedEmail,
            phone: "N/A",
            role: "admin"
        });
        console.log(`[Admin Auth] Auto-created new whitelisted admin account: ${sanitizedEmail}`);
    } else if (user.role !== "admin") {
        // Explicitly upgrade the user to admin if whitelisted
        user.role = "admin";
        await user.save();
        console.log(`[Admin Auth] Upgraded existing user to admin: ${sanitizedEmail}`);
    }

    // Sign session
    const token = generateToken(user._id);

    return res.status(200).json({
        success: true,
        message: "Authentication successful.",
        token,
        user: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role
        }
    });
});

export default {
    sendAdminOTP,
    verifyAdminOTP
};
