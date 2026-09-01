import MarketingCollection from "../models/marketingCollectionModal.js";
import { uploadImage } from "../utils/r2Upload.js";

// @desc    Get all marketing collections
// @route   GET /api/marketing-collections
// @access  Public
export const getMarketingCollections = async (req, res) => {
    try {
        let collections = await MarketingCollection.find();
        
        // If no collections exist, seed them
        if (collections.length === 0) {
            const defaults = [
                {
                    key: "festive",
                    name: "Festive Collection",
                    title1: "Experience",
                    title2: "Festive Collection",
                    description: "Discover our latest curated festive sarees, handcrafted with elegance and tradition.",
                    buttonText: "SHOP COLLECTION",
                    link: "/collections/festive",
                    image: "/images/bridal-saree.jpg"
                },
                {
                    key: "big-sale",
                    name: "Big Sale Collection",
                    title1: "festive",
                    title2: "BIG SALE",
                    offer: "UP TO 60% OFF",
                    description: "Limited time offer on premium linen sarees - Don't miss out on these incredible deals!",
                    buttonText: "SHOP SALE NOW",
                    link: "/collections/offers",
                    image: "/images/designer-saree.jpg"
                },
                {
                    key: "celebrity",
                    name: "Celebrity Collection",
                    badge: "Celebrity Choice",
                    tagline: "Celebrity Collection",
                    titleColorPart: "Dress Like a",
                    titleItalicPart: "Star",
                    description: "Discover the exclusive collection favored by icons. Our Celebrity Collection brings red-carpet elegance to your wardrobe with premium linen sarees and sophisticated designs.",
                    buttonText: "Explore Collection",
                    link: "/collections/celebrity",
                    image: "/images/celebrity-collection.png",
                    stats: [
                        { number: "500+", label: "Styles" },
                        { number: "20+", label: "Celebrities" },
                        { number: "5★", label: "Rating" }
                    ]
                }
            ];
            collections = await MarketingCollection.insertMany(defaults);
        }
        
        res.status(200).json({
            success: true,
            data: collections
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// @desc    Update a marketing collection
// @route   PUT /api/marketing-collections/:key
// @access  Private/Admin
export const updateMarketingCollection = async (req, res) => {
    try {
        const { key } = req.params;
        const updateData = { ...req.body };
        
        // Handle stats if passed as string (from multipart/form-data)
        if (typeof updateData.stats === 'string') {
            try {
                updateData.stats = JSON.parse(updateData.stats);
            } catch (e) {
                console.error("Error parsing stats:", e);
            }
        }

        // Handle image if uploaded
        if (req.file) {
            updateData.image = await uploadImage(req.file.buffer, req.file.originalname);
        }

        const collection = await MarketingCollection.findOneAndUpdate(
            { key },
            updateData,
            { new: true, runValidators: true }
        );

        if (!collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found"
            });
        }

        res.status(200).json({
            success: true,
            message: "Collection updated successfully",
            data: collection
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// @desc    Get single collection by key
// @route   GET /api/marketing-collections/:key
// @access  Public
export const getCollectionByKey = async (req, res) => {
    try {
        const { key } = req.params;
        const collection = await MarketingCollection.findOne({ key });
        
        if (!collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found"
            });
        }

        res.status(200).json({
            success: true,
            data: collection
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
};
