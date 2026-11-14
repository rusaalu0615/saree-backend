import mongoose from "mongoose";

const addressSchema = new mongoose.Schema({
    fullName: String,
    mobile: String,
    pincode: String,
    state: String,
    city: String,
    address: String,
    landmark: String,
});

const cartSchema = new mongoose.Schema({
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true,
    },
    quantity: {
        type: Number,
        required: true,
    },
});

const wishListSchema = new mongoose.Schema({
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true,
    },
    quantity: {
        type: Number,
        required: true,
    },
});

const userSchema = new mongoose.Schema({
    storeId: {
        type: String,
        required: true,
        enum: ["handloomer", "linen"],
        default: "handloomer",
        index: true,
    },
    name: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
    },
    phone: {
        type: String,
        required: true,
    },
    password: {
        type: String,
        select: false,
    },
    passwordChangedAt: { type: Date },
    revokedTokens: {
        type: [{ jti: String, expiresAt: Date }],
        default: [],
        select: false,
    },
    role: {
        type: String,
        enum: ["user", "admin"],
        default: "user",
    },
    address: [addressSchema],
    cart: [cartSchema],
    wishList: [wishListSchema],
}, { timestamps: true });

// Multi-Store Isolation:
// - Email is unique per store: allows identical email across stores, but unique within each store.
// - Phone is indexed per store for fast lookups, but non-unique (allows family members / guest checkouts to share a phone).
userSchema.index({ email: 1, storeId: 1 }, { unique: true });
userSchema.index({ phone: 1, storeId: 1 });

export default mongoose.model("User", userSchema);
