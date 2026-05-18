import CategoryBanner from "../models/categoryBannerModal.js";

// Get banner by slug
export const getCategoryBannerBySlug = async (req, res) => {
    try {
        const { slug } = req.params;
        const banner = await CategoryBanner.findOne({ slug });
        
        if (!banner) {
            return res.status(200).json({
                success: false,
                message: "Banner not found for this category"
            });
        }

        res.status(200).json({
            success: true,
            data: banner
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Error fetching category banner",
            error: error.message
        });
    }
};

// Get all banners
export const getAllCategoryBanners = async (req, res) => {
    try {
        const banners = await CategoryBanner.find({});
        res.status(200).json({
            success: true,
            data: banners
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Error fetching all category banners",
            error: error.message
        });
    }
};

// Create or Update banner
export const upsertCategoryBanner = async (req, res) => {
    try {
        const { slug, title, subtitle, description, buttonText, link } = req.body;
        
        // Handle image path from Cloudinary upload or existing body data
        const imagePath = req.file ? req.file.path : req.body.image;

        if (!slug || !title || !imagePath) {
            return res.status(400).json({
                success: false,
                message: "Please provide slug, title, and image"
            });
        }

        const banner = await CategoryBanner.findOneAndUpdate(
            { slug },
            { 
                title, 
                subtitle, 
                description, 
                image: imagePath, 
                buttonText, 
                link: link || `/collections/${slug}` 
            },
            { new: true, upsert: true }
        );

        res.status(200).json({
            success: true,
            message: "Category banner updated successfully",
            data: banner
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Error saving category banner",
            error: error.message
        });
    }
};
