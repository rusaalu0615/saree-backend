import mongoose from "mongoose";


const addressSchema = new mongoose.Schema({
    fullName: String,
    mobile: String,
    pincode: String,
    state: String,
    city: String,
    address: String,
    landmark: String,

})

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
})

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

})


const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
    },
    phone: {
        type: String,
        required: true,
    },
    password: {
        type: String,
        // Never returned by default — controllers that need to compare hashes
        // must opt in with .select("+password"). Prevents accidental hash leaks.
        select: false,
    },
    // Set whenever the password changes (reset). JWTs issued before this
    // timestamp are rejected, so a reset signs out all other devices/sessions.
    passwordChangedAt: { type: Date },
    // Sessions explicitly killed before their natural expiry (logout). Each
    // entry is the jti of a revoked token + when it would have expired, so the
    // list self-prunes. select:false keeps it out of every API response.
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

export default mongoose.model("User", userSchema);
