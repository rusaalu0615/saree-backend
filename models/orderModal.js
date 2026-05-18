import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema({
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true,
    },
    name: { type: String, required: true },
    slug: { type: String },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    image: String,
    sku: String,
});

const shippingAddressSchema = new mongoose.Schema({
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
    landmark: String,
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
});

const timelineEntrySchema = new mongoose.Schema({
    status: { type: String, required: true },
    date: { type: Date, default: Date.now },
    location: String,
    description: String,
});

const orderSchema = new mongoose.Schema({
    orderId: {
        type: String,
        unique: true,
        required: true,
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    items: [orderItemSchema],
    shippingAddress: shippingAddressSchema,
    payment: {
        method: {
            type: String,
            enum: ["cod", "prepaid", "upi", "card"],
            default: "cod",
        },
        status: {
            type: String,
            enum: ["pending", "paid", "failed", "refunded"],
            default: "pending",
        },
        transactionId: String,
    },
    pricing: {
        subtotal: { type: Number, required: true },
        shipping: { type: Number, default: 0 },
        discount: { type: Number, default: 0 },
        couponCode: String,
        total: { type: Number, required: true },
    },
    shiprocket: {
        orderId: Number,
        shipmentId: Number,
        awbCode: String,
        courierName: String,
        courierCompanyId: Number,
        status: String,
        trackingUrl: String,
    },
    status: {
        type: String,
        enum: [
            "placed",
            "confirmed",
            "processing",
            "shipped",
            "in_transit",
            "out_for_delivery",
            "delivered",
            "cancelled",
            "returned",
        ],
        default: "placed",
    },
    timeline: [timelineEntrySchema],
    notes: String,
}, { timestamps: true });

// Generate unique order ID
orderSchema.pre("validate", async function () {
    if (!this.orderId) {
        const date = new Date();
        const dateStr = date.toISOString().slice(0, 10).replace(/-/g, "");
        const random = Math.random().toString(36).substring(2, 6).toUpperCase();
        this.orderId = `LS-${dateStr}-${random}`;
    }
});

// Indexes for fast lookups
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ "shiprocket.awbCode": 1 });
orderSchema.index({ "shippingAddress.email": 1 });

export default mongoose.model("Order", orderSchema);
