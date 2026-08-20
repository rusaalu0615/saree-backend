import mongoose from "mongoose";

const productSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    sku: {
        type: String,
        required: true,
        unique: true,
    },
    category: {
        type: String,
        required: true,
    },
    regularPrice: {
        type: Number,
        required: true,
    },
    price: {
        type: Number,
        required: true,
    },
    stock: {
        type: Number,
        required: true,
        default: 0,
    },
    shortDescription: {
        type: String,
        required: true,
    },
    tags: {
        type: String,
        required: true,
    },
    mainImage: {
        type: String,
        required: true,
    },
    mainImageInfo: {
        title: { type: String, default: "" },
        description: { type: String, default: "" },
        alt: { type: String, default: "" },
        caption: { type: String, default: "" },
    },
    galleryImages: [{
        url: { type: String, required: true },
        title: { type: String, default: "" },
        description: { type: String, default: "" },
        alt: { type: String, default: "" },
        caption: { type: String, default: "" },
    }],
    color: {
        type: String,
        required: true,
    },
    // Specifications
    material: {
        type: String,
        required: true,
    },
    sareeSize: {
        type: String,
        required: true,
    },
    blouseSize: {
        type: String,
        required: true,
    },
    washCare: {
        type: String,
        required: true,
    },
    dispatch: {
        type: String,
        default: "2-3 days",
    },
    disclaimer: {
        type: String,
        default: "Actual product color may differ slightly from the images due to lighting and display differences.",
    },
    internationalNote: {
        type: String,
        default: "Custom duties",
    },
    // Video
    videoUrl: {
        type: String,
    },
    videoFile: {
        type: String,
    },
    isOnSale: {
        type: Boolean,
        default: false,
    },
    isNewArrival: {
        type: Boolean,
        default: false,
    },
    isFestive: {
        type: Boolean,
        default: false,
    },
    productCollection: {
        type: String,
        default: "",
    },
}, { timestamps: true });

productSchema.index(
    {
        name: "text",
        category: "text",
        tags: "text",
        color: "text",
        material: "text",
        shortDescription: "text"
    },
    {
        weights: {
            name: 10,
            category: 5,
            color: 3,
            material: 3,
            tags: 2,
            shortDescription: 1
        },
        name: "ProductTextIndex"
    }
);

// Scalar indexes for efficient exact match filtering
productSchema.index({ category: 1 });
productSchema.index({ price: 1 });
productSchema.index({ color: 1 });
productSchema.index({ material: 1 });
productSchema.index({ isOnSale: 1 });
productSchema.index({ isFestive: 1 });
productSchema.index({ isNewArrival: 1 });

export default mongoose.model("Product", productSchema);