import mongoose from "mongoose";

const otpSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
    },
    otp: {
        type: String,
        required: true,
    },
    purpose: {
        type: String,
        enum: ["admin_login", "password_reset"],
        default: "password_reset",
        required: true,
    },
    attempts: {
        type: Number,
        default: 0,
    },
    verified: {
        type: Boolean,
        default: false,
    },
    verifiedAt: {
        type: Date,
    },
    expiresAt: {
        type: Date,
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 600, // 10 minutes housekeeping TTL
    },
});

// Compound indexes for fast, purpose-bound lookups and verification
otpSchema.index({ email: 1, purpose: 1, expiresAt: 1 });
otpSchema.index({ email: 1, createdAt: -1 });

export default mongoose.model("OTP", otpSchema);
