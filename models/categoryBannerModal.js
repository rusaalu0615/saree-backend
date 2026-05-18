import mongoose from "mongoose";

const categoryBannerSchema = new mongoose.Schema({
    slug: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    title: {
        type: String,
        required: true
    },
    subtitle: {
        type: String,
    },
    description: {
        type: String,
    },
    image: {
        type: String,
        required: true
    },
    buttonText: {
        type: String,
        default: "SHOP COLLECTION"
    },
    link: {
        type: String
    }
}, { timestamps: true });

export default mongoose.model("CategoryBanner", categoryBannerSchema);
