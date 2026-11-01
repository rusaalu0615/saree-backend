import Hero from "../models/heroModal.js";
import { uploadImage, deleteFromR2 } from "../utils/r2Upload.js";

// Fetch the Hero data
export const getHero = async (req, res) => {
    try {
        let hero = await Hero.findOne();

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
        const { title, subtitle, description, category, link, buttonText, secondaryButtonText, secondaryLink, badge, layoutStyle } = req.body;
        const image = req.file;

        if (!image) {
            return res.status(400).json({ success: false, message: "Image is required for a new slide" });
        }

        let hero = await Hero.findOne();
        if (!hero) {
            hero = new Hero({ slides: [] });
        }

        // Upload image to Cloudflare R2
        const imageUrl = await uploadImage(image.buffer, image.originalname);

        hero.slides.push({
            title: title || "",
            subtitle: subtitle || "",
            description: description || "",
            category: category || "",
            link: link || "/collections",
            buttonText: buttonText || "Explore Collection",
            secondaryButtonText: secondaryButtonText || "",
            secondaryLink: secondaryLink || "",
            badge: badge || category || "",
            layoutStyle: layoutStyle || "editorial-split",
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

// Update an existing Hero slide
export const updateHeroSlide = async (req, res) => {
    try {
        const { slideId } = req.params;
        const { title, subtitle, description, category, link, buttonText, secondaryButtonText, secondaryLink, badge, layoutStyle } = req.body;
        const image = req.file;

        let hero = await Hero.findOne();
        if (!hero) {
            return res.status(404).json({ success: false, message: "Hero document not found" });
        }

        const slide = hero.slides.id(slideId) || hero.slides.find(s => s._id.toString() === slideId);
        if (!slide) {
            return res.status(404).json({ success: false, message: "Slide not found" });
        }

        if (title !== undefined) slide.title = title;
        if (subtitle !== undefined) slide.subtitle = subtitle;
        if (description !== undefined) slide.description = description;
        if (category !== undefined) slide.category = category;
        if (link !== undefined) slide.link = link;
        if (buttonText !== undefined) slide.buttonText = buttonText;
        if (secondaryButtonText !== undefined) slide.secondaryButtonText = secondaryButtonText;
        if (secondaryLink !== undefined) slide.secondaryLink = secondaryLink;
        if (badge !== undefined) slide.badge = badge;
        if (layoutStyle !== undefined) slide.layoutStyle = layoutStyle;

        if (image) {
            if (slide.image && !slide.image.startsWith('/images/')) {
                deleteFromR2(slide.image).catch(() => {});
            }
            const imageUrl = await uploadImage(image.buffer, image.originalname);
            slide.image = imageUrl;
        }

        await hero.save();

        res.status(200).json({
            success: true,
            message: "Slide updated successfully",
            slides: hero.slides
        });
    } catch (error) {
        console.error("Error updating hero slide:", error);
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

        const slideToDelete = hero.slides.find(slide => slide._id.toString() === slideId);
        if (slideToDelete?.image && !slideToDelete.image.startsWith('/images/')) {
            deleteFromR2(slideToDelete.image).catch(() => {});
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
