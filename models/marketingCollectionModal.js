import mongoose from "mongoose";

const marketingCollectionSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true // 'festive', 'big-sale', 'celebrity', 'none'
    },
    name: {
        type: String,
        required: true
    },
    // Banner specific fields (unifying the different banner models)
    badge: String,
    tagline: String,
    title1: String,
    title2: String,
    titleColorPart: String, // For Celebrity style
    titleItalicPart: String, // For Celebrity style
    description: String,
    buttonText: String,
    link: String,
    image: String,
    // Statistics (primarily for Celebrity style but available for all)
    stats: [
        {
            number: String,
            label: String
        }
    ],
    // Offer details (primarily for Sale style)
    offer: String,
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

export default mongoose.model("MarketingCollection", marketingCollectionSchema);
