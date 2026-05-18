import mongoose from "mongoose";

const slideSchema = new mongoose.Schema({
    image: {
        type: String,
        required: true
    },
    title: {
        type: String,
        required: true
    },
    subtitle: {
        type: String,
        required: true
    },
    description: {
        type: String,
        required: true
    },
    category: {
        type: String,
        required: true
    },
    link: {
        type: String,
        required: true
    }
});

const heroSchema = new mongoose.Schema({
    slides: {
        type: [slideSchema],
        default: []
    }
}, { timestamps: true })

export default mongoose.model("Hero", heroSchema)
