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
            isOnSale, isNewArrival, isFeatured, isBestSeller, productCollection,
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
            isFeatured: isFeatured === "true" || isFeatured === true,
            isBestSeller: isBestSeller === "true" || isBestSeller === true,
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
    if (typeof res.setHeader === "function") {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
    try {
        const { 
            search, q, category, color, material, 
            priceMin, priceMax, isOnSale, isFestive, isNewArrival,
            isFeatured, isBestSeller, hasVideo,
            productCollection, collection,
            sortBy, page, limit, fullData 
        } = req.query;

        const searchQuery = search || q;
        const andConditions = [];
        let isTextSearch = false;
        
        // 1. Text Search (Exact SKU Match Priority)
        if (searchQuery) {
            const trimmedQuery = searchQuery.trim();
            const skuExists = await productModal.exists({ sku: new RegExp(`^${escapeRegex(trimmedQuery)}$`, "i") });
            if (skuExists) {
                andConditions.push({ sku: new RegExp(`^${escapeRegex(trimmedQuery)}$`, "i") });
            } else {
                andConditions.push({ $text: { $search: searchQuery } });
                isTextSearch = true;
            }
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
            } else if (targetCollection === "new-arrivals") {
                andConditions.push({ $or: [{ isNewArrival: true }, { productCollection: "new-arrivals" }] });
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

        if (isFeatured !== undefined) {
            andConditions.push({ isFeatured: isFeatured === "true" || isFeatured === true });
        }

        if (isBestSeller !== undefined) {
            andConditions.push({ isBestSeller: isBestSeller === "true" || isBestSeller === true });
        }

        if (hasVideo !== undefined) {
            if (hasVideo === "true" || hasVideo === true) {
                andConditions.push({
                    $or: [
                        { videoUrl: { $exists: true, $ne: "", $nin: [null, ""] } },
                        { videoFile: { $exists: true, $ne: "", $nin: [null, ""] } }
                    ]
                });
            } else {
                andConditions.push({
                    $and: [
                        { $or: [{ videoUrl: { $exists: false } }, { videoUrl: "" }, { videoUrl: null }] },
                        { $or: [{ videoFile: { $exists: false } }, { videoFile: "" }, { videoFile: null }] }
                    ]
                });
            }
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
        const projection = isTextSearch ? { score: { $meta: "textScore" } } : {};
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
        if (isTextSearch && !sortBy) {
            sort = { score: { $meta: "textScore" } };
        } else {
            switch (sortBy) {
                case 'featured':
                    sort = { isFeatured: -1, isNewArrival: -1, createdAt: -1 };
                    break;
                case 'color-asc':
                    sort.color = 1;
                    sort.createdAt = -1;
                    break;
                case 'color-desc':
                    sort.color = -1;
                    sort.createdAt = -1;
                    break;
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

        // 6. Bounded Pagination: validated default 20, max 1000. limit=0 or "all" returns all without limit.
        const pageNum = Math.max(1, parseInt(page) || 1);
        let limitNum;
        let isUnlimited = false;

        if (limit === "0" || limit === 0 || limit === "all") {
            isUnlimited = true;
        } else if (limit === undefined || limit === null || limit === "") {
            limitNum = 20; // default page size
        } else {
            const parsed = parseInt(limit);
            if (isNaN(parsed) || parsed < 0) {
                limitNum = 20;
            } else if (parsed === 0) {
                isUnlimited = true;
            } else {
                limitNum = Math.min(parsed, 100); // capped at maximum 100
            }
        }

        let query = productModal.find(filter, projection).sort(sort).lean();
        if (!isUnlimited) {
            const skipNum = (pageNum - 1) * limitNum;
            query = query.skip(skipNum).limit(limitNum);
        }

        const [products, totalProducts] = await Promise.all([
            query,
            productModal.countDocuments(filter)
        ]);

        res.status(200).json({
            success: true,
            products,
            pagination: {
                currentPage: isUnlimited ? 1 : pageNum,
                totalPages: isUnlimited ? 1 : Math.max(1, Math.ceil(totalProducts / limitNum)),
                totalProducts,
                limit: isUnlimited ? totalProducts : limitNum
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
    if (typeof res.setHeader === "function") {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
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
    if (typeof res.setHeader === "function") {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
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
            isOnSale, isNewArrival, isFeatured, isBestSeller, productCollection,
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
        if (isFeatured !== undefined) {
            updateData.isFeatured = isFeatured === "true" || isFeatured === true;
        }
        if (isBestSeller !== undefined) {
            updateData.isBestSeller = isBestSeller === "true" || isBestSeller === true;
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

        // Synchronize collection and boolean flags
        if (updateData.productCollection !== undefined) {
            if (updateData.isFestive === undefined) {
                updateData.isFestive = updateData.productCollection === "festive";
            }
            if (updateData.isOnSale === undefined && (updateData.productCollection === "big-sale" || updateData.productCollection === "sale")) {
                updateData.isOnSale = true;
            }
        }
        if (updateData.isFestive === true && !updateData.productCollection) {
            updateData.productCollection = "festive";
        }
        if (updateData.isFestive === false && updateData.productCollection === "festive") {
            updateData.productCollection = "";
        }
        if (updateData.isOnSale === true && !updateData.productCollection) {
            updateData.productCollection = "big-sale";
        }
        if (updateData.isOnSale === false && (updateData.productCollection === "big-sale" || updateData.productCollection === "sale")) {
            updateData.productCollection = "";
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

        const product = await productModal.findByIdAndUpdate(id, { videoFile: videoUrl }, { returnDocument: 'after' });
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
    "videoUrl", "isOnSale", "isNewArrival", "isFestive", "isFeatured", "isBestSeller", "productCollection",
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

        if (updates.isFeatured !== undefined) {
            updates.isFeatured = updates.isFeatured === "true" || updates.isFeatured === true;
        }

        if (updates.isBestSeller !== undefined) {
            updates.isBestSeller = updates.isBestSeller === "true" || updates.isBestSeller === true;
        }

        // Synchronize collection and boolean flags
        if (updates.productCollection !== undefined) {
            if (updates.isFestive === undefined) {
                updates.isFestive = updates.productCollection === "festive";
            }
            if (updates.isOnSale === undefined && (updates.productCollection === "big-sale" || updates.productCollection === "sale")) {
                updates.isOnSale = true;
            }
        }
        if (updates.isFestive === true && !updates.productCollection) {
            updates.productCollection = "festive";
        }
        if (updates.isFestive === false && updates.productCollection === "festive") {
            updates.productCollection = "";
        }
        if (updates.isOnSale === true && !updates.productCollection) {
            updates.productCollection = "big-sale";
        }
        if (updates.isOnSale === false && (updates.productCollection === "big-sale" || updates.productCollection === "sale")) {
            updates.productCollection = "";
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

const getProductBySlug = async (req, res) => {
    if (typeof res.setHeader === "function") {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
    try {
        const rawSlug = decodeURIComponent(req.params.slug || "").trim();
        let product = null;

        // 1. Direct SKU match (e.g. if slug is the SKU)
        product = await productModal.findOne({ sku: new RegExp(`^${escapeRegex(rawSlug)}$`, 'i') }).lean();

        // 2. Try candidate SKU suffixes if slug contains hyphens
        if (!product && rawSlug.includes('-')) {
            const parts = rawSlug.split('-');
            for (let segs = 1; segs < parts.length && segs <= 6; segs++) {
                const candidateSku = parts.slice(parts.length - segs).join('-');
                product = await productModal.findOne({ sku: new RegExp(`^${escapeRegex(candidateSku)}$`, 'i') }).lean();
                if (product) break;
            }
        }

        // 3. Fallback: match by name dash pattern (legacy URLs)
        if (!product) {
            const pattern = dashPattern(rawSlug);
            product = await productModal.findOne({ name: new RegExp(`^${pattern}$`, 'i') }).lean();
        }

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
        console.error("getProductBySlug error:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error: " + (error.message || error),
        });
    }
};

const getFilters = async (req, res) => {
    try {
        const colors = await productModal.distinct("color");
        const materials = await productModal.distinct("material");
        const { category, search, q, productCollection, collection, isOnSale, isFestive, isNewArrival, isFeatured, isBestSeller } = req.query;
        const andConditions = [];
        const searchQuery = search || q;
        if (searchQuery) {
            const trimmed = searchQuery.trim();
            const skuExists = await productModal.exists({ sku: new RegExp(`^${escapeRegex(trimmed)}$`, "i") });
            if (skuExists) {
                andConditions.push({ sku: new RegExp(`^${escapeRegex(trimmed)}$`, "i") });
            } else {
                andConditions.push({ $text: { $search: searchQuery } });
            }
        }
        if (category) {
            const regexList = category
                .split(',')
                .slice(0, MAX_FILTER_TOKENS)
                .map(c => new RegExp(`^${dashPattern(c)}$`, "i"));
            andConditions.push({ category: { $in: regexList } });
        }
        const targetCollection = productCollection || collection;
        if (targetCollection) {
            if (targetCollection === "festive") {
                andConditions.push({ $or: [{ isFestive: true }, { productCollection: "festive" }] });
            } else if (targetCollection === "big-sale" || targetCollection === "sale") {
                andConditions.push({ $or: [{ isOnSale: true }, { productCollection: "big-sale" }, { productCollection: "sale" }] });
            } else if (targetCollection === "new-arrivals") {
                andConditions.push({ $or: [{ isNewArrival: true }, { productCollection: "new-arrivals" }] });
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
        if (isFeatured !== undefined) {
            andConditions.push({ isFeatured: isFeatured === "true" || isFeatured === true });
        }
        if (isBestSeller !== undefined) {
            andConditions.push({ isBestSeller: isBestSeller === "true" || isBestSeller === true });
        }

        const matchStage = andConditions.length > 0 ? { $match: { $and: andConditions } } : { $match: {} };

        const facetResults = await productModal.aggregate([
            matchStage,
            {
                $facet: {
                    colors: [
                        { $match: { color: { $exists: true, $ne: null, $nin: ["", null] } } },
                        { $group: { _id: "$color", count: { $sum: 1 } } },
                        { $sort: { _id: 1 } }
                    ],
                    materials: [
                        { $match: { material: { $exists: true, $ne: null, $nin: ["", null] } } },
                        { $group: { _id: "$material", count: { $sum: 1 } } },
                        { $sort: { _id: 1 } }
                    ],
                    categories: [
                        { $match: { category: { $exists: true, $ne: null, $nin: ["", null] } } },
                        { $group: { _id: "$category", count: { $sum: 1 } } },
                        { $sort: { _id: 1 } }
                    ],
                    priceStats: [
                        { $group: { _id: null, min: { $min: "$price" }, max: { $max: "$price" }, count: { $sum: 1 } } }
                    ]
                }
            }
        ]);

        const facets = facetResults[0] || {};
        const colorCounts = {};
        const colorsList = [];
        (facets.colors || []).forEach(c => {
            if (c._id) {
                colorCounts[c._id] = c.count;
                colorsList.push(c._id);
            }
        });

        const materialCounts = {};
        const materialsList = [];
        (facets.materials || []).forEach(m => {
            if (m._id) {
                materialCounts[m._id] = m.count;
                materialsList.push(m._id);
            }
        });

        const categoryCounts = {};
        const categoriesList = [];
        (facets.categories || []).forEach(cat => {
            if (cat._id) {
                categoryCounts[cat._id] = cat.count;
                categoriesList.push(cat._id);
            }
        });

        const priceStat = facets.priceStats?.[0];
        const priceRange = {
            min: priceStat?.min ?? 0,
            max: priceStat?.max ?? 10000,
        };

        res.status(200).json({
            success: true,
            colors: colorsList,
            materials: materialsList,
            categories: categoriesList,
            counts: {
                colors: colorCounts,
                fabrics: materialCounts,
                categories: categoryCounts,
            },
            priceRange,
        });
    } catch (error) {
        console.error("getFilters error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const getAdminMediaLibrary = async (req, res) => {
    if (typeof res.setHeader === "function") {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
    try {
        const pageNum = Math.max(1, parseInt(req.query.page) || 1);
        const limitNum = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
        const skipNum = (pageNum - 1) * limitNum;
        const search = (req.query.search || "").trim();

        const filter = {};
        if (search) {
            filter.$or = [
                { name: new RegExp(escapeRegex(search), "i") },
                { sku: new RegExp(escapeRegex(search), "i") },
            ];
        }

        const [products, totalProducts] = await Promise.all([
            productModal.find(
                filter,
                { _id: 1, name: 1, sku: 1, mainImage: 1, mainImageInfo: 1, galleryImages: 1 }
            )
                .sort({ createdAt: -1 })
                .skip(skipNum)
                .limit(limitNum)
                .lean(),
            productModal.countDocuments(filter),
        ]);

        res.status(200).json({
            success: true,
            products,
            pagination: {
                currentPage: pageNum,
                totalPages: Math.max(1, Math.ceil(totalProducts / limitNum)),
                totalProducts,
                limit: limitNum,
            },
        });
    } catch (error) {
        console.error("getAdminMediaLibrary error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Cursor-based discovery: small batches, staged ranking, lightweight cards.
// Stages broaden relevance: same collection/category → material/color/price
// → popular/new. Cursor encodes scored offset + exclude-count so batches
// never repeat or need hundreds of exclude IDs.
const getRecommendations = async (req, res) => {
    if (typeof res.setHeader === "function") {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
    try {
        const current = await productModal.findById(req.params.productId).lean();
        if (!current) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 8, 1), 12);
        let cursorOffset = 0;
        try {
            if (req.query.cursor) {
                const decoded = JSON.parse(Buffer.from(String(req.query.cursor), "base64url").toString("utf8"));
                if (decoded && typeof decoded.o === "number" && Number.isFinite(decoded.o) && decoded.o >= 0) {
                    cursorOffset = Math.min(Math.floor(decoded.o), 10000);
                }
            }
        } catch {}
        const coll = current.productCollection;
        const cat = current.category;
        const mat = current.material;
        const col = current.color;
        const price = Number(current.price) || 0;
        const collQ = coll ? { productCollection: coll } : null;
        const catQ = cat ? { category: cat } : null;
        const matQ = mat ? { material: mat } : null;
        const colorQ = col ? { color: col } : null;
        const priceQ = price > 0 ? { price: { $gte: Math.round(price * 0.8), $lte: Math.round(price * 1.25) } } : null;
        const stages = [
            collQ,
            catQ,
            matQ,
            colorQ,
            priceQ,
            { isNewArrival: true },
            { isOnSale: true },
            { _id: { $nin: [...seen] } }, // broad fallback (explicit object, survives filter)
        ];
        // Interleave staged candidates with variety (70% stage, 30% newest)
        // using a single pass of bounded indexed queries. Each query uses
        // compound indexes (category/material/collection + createdAt).
        const want = limit * 2 + 8;
        const seen = new Set([String(current._id)]);
        const picked = [];
        for (const q of stages) {
            if (picked.length >= want) break;
            const docs = await productModal.find({ ...q, _id: { $nin: [...seen] } })
                .sort({ createdAt: -1 })
                .limit(want)
                .select("_id name sku category productCollection material color price regularPrice stock mainImage galleryImages isNewArrival isOnSale averageRating numReviews")
                .lean();
            for (const d of docs) {
                const id = String(d._id);
                if (seen.has(id)) continue;
                seen.add(id);
                picked.push(d);
                if (picked.length >= want) break;
            }
        }
        // Variety: keep top section-order, blend native sort for rest.
        picked.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        const start = cursorOffset;
        const batch = picked.slice(start, start + limit);
        const hasMore = start + limit < picked.length;
        let nextCursor = null;
        if (hasMore) {
            nextCursor = Buffer.from(JSON.stringify({ o: start + limit }), "utf8").toString("base64url");
        }
        const cards = batch.map((d) => {
            const alt = Array.isArray(d.galleryImages) && d.galleryImages.length > 0 ? (d.galleryImages[0]?.url || d.galleryImages[0]) : null;
            return {
                _id: d._id,
                name: d.name,
                sku: d.sku,
                category: d.category,
                price: d.price,
                regularPrice: d.regularPrice,
                stock: d.stock,
                mainImage: d.mainImage,
                alternateImage: alt || null,
                averageRating: d.averageRating || 0,
                numReviews: d.numReviews || 0,
                isNewArrival: Boolean(d.isNewArrival),
                isOnSale: Boolean(d.isOnSale),
            };
        });
        res.status(200).json({ success: true, products: cards, nextCursor, hasMore });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Internal server error: " + (error.message || error) });
    }
};


const getProductCardsByIds = async (req, res) => {
    if (typeof res.setHeader === "function") res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 20).map(String) : [];
        if (!ids.length) return res.status(200).json({ success: true, products: [] });
        const docs = await productModal.find({ _id: { $in: ids } }).select("_id name sku category price regularPrice stock mainImage galleryImages isNewArrival isOnSale averageRating numReviews").lean();
        const byId = new Map(docs.map(d => [String(d._id), d]));
        const products = ids.map(id => byId.get(id)).filter(Boolean).map(d => ({
            _id: d._id, name: d.name, sku: d.sku, category: d.category,
            price: d.price, regularPrice: d.regularPrice, stock: d.stock,
            mainImage: d.mainImage, alternateImage: (d.galleryImages?.[0]?.url || d.galleryImages?.[0] || null),
            averageRating: d.averageRating || 0, numReviews: d.numReviews || 0,
            isNewArrival: Boolean(d.isNewArrival), isOnSale: Boolean(d.isOnSale),
        }));
        res.status(200).json({ success: true, products });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

export default { addProduct, getAllProducts, getProductById, getProductBySku, getProductBySlug, getAdminMediaLibrary, deleteProduct, deleteMultipleProducts, updateProduct, updateGalleryImageInfo, uploadProductVideo, quickUpdateProduct, getFilters, getRecommendations, getProductCardsByIds };
