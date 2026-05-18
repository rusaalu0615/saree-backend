import FestiveSale from "../models/festiveSaleModal.js";

// Fetch Festive Sale data
export const getFestiveSale = async (req, res) => {
    try {
        let festiveSale = await FestiveSale.findOne();

        // If no document exists, create one with defaults
        if (!festiveSale) {
            festiveSale = await FestiveSale.create({});
        }

        res.status(200).json({
            success: true,
            data: festiveSale
        });
    } catch (error) {
        console.error("Error fetching festive sale data:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

// Update Festive Sale data
export const updateFestiveSale = async (req, res) => {
    try {
        const { title1, title2, offer, description, buttonText, link } = req.body;
        const imageFile = req.file;

        let festiveSale = await FestiveSale.findOne();

        if (!festiveSale) {
            festiveSale = new FestiveSale({});
        }

        // Update text fields
        if (title1) festiveSale.title1 = title1;
        if (title2) festiveSale.title2 = title2;
        if (offer) festiveSale.offer = offer;
        if (description) festiveSale.description = description;
        if (buttonText) festiveSale.buttonText = buttonText;
        if (link) festiveSale.link = link;

        // Update image if provided
        if (imageFile) {
            festiveSale.image = imageFile.path; // Cloudinary URL
        }

        await festiveSale.save();

        res.status(200).json({
            success: true,
            message: "Festive sale updated successfully",
            data: festiveSale
        });
    } catch (error) {
        console.error("Error updating festive sale data:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};
