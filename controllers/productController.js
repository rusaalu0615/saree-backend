import productModal from "../models/productModal.js";
import {
    uploadImage,
    uploadImages,
    uploadVideo,
    deleteFromR2,
    deleteMultipleFromR2,
} from "../utils/r2Upload.js";
import { escapeRegex } from "../utils/security.js";

// Filter values arrive from PUBLIC query/path params. escapeRegex (shared util)
// neutralizes any injected metacharacters / ReDoS pattern; the only construct
// we still inject ourselves is the dash-tolerant class built by dashPattern().
// Build the dash-tolerant anchored body from one user token, safely.
const dashPattern = (val) => escapeRegex(val.trim()).replace(/-/g, "[\\s\\-]*");
// Bound the number of comma-separated filter tokens so a request can't force
// the DB to evaluate an unbounded regex list.
const MAX_FILTER_TOKENS = 30;

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

        // ── Validate BEFORE uploading to R2 ──
        if (
            !name || !sku || !category || price === undefined || regularPrice === undefined || stock === undefined ||
            !shortDescription || !tags || !color || !material || !sareeSize ||
            !blouseSize || !washCare || !files?.mainImage?.[0]
        ) {
            return res.status(400).json({
                success: false,
                message: "All fields except Video and permanent notes are required.",
            });
        }

        const numPrice = Number(price);
        if (!Number.isFinite(numPrice) || numPrice < 0) {
            return res.status(400).json({
                success: false,
                message: "Price must be a finite, non-negative number",
            });
        }

        const numRegularPrice = Number(regularPrice);
        if (!Number.isFinite(numRegularPrice) || numRegularPrice < 0) {
            return res.status(400).json({
                success: false,
                message: "Regular price must be a finite, non-negative number",
            });
        }

        const numStock = Number(stock);
        if (!Number.isInteger(numStock) || numStock < 0) {
            return res.status(400).json({
                success: false,
                message: "Stock must be a non-negative whole integer",
            });
        }

        // ── Upload all files to R2 IN PARALLEL ──
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
        if (error.code === 11000 && error.keyPattern && error.keyPattern.sku) {
            return res.status(400).json({
                success: false,
                message: "A product with this SKU already exists. Please use a unique SKU.",
            });
        }
        res.status(500).json({
            success: false,
            message: "Internal server error: " + (error.message || error),
        });
    }
};

