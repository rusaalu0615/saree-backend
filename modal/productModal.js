import mongoose from "mongoose";

const productSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    sku: {
        type: String,
        required: true,
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
        default: "Color variance note",
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
}, { timestamps: true });

export default mongoose.model("Product", productSchema);