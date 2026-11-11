import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: false,
    },
    userName: {
        type: String,
        trim: true,
        default: "Anonymous",
    },
    userEmail: {
        type: String,
        trim: true,
        lowercase: true,
    },
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true,
    },
    rating: {
        type: Number,
        required: [true, "Rating is required"],
        min: 1,
        max: 5,
    },
    title: {
        type: String,
        maxLength: 100,
    },
    comment: {
        type: String,
        required: [true, "Comment is required"],
        maxLength: 1000,
    },
    photos: [{
        type: String,
    }],
    isApproved: {
        type: Boolean,
        default: true,
        index: true,
    },
    status: {
        type: String,
        enum: ["pending", "approved", "rejected"],
        default: "approved",
        index: true,
    },
}, { timestamps: true });

// Prevent a user from submitting more than one review per product
reviewSchema.index({ user: 1, product: 1 }, { unique: true, sparse: true });

export default mongoose.model("Review", reviewSchema);
