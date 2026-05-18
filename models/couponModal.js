import mongoose from "mongoose";

const couponSchema = new mongoose.Schema({
    code: {
        type: String,
        required: [true, "Coupon code is required"],
        unique: true,
        uppercase: true,
        trim: true,
    },
    discountType: {
        type: String,
        enum: ["percentage", "fixed"],
        required: true,
        default: "percentage",
    },
    discountValue: {
        type: Number,
        required: [true, "Discount value is required"],
        min: 0,
    },
    minPurchase: {
        type: Number,
        default: 0,
    },
    expiryDate: {
        type: Date,
        required: [true, "Expiry date is required"],
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    usageLimit: {
        type: Number,
        default: 100, // how many times this coupon can be used overall
    },
    usageLimitPerUser: {
        type: Number,
        default: 1, // how many times a SINGLE user can use this coupon
    },
    usedCount: {
        type: Number,
        default: 0,
    },
    usedBy: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
    ],
}, { timestamps: true });

// Check if coupon is valid (not expired, active, and within limit)
couponSchema.methods.isValid = function () {
    return (
        this.isActive &&
        this.usedCount < this.usageLimit &&
        new Date() <= new Date(this.expiryDate)
    );
};

// Calculate discount amount based on subtotal
couponSchema.methods.calculateDiscount = function (subtotal) {
    if (this.discountType === "percentage") {
        // Cap percentage discount to not exceed subtotal just in case
        return Math.floor((subtotal * this.discountValue) / 100);
    } else {
        // Fixed amount
        return this.discountValue > subtotal ? subtotal : this.discountValue;
    }
};

export default mongoose.model("Coupon", couponSchema);
