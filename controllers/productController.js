import productModal from "../models/productModal.js";
import cloudinary from "../config/cloudinary.js";
import {
    uploadImage,
    uploadImages,
    uploadVideo,
    deleteFromCloudinary,
    deleteMultipleFromCloudinary,
} from "../utils/cloudinaryUpload.js";

const addProduct = async (req, res) => {
    try {
        const {
            name, sku, category, regularPrice, price, stock,
            shortDescription, tags, color,
            material, sareeSize, blouseSize, washCare, dispatch,
            disclaimer, internationalNote, videoUrl,
            isOnSale, isNewArrival, productCollection,
            galleryImageInfos: galleryImageInfosRaw,
        } = req.body;

        const files = req.files;

        // ── Validate BEFORE uploading to Cloudinary ──
        if (
            !name || !sku || !category || !price || !regularPrice || !stock ||
            !shortDescription || !tags || !color || !material || !sareeSize ||
            !blouseSize || !washCare || !files?.mainImage?.[0]
        ) {
            return res.status(400).json({
                success: false,
                message: "All fields except Video and permanent notes are required.",
            });
        }

        // ── Upload all files to Cloudinary IN PARALLEL ──
        const [mainImageUrl, galleryUrls, videoFileUrl] = await Promise.all([
            // Main image
            uploadImage(files.mainImage[0].buffer, files.mainImage[0].originalname),
            // Gallery images
            uploadImages(files.galleryImages || []),
            // Video file (optional)
            files?.videoFile?.[0]
                ? uploadVideo(files.videoFile[0].buffer)
                : Promise.resolve(null),
        ]);

        // Parse gallery image metadata and merge with uploaded file paths
        let galleryImageInfos = [];
        try {
            galleryImageInfos = galleryImageInfosRaw ? JSON.parse(galleryImageInfosRaw) : [];
        } catch (e) {
            galleryImageInfos = [];
        }

        const galleryImages = galleryUrls.map((url, i) => ({
            url,
            title: galleryImageInfos[i]?.title || "",
            description: galleryImageInfos[i]?.description || "",
            alt: galleryImageInfos[i]?.alt || "",
            caption: galleryImageInfos[i]?.caption || "",
        }));

        console.log(`Adding product: ${name} (SKU: ${sku})`);
        const product = await productModal.create({
            name, sku, category,
            regularPrice: regularPrice ? Number(regularPrice) : undefined,
            price: Number(price),
            stock: Number(stock),
            shortDescription, tags, color,
            mainImage: mainImageUrl, galleryImages, videoFile: videoFileUrl, videoUrl,
            material, sareeSize, blouseSize, washCare, dispatch,
            disclaimer, internationalNote,
            isFestive: productCollection === "festive",
            isOnSale: (isOnSale === "true" || isOnSale === true) || productCollection === "big-sale",
            isNewArrival: isNewArrival === "true" || isNewArrival === true,
            productCollection: productCollection || "none",
        });

        console.log(`Product added successfully to DB: ${product._id}`);

        res.status(201).json({
            success: true,
            message: "Product added successfully",
            product,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error: " + (error.message || error),
        });
    }
};

