import CelebrityBanner from "../models/celebrityBannerModal.js";
import MarketingCollection from "../models/marketingCollectionModal.js";
import { uploadImage } from "../utils/r2Upload.js";
import { pickSchemaFields } from "../utils/security.js";

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
        // Whitelist to declared schema fields — blocks NoSQL-operator injection
        // and mass assignment of unknown/internal fields from the body.
        const updateData = pickSchemaFields(CelebrityBanner, req.body);
        
        // Handle image if uploaded via multer
        if (req.file) {
            updateData.image = await uploadImage(req.file.buffer, req.file.originalname);
        }

        const banner = await CelebrityBanner.findOneAndUpdate({}, updateData, {
            returnDocument: 'after',
            upsert: true,
            setDefaultsOnInsert: true,
            runValidators: true
        });

        // Keep MarketingCollection in sync
        const marketingData = {
            ...(updateData.badge && { badge: updateData.badge }),
            ...(updateData.tagline && { tagline: updateData.tagline }),
            ...(updateData.titleColorPart && { titleColorPart: updateData.titleColorPart }),
            ...(updateData.titleItalicPart && { titleItalicPart: updateData.titleItalicPart }),
            ...(updateData.description && { description: updateData.description }),
            ...(updateData.buttonText && { buttonText: updateData.buttonText }),
            ...(updateData.link && { link: updateData.link }),
            ...(updateData.image && { image: updateData.image }),
        };
        if (updateData.stat1Number || updateData.stat1Label || updateData.stat2Number || updateData.stat2Label || updateData.stat3Number || updateData.stat3Label) {
            marketingData.stats = [
                { number: updateData.stat1Number || "500+", label: updateData.stat1Label || "Styles" },
                { number: updateData.stat2Number || "20+", label: updateData.stat2Label || "Celebrities" },
                { number: updateData.stat3Number || "5★", label: updateData.stat3Label || "Rating" }
            ];
        }
        await MarketingCollection.findOneAndUpdate(
            { key: "celebrity" },
            marketingData,
            { returnDocument: 'after', upsert: true }
        ).catch(err => console.warn("Sync celebrity marketing collection error:", err));

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
