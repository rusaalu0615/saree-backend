import mongoose from "mongoose";

const slideSchema = new mongoose.Schema({
    image: {
        type: String,
        required: true
    },
    title: {
        type: String,
        default: ""
    },
    subtitle: {
        type: String,
        default: ""
    },
    description: {
        type: String,
        default: ""
    },
    category: {
        type: String,
        default: ""
    },
    link: {
        type: String,
        default: "/collections"
    },
    buttonText: {
        type: String,
        default: "Explore Collection"
    },
    secondaryButtonText: {
        type: String,
        default: ""
    },
    secondaryLink: {
        type: String,
        default: ""
    },
    badge: {
        type: String,
        default: ""
    },
    layoutStyle: {
        type: String,
        default: "editorial-split"
    }
}, { strict: false });

const heroSchema = new mongoose.Schema({
    slides: {
        type: [slideSchema],
        default: []
    }
}, { timestamps: true });

export default mongoose.model("Hero", heroSchema);
