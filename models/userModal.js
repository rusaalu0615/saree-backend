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
