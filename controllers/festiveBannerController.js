import FestiveBanner from "../models/festiveBannerModal.js";
import { uploadImage } from "../utils/r2Upload.js";

// Fetch Festive Banner data
export const getFestiveBanner = async (req, res) => {
    try {
        let festiveBanner = await FestiveBanner.findOne();

        // If no document exists, create one with defaults
        if (!festiveBanner) {
            festiveBanner = await FestiveBanner.create({});
        }

        res.status(200).json({
            success: true,
            data: festiveBanner
        });
    } catch (error) {
        console.error("Error fetching festive banner data:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

// Update Festive Banner data
export const updateFestiveBanner = async (req, res) => {
    try {
        const { title1, title2, offer, description, buttonText, link } = req.body;
        const imageFile = req.file;

        let festiveBanner = await FestiveBanner.findOne();

        if (!festiveBanner) {
            festiveBanner = new FestiveBanner({});
        }

        // Update text fields
        if (title1) festiveBanner.title1 = title1;
        if (title2) festiveBanner.title2 = title2;
        if (offer) festiveBanner.offer = offer;
        if (description) festiveBanner.description = description;
        if (buttonText) festiveBanner.buttonText = buttonText;
        if (link) festiveBanner.link = link;

        // Update image if provided
        if (imageFile) {
            festiveBanner.image = await uploadImage(imageFile.buffer, imageFile.originalname);
        }

        await festiveBanner.save();

        res.status(200).json({
            success: true,
            message: "Festive banner updated successfully",
            data: festiveBanner
        });
    } catch (error) {
        console.error("Error updating festive banner data:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};
