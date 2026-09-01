import "dotenv/config";
import mongoose from "mongoose";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET_NAME, R2_PUBLIC_URL } from "../config/r2.js";
import sharp from "sharp";
import crypto from "crypto";
import path from "path";

// URL Cache to avoid re-uploading duplicate media referenced across multiple documents
const migratedUrlCache = new Map();

/**
 * Detect if a URL belongs to Cloudinary
 */
function isCloudinaryUrl(url) {
    if (!url || typeof url !== "string") return false;
    return url.includes("res.cloudinary.com") || url.includes("cloudinary.com");
}

/**
 * Extract clean filename and type (image or video) from Cloudinary URL
 */
function parseMediaInfo(url) {
    try {
        const isVideo = url.includes("/video/upload/") || /\.(mp4|webm|mov|mkv|avi)$/i.test(url);
        const folder = isVideo ? "videos" : "images";

        // Extract filename part after /upload/
        let filename = "media";
        if (url.includes("/upload/")) {
            const afterUpload = url.split("/upload/")[1];
            // Strip transformation parameters or version tag (e.g. v1772947314/)
            const cleanPath = afterUpload.replace(/^.*\/v\d+\//, "").replace(/^v\d+\//, "");
            filename = path.basename(cleanPath);
        } else {
            const urlObj = new URL(url);
            filename = path.basename(urlObj.pathname);
        }

        const ext = path.extname(filename) || (isVideo ? ".mp4" : ".jpg");
        const baseName = path.basename(filename, ext).replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 40);

        return {
            folder,
            baseName,
            ext,
            isVideo,
        };
    } catch {
        return {
            folder: "images",
            baseName: "asset",
            ext: ".jpg",
            isVideo: false,
        };
    }
}

/**
 * Download a file from URL to buffer with retries
 */
async function downloadAsset(url, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MediaMigration/1.0",
                },
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const contentType = response.headers.get("content-type");
            return {
                buffer: Buffer.from(arrayBuffer),
                contentType: contentType || "",
            };
        } catch (err) {
            if (attempt === retries) throw err;
            console.warn(`[Retry ${attempt}/${retries}] Failed downloading ${url}: ${err.message}`);
            await new Promise((res) => setTimeout(res, 1500 * attempt));
        }
    }
}

/**
 * Upload an asset buffer to Cloudflare R2
 */
