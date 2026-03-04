import productModal from "../modal/productModal.js";

const addProduct = async (req, res) => {
    try {
        const {
            name, sku, category, regularPrice, price, stock,
            shortDescription, tags, color,
            material, sareeSize, blouseSize, washCare, dispatch,
            disclaimer, internationalNote, videoUrl,
            galleryImageInfos: galleryImageInfosRaw,
        } = req.body;

        const files = req.files;
        const mainImage = files?.mainImage?.[0]?.path;
        const galleryPaths = files?.galleryImages?.map((f) => f.path) || [];

        // Parse gallery image metadata and merge with uploaded file paths
        let galleryImageInfos = [];
        try {
            galleryImageInfos = galleryImageInfosRaw ? JSON.parse(galleryImageInfosRaw) : [];
        } catch (e) {
            galleryImageInfos = [];
        }

        const galleryImages = galleryPaths.map((url, i) => ({
            url,
            title: galleryImageInfos[i]?.title || "",
            description: galleryImageInfos[i]?.description || "",
            alt: galleryImageInfos[i]?.alt || "",
            tags: galleryImageInfos[i]?.tags || [],
        }));
        const videoFile = files?.videoFile?.[0]?.path || null;

        if (
            !name || !sku || !category || !price || !regularPrice || !stock ||
            !shortDescription || !tags || !color || !material || !sareeSize ||
            !blouseSize || !washCare || !mainImage
        ) {
            return res.status(400).json({
                success: false,
                message: "All fields except Video and permanent notes are required.",
            });
        }

        const product = await productModal.create({
            name, sku, category,
            regularPrice: regularPrice ? Number(regularPrice) : undefined,
            price: Number(price),
            stock: Number(stock),
            shortDescription, tags, color,
            mainImage, galleryImages, videoFile, videoUrl,
            material, sareeSize, blouseSize, washCare, dispatch,
            disclaimer, internationalNote,
        });

        res.status(201).json({
            success: true,
            message: "Product added successfully",
            product,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

const getAllProducts = async (req, res) => {
    try {
        const products = await productModal.find().sort({ createdAt: -1 });
        res.status(200).json({
            success: true,
            products,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

const getProductById = async (req, res) => {
    try {
        const { id } = req.params;
        const product = await productModal.findById(id);
        if (!product) {
            return res.status(404).json({
                success: false,
                message: "Product not found",
            });
        }
        res.status(200).json({
            success: true,
            product,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

const deleteProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const product = await productModal.findByIdAndDelete(id);
        if (!product) {
            return res.status(404).json({
                success: false,
                message: "Product not found",
            });
        }
        res.status(200).json({
            success: true,
            message: "Product deleted successfully",
            product,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

const deleteMultipleProducts = async (req, res) => {
    try {
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "An array of product IDs is required",
            });
        }

        const result = await productModal.deleteMany({ _id: { $in: ids } });

        res.status(200).json({
            success: true,
            message: `${result.deletedCount} product(s) deleted successfully`,
            deletedCount: result.deletedCount,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

const updateProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            name, sku, category, regularPrice, price, stock,
            shortDescription, tags, color,
            material, sareeSize, blouseSize, washCare, dispatch,
            disclaimer, internationalNote, videoUrl,
            galleryImageInfos: galleryImageInfosRaw,
            existingGalleryImages: existingGalleryImagesRaw,
        } = req.body;

        const files = req.files;
        const updateData = {};

        // Only include fields that were actually provided
        const numberFields = ["regularPrice", "price", "stock"];
        const textFields = {
            name, sku, category, shortDescription, tags, color,
            videoUrl, material, sareeSize, blouseSize, washCare,
            dispatch, disclaimer, internationalNote,
            regularPrice, price, stock,
        };

        Object.entries(textFields).forEach(([key, value]) => {
            if (value !== undefined && value !== "") {
                updateData[key] = numberFields.includes(key) ? Number(value) : value;
            }
        });

        // Only update images if new ones are uploaded
        if (files?.mainImage?.[0]?.path) {
            updateData.mainImage = files.mainImage[0].path;
        }

        // Handle gallery images: merge existing (with metadata) + newly uploaded
        let existingGallery = [];
        try {
            existingGallery = existingGalleryImagesRaw ? JSON.parse(existingGalleryImagesRaw) : [];
        } catch (e) {
            existingGallery = [];
        }

        let newGalleryInfos = [];
        try {
            newGalleryInfos = galleryImageInfosRaw ? JSON.parse(galleryImageInfosRaw) : [];
        } catch (e) {
            newGalleryInfos = [];
        }

        const newGalleryPaths = files?.galleryImages?.map((f) => f.path) || [];
        const newGalleryImages = newGalleryPaths.map((url, i) => ({
            url,
            title: newGalleryInfos[i]?.title || "",
            description: newGalleryInfos[i]?.description || "",
            alt: newGalleryInfos[i]?.alt || "",
            caption: newGalleryInfos[i]?.caption || "",
        }));

        // Combine: existing images (with updated metadata) + newly uploaded
        if (existingGallery.length > 0 || newGalleryImages.length > 0) {
            updateData.galleryImages = [...existingGallery, ...newGalleryImages];
        }

        const product = await productModal.findByIdAndUpdate(id, updateData, { new: true });
        if (!product) {
            return res.status(404).json({
                success: false,
                message: "Product not found",
            });
        }

        res.status(200).json({
            success: true,
            message: "Product updated successfully",
            product,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

const updateGalleryImageInfo = async (req, res) => {
    try {
        const { id } = req.params;
        const { imageIndex, title, description, alt, caption } = req.body;

        const product = await productModal.findById(id);
        if (!product) {
            return res.status(404).json({
                success: false,
                message: "Product not found",
            });
        }

        if (imageIndex < -1 || imageIndex >= product.galleryImages.length) {
            return res.status(400).json({
                success: false,
                message: "Invalid image index",
            });
        }

        if (imageIndex === -1) {
            // Update mainImageInfo
            if (!product.mainImageInfo) product.mainImageInfo = {};
            if (title !== undefined) product.mainImageInfo.title = title;
            if (description !== undefined) product.mainImageInfo.description = description;
            if (alt !== undefined) product.mainImageInfo.alt = alt;
            if (caption !== undefined) product.mainImageInfo.caption = caption;
        } else {
            // Handle old string format for gallery image: convert to object first
            if (typeof product.galleryImages[imageIndex] === "string") {
                product.galleryImages[imageIndex] = {
                    url: product.galleryImages[imageIndex],
                    title: title || "",
                    description: description || "",
                    alt: alt || "",
                    caption: caption || "",
                };
            } else {
                if (title !== undefined) product.galleryImages[imageIndex].title = title;
                if (description !== undefined) product.galleryImages[imageIndex].description = description;
                if (alt !== undefined) product.galleryImages[imageIndex].alt = alt;
                if (caption !== undefined) product.galleryImages[imageIndex].caption = caption;
            }
        }

        await product.save();

        res.status(200).json({
            success: true,
            message: "Image info updated successfully",
            product,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export default { addProduct, getAllProducts, getProductById, deleteProduct, deleteMultipleProducts, updateProduct, updateGalleryImageInfo };
