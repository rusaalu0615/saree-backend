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
    attempts: {
        type: Number,
        default: 0,
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 300, // 5 minutes (in seconds) - MongoDB will automatically delete this document after 5 mins
    }
});

// Create index on email and createdAt for faster search/sorting
otpSchema.index({ email: 1, createdAt: -1 });

export default mongoose.model("OTP", otpSchema);