const getAllProducts = async (req, res) => {
    try {
        const { search, q, category } = req.query;
        const searchQuery = search || q;

        const filter = {};
        const projection = {};
        let sort = { createdAt: -1 };

        if (searchQuery) {
            filter.$text = { $search: searchQuery };
            projection.score = { $meta: "textScore" };
            sort = { score: { $meta: "textScore" } };
        }

        if (category) {
            filter.category = category;
        }

        const products = await productModal
            .find(filter, projection)
            .sort(sort);

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

        // ── Cleanup Cloudinary assets ──
        const imageUrls = [
            product.mainImage,
            ...(product.galleryImages || []).map((img) => img.url),
        ].filter(Boolean);
        deleteMultipleFromCloudinary(imageUrls, "image").catch(() => { });
        if (product.videoFile) {
            deleteFromCloudinary(product.videoFile, "video").catch(() => { });
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

        // Fetch products before deleting to get Cloudinary URLs
        const productsToDelete = await productModal.find({ _id: { $in: ids } });

        const result = await productModal.deleteMany({ _id: { $in: ids } });

        // ── Cleanup Cloudinary assets in background ──
        for (const product of productsToDelete) {
            const imageUrls = [
                product.mainImage,
                ...(product.galleryImages || []).map((img) => img.url),
            ].filter(Boolean);
            deleteMultipleFromCloudinary(imageUrls, "image").catch(() => { });
            if (product.videoFile) {
                deleteFromCloudinary(product.videoFile, "video").catch(() => { });
            }
        }

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
            isOnSale, isNewArrival, productCollection,
            removeVideo,
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
            if (value !== undefined) {
                if (value === "") {
                    updateData[key] = numberFields.includes(key) ? null : "";
                } else {
                    updateData[key] = numberFields.includes(key) ? Number(value) : value;
                }
            }
        });

        // Handle boolean flags explicitly
        if (isNewArrival !== undefined) {
            updateData.isNewArrival = isNewArrival === "true" || isNewArrival === true;
        }

        // Handle isOnSale — respect explicit value first
        let explicitIsOnSale = undefined;
        if (isOnSale !== undefined) {
            explicitIsOnSale = isOnSale === "true" || isOnSale === true;
            updateData.isOnSale = explicitIsOnSale;
        }

        // Handle productCollection
        if (productCollection !== undefined) {
            updateData.productCollection = productCollection;
            updateData.isFestive = productCollection === "festive";
            // Only auto-set isOnSale from collection if it wasn't explicitly provided
            if (explicitIsOnSale === undefined) {
                if (productCollection === "big-sale") updateData.isOnSale = true;
            }
        }

        // ── Upload new files to Cloudinary IN PARALLEL ──
        const uploadPromises = [];
        let mainImagePromiseIdx = -1;
        let galleryPromiseIdx = -1;
        let videoPromiseIdx = -1;

        if (files?.mainImage?.[0]) {
            mainImagePromiseIdx = uploadPromises.length;
            uploadPromises.push(uploadImage(files.mainImage[0].buffer, files.mainImage[0].originalname));
        }
        if (files?.galleryImages?.length > 0) {
            galleryPromiseIdx = uploadPromises.length;
            uploadPromises.push(uploadImages(files.galleryImages));
        }
        if (files?.videoFile?.[0]) {
            videoPromiseIdx = uploadPromises.length;
            uploadPromises.push(uploadVideo(files.videoFile[0].buffer));
        }

        const uploadResults = await Promise.all(uploadPromises);

        if (mainImagePromiseIdx !== -1) {
            updateData.mainImage = uploadResults[mainImagePromiseIdx];
        }
        if (videoPromiseIdx !== -1) {
            updateData.videoFile = uploadResults[videoPromiseIdx];
        } else if (removeVideo === "true" || removeVideo === true) {
            updateData.videoFile = "";
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

        const newGalleryUrls = galleryPromiseIdx !== -1 ? uploadResults[galleryPromiseIdx] : [];
        const newGalleryImages = newGalleryUrls.map((url, i) => ({
            url,
            title: newGalleryInfos[i]?.title || "",
            description: newGalleryInfos[i]?.description || "",
            alt: newGalleryInfos[i]?.alt || "",
            caption: newGalleryInfos[i]?.caption || "",
        }));

        // Combine: existing images (with updated metadata) + newly uploaded
        if (existingGalleryImagesRaw !== undefined || newGalleryImages.length > 0) {
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

const uploadProductVideo = async (req, res) => {
    try {
        const { id } = req.params;
        const file = req.file;
        if (!file) {
            return res.status(400).json({
                success: false,
                message: "Video file is required",
            });
        }

        const videoUrl = await uploadVideo(file.buffer);

        const product = await productModal.findByIdAndUpdate(id, { videoFile: videoUrl }, { new: true });
        if (!product) {
            return res.status(404).json({
                success: false,
                message: "Product not found",
            });
        }
        res.status(200).json({
            success: true,
            message: "Video uploaded successfully",
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

// Whitelist of allowed fields for quick update to prevent mass assignment
const QUICK_UPDATE_ALLOWED_FIELDS = [
    "name", "sku", "category", "regularPrice", "price", "stock",
    "shortDescription", "tags", "color", "material", "sareeSize",
    "blouseSize", "washCare", "dispatch", "disclaimer", "internationalNote",
    "videoUrl", "isOnSale", "isNewArrival", "isFestive", "productCollection",
];

const quickUpdateProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const rawUpdates = req.body;

        // Filter to only allowed fields
        const updates = {};
        for (const key of QUICK_UPDATE_ALLOWED_FIELDS) {
            if (rawUpdates[key] !== undefined) {
                updates[key] = rawUpdates[key];
            }
        }

        const product = await productModal.findByIdAndUpdate(id, updates, { new: true });
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

export default { addProduct, getAllProducts, getProductById, deleteProduct, deleteMultipleProducts, updateProduct, updateGalleryImageInfo, uploadProductVideo, quickUpdateProduct };