const getAllProducts = async (req, res) => {
    try {
        const { 
            search, q, category, color, material, 
            priceMin, priceMax, isOnSale, isFestive, isNewArrival,
            productCollection, collection,
            sortBy, page, limit, fullData 
        } = req.query;

        const searchQuery = search || q;
        const andConditions = [];
        
        // 1. Text Search
        if (searchQuery) {
            andConditions.push({ $text: { $search: searchQuery } });
        }

        // 2. Exact Match Filters (OR within the same attribute group, AND across independent groups)
        if (category) {
            const regexList = category
                .split(',')
                .slice(0, MAX_FILTER_TOKENS)
                .map(c => new RegExp(`^${dashPattern(c)}$`, "i"));
            andConditions.push({ category: { $in: regexList } });
        }
        if (color) {
            const colorList = color
                .split(',')
                .slice(0, MAX_FILTER_TOKENS)
                .map(c => new RegExp(`^${dashPattern(c)}$`, "i"));
            andConditions.push({ color: { $in: colorList } });
        }
        if (material) {
            const materialList = material
                .split(',')
                .slice(0, MAX_FILTER_TOKENS)
                .map(c => new RegExp(`^${dashPattern(c)}$`, "i"));
            andConditions.push({ material: { $in: materialList } });
        }

        const targetCollection = productCollection || collection;
        if (targetCollection) {
            if (targetCollection === "festive") {
                andConditions.push({ $or: [{ isFestive: true }, { productCollection: "festive" }] });
            } else if (targetCollection === "big-sale" || targetCollection === "sale") {
                andConditions.push({ $or: [{ isOnSale: true }, { productCollection: "big-sale" }, { productCollection: "sale" }] });
            } else {
                andConditions.push({ productCollection: targetCollection });
            }
        }

        if (isOnSale !== undefined) {
            if (isOnSale === "true" || isOnSale === true) {
                andConditions.push({ $or: [{ isOnSale: true }, { productCollection: "big-sale" }, { productCollection: "sale" }] });
            } else {
                andConditions.push({ isOnSale: false });
            }
        }

        if (isFestive !== undefined) {
            if (isFestive === "true" || isFestive === true) {
                andConditions.push({ $or: [{ isFestive: true }, { productCollection: "festive" }] });
            } else {
                andConditions.push({ isFestive: false });
            }
        }

        if (isNewArrival !== undefined) {
            andConditions.push({ isNewArrival: isNewArrival === "true" || isNewArrival === true });
        }

        // 3. Price Range Filter
        if (priceMin || priceMax) {
            const priceFilter = {};
            if (priceMin) priceFilter.$gte = Number(priceMin);
            if (priceMax) priceFilter.$lte = Number(priceMax);
            andConditions.push({ price: priceFilter });
        }

        const filter = andConditions.length > 0 ? { $and: andConditions } : {};

        // 4. Projection (Exclude heavy fields for lists unless fullData is true)
        const projection = searchQuery ? { score: { $meta: "textScore" } } : {};
        if (fullData !== "true") {
            // Include only what's needed for ProductCards
            Object.assign(projection, {
                shortDescription: 0,
                details: 0,
                sareeSize: 0,
                blouseSize: 0,
                washCare: 0,
                dispatch: 0,
                disclaimer: 0,
                internationalNote: 0,
            });
        }

        // 5. Sorting
        let sort = {};
        if (searchQuery && !sortBy) {
            sort = { score: { $meta: "textScore" } };
        } else {
            switch (sortBy) {
                case 'price-low':
                    sort.price = 1; break;
                case 'price-high':
                    sort.price = -1; break;
                case 'newest':
                    sort.createdAt = -1; break;
                case 'name-asc':
                    sort.name = 1; break;
                case 'name-desc':
                    sort.name = -1; break;
                default:
                    sort.createdAt = -1; // Default sort
            }
        }

        // 6. Bounded Pagination: validated default 20, max 100
        const pageNum = Math.max(1, parseInt(page) || 1);
        let limitNum;
        if (limit === undefined || limit === null || limit === "") {
            limitNum = 20; // default page size
        } else {
            const parsed = parseInt(limit);
            if (isNaN(parsed) || parsed <= 0) {
                limitNum = 20;
            } else {
                limitNum = Math.min(parsed, 100); // capped at maximum 100
            }
        }
        const skipNum = (pageNum - 1) * limitNum;

        const query = productModal.find(filter, projection).sort(sort).lean().skip(skipNum).limit(limitNum);

        const [products, totalProducts] = await Promise.all([
            query,
            productModal.countDocuments(filter)
        ]);

        res.status(200).json({
            success: true,
            products,
            pagination: {
                currentPage: pageNum,
                totalPages: Math.max(1, Math.ceil(totalProducts / limitNum)),
                totalProducts,
                limit: limitNum
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error: " + (error.message || error),
        });
    }
};

const getProductById = async (req, res) => {
    try {
        const { id } = req.params;
        const product = await productModal.findById(id).lean();
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

const getProductBySku = async (req, res) => {
    try {
        const sku = decodeURIComponent(req.params.sku);
        // Escape the SKU so a path param can't inject a regex / ReDoS pattern.
        const product = await productModal.findOne({ sku: { $regex: new RegExp(`^${escapeRegex(sku)}$`, 'i') } }).lean();
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

        // ── Cleanup R2 assets ──
        const imageUrls = [
            product.mainImage,
            ...(product.galleryImages || []).map((img) => img.url),
        ].filter(Boolean);
        deleteMultipleFromR2(imageUrls).catch(() => { });
        if (product.videoFile) {
            deleteFromR2(product.videoFile).catch(() => { });
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

        // ── Cleanup R2 assets in background ──
        for (const product of productsToDelete) {
            const imageUrls = [
                product.mainImage,
                ...(product.galleryImages || []).map((img) => img.url),
            ].filter(Boolean);
            deleteMultipleFromR2(imageUrls).catch(() => { });
            if (product.videoFile) {
                deleteFromR2(product.videoFile).catch(() => { });
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

        // Validate price/stock if included in updateData
        if (updateData.price !== undefined) {
            const p = Number(updateData.price);
            if (!Number.isFinite(p) || p < 0) {
                return res.status(400).json({
                    success: false,
                    message: "Price must be a finite, non-negative number",
                });
            }
            updateData.price = p;
        }

        if (updateData.regularPrice !== undefined && updateData.regularPrice !== null) {
            const rp = Number(updateData.regularPrice);
            if (!Number.isFinite(rp) || rp < 0) {
                return res.status(400).json({
                    success: false,
                    message: "Regular price must be a finite, non-negative number",
                });
            }
            updateData.regularPrice = rp;
        }

        if (updateData.stock !== undefined) {
            const s = Number(updateData.stock);
            if (!Number.isInteger(s) || s < 0) {
                return res.status(400).json({
                    success: false,
                    message: "Stock must be a non-negative whole integer",
                });
            }
            updateData.stock = s;
        }

        // Concurrency guard: if expectedStock is provided, assert stock hasn't changed
        const updateFilter = { _id: id };
        if (req.body.expectedStock !== undefined) {
            updateFilter.stock = Number(req.body.expectedStock);
        }

        const product = await productModal.findOneAndUpdate(updateFilter, updateData, {
            runValidators: true,
            returnDocument: "after",
        });

        if (!product) {
            const exists = await productModal.exists({ _id: id });
            if (!exists) {
                return res.status(404).json({
                    success: false,
                    message: "Product not found",
                });
            }
            return res.status(409).json({
                success: false,
                message: "Stock has changed concurrently (likely due to checkout reservations). Please refresh and review current stock.",
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

        if (updates.price !== undefined) {
            const p = Number(updates.price);
            if (!Number.isFinite(p) || p < 0) {
                return res.status(400).json({
                    success: false,
                    message: "Price must be a finite, non-negative number",
                });
            }
            updates.price = p;
        }

        if (updates.regularPrice !== undefined && updates.regularPrice !== null) {
            const rp = Number(updates.regularPrice);
            if (!Number.isFinite(rp) || rp < 0) {
                return res.status(400).json({
                    success: false,
                    message: "Regular price must be a finite, non-negative number",
                });
            }
            updates.regularPrice = rp;
        }

        if (updates.stock !== undefined) {
            const s = Number(updates.stock);
            if (!Number.isInteger(s) || s < 0) {
                return res.status(400).json({
                    success: false,
                    message: "Stock must be a non-negative whole integer",
                });
            }
            updates.stock = s;
        }

        // Concurrency guard: if expectedStock is provided, assert stock hasn't changed
        const quickFilter = { _id: id };
        if (rawUpdates.expectedStock !== undefined) {
            quickFilter.stock = Number(rawUpdates.expectedStock);
        }

        const product = await productModal.findOneAndUpdate(quickFilter, updates, {
            runValidators: true,
            returnDocument: "after",
        });

        if (!product) {
            const exists = await productModal.exists({ _id: id });
            if (!exists) {
                return res.status(404).json({
                    success: false,
                    message: "Product not found",
                });
            }
            return res.status(409).json({
                success: false,
                message: "Stock has changed concurrently (likely due to checkout reservations). Please refresh and review current stock.",
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

const getFilters = async (req, res) => {
    try {
        const colors = await productModal.distinct("color");
        const materials = await productModal.distinct("material");
        res.status(200).json({
            success: true,
            colors: colors.filter(Boolean),
            materials: materials.filter(Boolean)
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export default { addProduct, getAllProducts, getProductById, getProductBySku, deleteProduct, deleteMultipleProducts, updateProduct, updateGalleryImageInfo, uploadProductVideo, quickUpdateProduct, getFilters };
