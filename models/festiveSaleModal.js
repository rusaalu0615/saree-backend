import mongoose from "mongoose";

const festiveSaleSchema = new mongoose.Schema({
    title1: {
        type: String,
        default: "festive"
    },
    title2: {
        type: String,
        default: "BIG SALE"
    },
    offer: {
        type: String,
        default: "UP TO 60% OFF"
    },
    description: {
        type: String,
        default: "Limited time offer on premium linen sarees - Don't miss out on these incredible deals!"
    },
    buttonText: {
        type: String,
        default: "SHOP SALE NOW"
    },
    link: {
        type: String,
        default: "/collections/offers"
    },
    image: {
        type: String,
        default: "/images/designer-saree.jpg"
    }
}, { timestamps: true });

export default mongoose.model("FestiveSale", festiveSaleSchema);
