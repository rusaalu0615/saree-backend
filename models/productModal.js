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
        required: [true, "Regular price is required"],
        min: [0, "Regular price cannot be negative"],
        validate: {
            validator: (v) => Number.isFinite(v) && v >= 0,
            message: "Regular price must be a finite, non-negative number",
        },
    },
    price: {
        type: Number,
        required: [true, "Price is required"],
        min: [0, "Price cannot be negative"],
        validate: {
            validator: (v) => Number.isFinite(v) && v >= 0,
            message: "Price must be a finite, non-negative number",
        },
    },
    stock: {
        type: Number,
        required: [true, "Stock is required"],
        default: 0,
        min: [0, "Stock cannot be negative"],
        validate: {
            validator: (v) => Number.isInteger(v) && v >= 0,
            message: "Stock must be a non-negative whole integer",
        },
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
    averageRating: {
        type: Number,
        default: 0,
        min: 0,
        max: 5,
    },
    numReviews: {
        type: Number,
        default: 0,
        min: 0,
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