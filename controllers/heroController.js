import Hero from "../models/heroModal.js";
import { uploadImage } from "../utils/cloudinaryUpload.js";

// Fetch the Hero data
export const getHero = async (req, res) => {
    try {
        let hero = await Hero.findOne();

        // If no hero section document exists yet, create one with default values
        if (!hero) {
            hero = await Hero.create({ slides: [] });
        }

        res.status(200).json({
            success: true,
            slides: hero.slides
        });
    } catch (error) {
        console.error("Error fetching hero section:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

// Add a new Hero slide
export const addHeroSlide = async (req, res) => {
    try {
        const { title, subtitle, description, category, link } = req.body;
        const image = req.file;

        if (!image) {
            return res.status(400).json({ success: false, message: "Image is required for a new slide" });
        }

        let hero = await Hero.findOne();

        // If no hero exists, create a new one first
        if (!hero) {
            hero = new Hero({ slides: [] });
        }

        // Upload image to Cloudinary
        const imageUrl = await uploadImage(image.buffer, image.originalname);

        hero.slides.push({
            title,
            subtitle,
            description,
            category,
            link,
            image: imageUrl
        });

        await hero.save();

        res.status(201).json({
            success: true,
            message: "Slide added successfully",
            slides: hero.slides
        });
    } catch (error) {
        console.error("Error adding hero slide:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

// Delete a Hero slide
export const deleteHeroSlide = async (req, res) => {
    try {
        const { slideId } = req.params;
        let hero = await Hero.findOne();

        if (!hero) {
            return res.status(404).json({ success: false, message: "Hero document not found" });
        }

        hero.slides = hero.slides.filter(slide => slide._id.toString() !== slideId);
        await hero.save();

        res.status(200).json({
            success: true,
            message: "Slide deleted successfully",
            slides: hero.slides
        });
    } catch (error) {
        console.error("Error deleting hero slide:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};
