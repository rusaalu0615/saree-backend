import mongoose from "mongoose";

const festiveBannerSchema = new mongoose.Schema({
    title1: {
        type: String,
        default: "Experience"
    },
    title2: {
        type: String,
        default: "Festive Collection"
    },
    offer: {
        type: String,
        default: "NEW ARRIVALS"
    },
    description: {
        type: String,
        default: "Discover our latest curated festive sarees, handcrafted with elegance and tradition."
    },
    buttonText: {
        type: String,
        default: "SHOP COLLECTION"
    },
    link: {
        type: String,
        default: "/collections/festive"
    },
    image: {
        type: String,
        default: "/images/bridal-saree.jpg"
    }
}, { timestamps: true });

export default mongoose.model("FestiveBanner", festiveBannerSchema);