async function uploadToR2(buffer, key, contentType) {
    const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
    });

    await r2Client.send(command);

    if (R2_PUBLIC_URL) {
        return `${R2_PUBLIC_URL}/${key}`;
    }
    return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${key}`;
}

/**
 * Migrate a single media URL to R2
 */
async function migrateUrlToR2(cloudinaryUrl) {
    if (!isCloudinaryUrl(cloudinaryUrl)) {
        return cloudinaryUrl;
    }

    // Check in-memory cache
    if (migratedUrlCache.has(cloudinaryUrl)) {
        return migratedUrlCache.get(cloudinaryUrl);
    }

    console.log(`\n  [MIGRATING] -> ${cloudinaryUrl}`);

    try {
        const mediaInfo = parseMediaInfo(cloudinaryUrl);
        const { buffer, contentType: rawContentType } = await downloadAsset(cloudinaryUrl);

        let finalBuffer = buffer;
        let finalContentType = rawContentType;
        let finalExt = mediaInfo.ext;

        if (!mediaInfo.isVideo) {
            try {
                // Optimize images with sharp into modern WebP
                finalBuffer = await sharp(buffer)
                    .resize({ width: 1920, withoutEnlargement: true })
                    .webp({ quality: 85 })
                    .toBuffer();
                finalContentType = "image/webp";
                finalExt = ".webp";
            } catch (sharpError) {
                console.warn(`    [Sharp Fallback] Could not process with sharp: ${sharpError.message}. Uploading original.`);
                finalContentType = rawContentType || (mediaInfo.ext === ".png" ? "image/png" : "image/jpeg");
            }
        } else {
            finalContentType = rawContentType || "video/mp4";
            finalExt = mediaInfo.ext || ".mp4";
        }

        // Generate a unique destination key
        const uniqueId = crypto.randomBytes(6).toString("hex");
        const key = `${mediaInfo.folder}/${mediaInfo.baseName}-${uniqueId}${finalExt}`;

        console.log(`    Uploading to R2 key: ${key} (${(finalBuffer.length / 1024).toFixed(1)} KB)...`);
        const r2Url = await uploadToR2(finalBuffer, key, finalContentType);
        
        console.log(`    [SUCCESS] => ${r2Url}`);

        migratedUrlCache.set(cloudinaryUrl, r2Url);
        return r2Url;
    } catch (error) {
        console.error(`    [ERROR] Failed to migrate asset ${cloudinaryUrl}:`, error.message);
        return cloudinaryUrl; // Return original url so DB remains intact on failures
    }
}

/**
 * Recursively scan any JS object/array and replace Cloudinary URLs
 */
async function processDocument(node) {
    let modified = false;

    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            if (typeof node[i] === "string" && isCloudinaryUrl(node[i])) {
                const newUrl = await migrateUrlToR2(node[i]);
                if (newUrl !== node[i]) {
                    node[i] = newUrl;
                    modified = true;
                }
            } else if (typeof node[i] === "object" && node[i] !== null) {
                const childModified = await processDocument(node[i]);
                if (childModified) modified = true;
            }
        }
    } else if (typeof node === "object" && node !== null) {
        for (const key of Object.keys(node)) {
            if (key === "_id" || key === "__v") continue;

            if (typeof node[key] === "string" && isCloudinaryUrl(node[key])) {
                const newUrl = await migrateUrlToR2(node[key]);
                if (newUrl !== node[key]) {
                    node[key] = newUrl;
                    modified = true;
                }
            } else if (typeof node[key] === "object" && node[key] !== null) {
                const childModified = await processDocument(node[key]);
                if (childModified) modified = true;
            }
        }
    }

    return modified;
}

/**
 * Main migration runner
 */
async function runMigration() {
    const mongoUri = process.env.CUSTOM_MONGO_URI || process.env.MONGO_URI;

    if (!mongoUri) {
        console.error("[FATAL] MONGO_URI is missing in .env");
        process.exit(1);
    }

    if (!R2_BUCKET_NAME || !process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
        console.error("[FATAL] Cloudflare R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME) are missing in .env");
        process.exit(1);
    }

    console.log("==================================================================");
    console.log("       STARTING CLOUDINARY TO CLOUDFLARE R2 MEDIA MIGRATION       ");
    console.log("==================================================================");
    console.log(`R2 Bucket:     ${R2_BUCKET_NAME}`);
    console.log(`R2 Public URL: ${R2_PUBLIC_URL || "(Direct R2 Endpoint)"}`);
    console.log("Connecting to MongoDB...");

    try {
        await mongoose.connect(mongoUri);
        console.log("Connected to MongoDB successfully.\n");

        const models = [
            { name: "Product", model: (await import("../models/productModal.js")).default },
            { name: "Category", model: (await import("../models/categoriesModal.js")).default },
            { name: "Hero Banner", model: (await import("../models/heroModal.js")).default },
            { name: "Category Banner", model: (await import("../models/categoryBannerModal.js")).default },
            { name: "Celebrity Banner", model: (await import("../models/celebrityBannerModal.js")).default },
            { name: "Festive Banner", model: (await import("../models/festiveBannerModal.js")).default },
            { name: "Festive Sale", model: (await import("../models/festiveSaleModal.js")).default },
            { name: "Marketing Collection", model: (await import("../models/marketingCollectionModal.js")).default },
            { name: "Blog", model: (await import("../models/blogModal.js")).default },
            { name: "Review", model: (await import("../models/reviewModal.js")).default },
            { name: "Order", model: (await import("../models/orderModal.js")).default },
            { name: "User", model: (await import("../models/userModal.js")).default },
        ];

        let totalDocsModified = 0;

        for (const item of models) {
            if (!item.model) continue;
            console.log(`------------------------------------------------------------------`);
            console.log(`Checking Collection: [${item.name}] (${item.model.collection.name})`);

            const docs = await item.model.find({}).lean();
            console.log(`Found ${docs.length} document(s).`);

            let collectionModifiedCount = 0;

            for (const doc of docs) {
                const isModified = await processDocument(doc);
                if (isModified) {
                    await item.model.updateOne({ _id: doc._id }, { $set: doc });
                    collectionModifiedCount++;
                }
            }

            console.log(`Finished ${item.name}: Updated ${collectionModifiedCount} document(s).`);
            totalDocsModified += collectionModifiedCount;
        }

        console.log(`\n==================================================================`);
        console.log(`MIGRATION SUMMARY:`);
        console.log(`  - Unique Media Files Migrated: ${migratedUrlCache.size}`);
        console.log(`  - Database Documents Updated:  ${totalDocsModified}`);
        console.log(`==================================================================`);
    } catch (error) {
        console.error("Migration fatal error:", error);
    } finally {
        await mongoose.connection.close();
        console.log("MongoDB connection closed.");
        process.exit(0);
    }
}

runMigration();
