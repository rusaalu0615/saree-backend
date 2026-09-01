import CelebrityBanner from "../models/celebrityBannerModal.js";
import { uploadImage } from "../utils/r2Upload.js";

// @desc    Get Celebrity Collection Banner
// @route   GET /api/celebrity-collection
// @access  Public
export const getCelebrityBanner = async (req, res) => {
    try {
        let banner = await CelebrityBanner.findOne();
        if (!banner) {
            // Create a default one if it doesn't exist
            banner = await CelebrityBanner.create({});
        }
        res.status(200).json({
            success: true,
            data: banner,
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

// @desc    Upsert Celebrity Collection Banner
// @route   POST /api/celebrity-collection
// @access  Private/Admin
export const upsertCelebrityBanner = async (req, res) => {
    try {
        const updateData = { ...req.body };
        
        // Handle image if uploaded via multer
        if (req.file) {
            updateData.image = await uploadImage(req.file.buffer, req.file.originalname);
        }

        const banner = await CelebrityBanner.findOneAndUpdate({}, updateData, {
            new: true,
            upsert: true,
            setDefaultsOnInsert: true,
            runValidators: true
        });

        res.status(200).json({
            success: true,
            message: "Celebrity collection banner updated successfully",
            data: banner,
        });
    } catch (error) {
        console.error("Error upserting celebrity banner:", error);
        res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};
