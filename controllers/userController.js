import User from "../models/userModal.js"
import generateToken from "../utils/generateToken.js"
import bcrypt from "bcryptjs"
import asyncHandler from "../utils/asyncHandler.js"
import OTP from "../models/otpModel.js"
import emailService from "../services/emailService.js"

const registerUser = asyncHandler(async (req, res) => {
    const { name, email, phone, password } = req.body;

    if (!email) {
        return res.status(400).json({ message: "Email is required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    const userExists = await User.findOne({ email: sanitizedEmail });
    if (userExists) {
        return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
        name,
        email: sanitizedEmail,
        phone,
        password: hashedPassword,
    });

    const token = generateToken(user._id);

    // Set secure, HttpOnly, SameSite=None cookie for XSS protection
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        token: token,
    })
});

const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email) {
        return res.status(400).json({ message: "Email is required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    const user = await User.findOne({ email: sanitizedEmail });
    if (!user) {
        return res.status(400).json({ message: "User not found" })
    }

    if (!password || !user.password) {
        return res.status(400).json({ message: "Invalid email or password" })
    }

    const matchPassword = await bcrypt.compare(password, user.password);
    if (!matchPassword) {
        return res.status(400).json({ message: "Invalid email or password" })
    }

    const token = generateToken(user._id);

    // Set secure, HttpOnly, SameSite=None cookie for XSS protection
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(200).json({
        user,
        token,
        message: "Login successfull",
    })
});

const forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: "Email is required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: sanitizedEmail });

    if (!user) {
        return res.status(404).json({ message: "No user found with this email" });
    }

    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete any existing OTP for this email
    await OTP.deleteMany({ email: sanitizedEmail });

    // Save new OTP
    await OTP.create({
        email: sanitizedEmail,
        otp: otpCode
    });

    // Send email
    await emailService.sendPasswordResetOTPEmail(sanitizedEmail, otpCode);

    res.status(200).json({ message: "Password reset OTP sent to your email" });
});

const verifyOtp = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ message: "Email and OTP are required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    
    const validOtp = await OTP.findOne({ email: sanitizedEmail, otp });

    if (!validOtp) {
        return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    res.status(200).json({ message: "OTP verified successfully" });
});

const resetPassword = asyncHandler(async (req, res) => {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
        return res.status(400).json({ message: "Email, OTP, and new password are required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    // Verify OTP one last time to ensure they didn't just bypass the previous step
    const validOtp = await OTP.findOne({ email: sanitizedEmail, otp });

    if (!validOtp) {
        return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    const user = await User.findOne({ email: sanitizedEmail });
    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    // Delete used OTP
    await OTP.deleteOne({ _id: validOtp._id });

    res.status(200).json({ message: "Password reset successfully" });
});

const logoutUser = asyncHandler(async (req, res) => {
    res.cookie("auth_token", "", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        expires: new Date(0) // Expire immediately
    });
    res.status(200).json({ message: "Logged out successfully" });
});

export default { registerUser, loginUser, logoutUser, forgotPassword, verifyOtp, resetPassword }