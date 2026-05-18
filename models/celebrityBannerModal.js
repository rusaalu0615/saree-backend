import mongoose from "mongoose";

const celebrityBannerSchema = new mongoose.Schema({
    badge: {
        type: String,
        default: "Celebrity Choice"
    },
    tagline: {
        type: String,
        default: "Celebrity Collection"
    },
    titleColorPart: {
        type: String,
        default: "Dress Like a"
    },
    titleItalicPart: {
        type: String,
        default: "Star"
    },
    description: {
        type: String,
        default: "Discover the exclusive collection favored by icons. Our Celebrity Collection brings red-carpet elegance to your wardrobe with premium linen sarees and sophisticated designs."
    },
    stat1Number: {
        type: String,
        default: "500+"
    },
    stat1Label: {
        type: String,
        default: "Styles"
    },
    stat2Number: {
        type: String,
        default: "20+"
    },
    stat2Label: {
        type: String,
        default: "Celebrities"
    },
    stat3Number: {
        type: String,
        default: "5★"
    },
    stat3Label: {
        type: String,
        default: "Rating"
    },
    buttonText: {
        type: String,
        default: "Explore Collection"
    },
    link: {
        type: String,
        default: "/collections/celebrity"
    },
    image: {
        type: String,
        default: "/images/celebrity-collection.png"
    }
}, { timestamps: true });

export default mongoose.model("CelebrityBanner", celebrityBannerSchema);
