import mongoose from "mongoose";

const productSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    sku: {
        type: String,
    },
    category: {
        type: String,
        required: true,
    },
    regularPrice: {
        type: Number,
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
    },
    tags: {
        type: String,
    },
    mainImage: {
        type: String,
        required: true,
    },
    galleryImages: [{
        type: String,
    }],
    color: {
        type: String,
    },
    // Specifications
    material: {
        type: String,
    },
    sareeSize: {
        type: String,
    },
    blouseSize: {
        type: String,
    },
    washCare: {
        type: String,
    },
    dispatch: {
        type: String,
    },
    disclaimer: {
        type: String,
    },
    internationalNote: {
        type: String,
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