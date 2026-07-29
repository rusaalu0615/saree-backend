import "dotenv/config";
import mongoose from "mongoose";
import cloudinary from "cloudinary";

// Configure Cloudinary with NEW credentials from .env
cloudinary.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const OLD_CLOUD_NAME = "dmtjm3e3c";
const TARGET_FOLDERS = ["images", "videos"];

// Helper function to extract public_id and folder from Cloudinary URL
function extractCloudinaryInfo(url) {
    if (!url || !url.includes(`res.cloudinary.com/${OLD_CLOUD_NAME}`)) return null;
    
    try {
        const parts = url.split("/upload/");
        if (parts.length < 2) return null;
        
        const afterUpload = parts[1];
        const withoutVersion = afterUpload.replace(/^v\d+\//, "");
        
        // Ensure it belongs to our target folders (images or videos)
        const inTargetFolder = TARGET_FOLDERS.some(f => withoutVersion.startsWith(`${f}/`));
        if (!inTargetFolder) return null;

        const publicId = withoutVersion.replace(/\.[^/.]+$/, "");
        
        return {
            publicId,
            resourceType: withoutVersion.startsWith("videos/") ? "video" : "image"
        };
    } catch (e) {
        return null;
    }
}

// Upload URL to new Cloudinary
async function migrateUrl(oldUrl) {
    const info = extractCloudinaryInfo(oldUrl);
    if (!info) return oldUrl; // Not a target URL, return original

    try {
        console.log(`Uploading ${info.publicId}...`);
        const result = await cloudinary.v2.uploader.upload(oldUrl, {
            public_id: info.publicId,
            resource_type: info.resourceType
        });
        console.log(`Success: -> ${result.secure_url}`);
        return result.secure_url;
    } catch (error) {
        console.error(`Failed to migrate ${oldUrl}:`, error.message);
        return oldUrl; // Return original on failure
    }
}

// Recursively process an object or array to find and replace Cloudinary URLs
async function processDocument(doc) {
    let modified = false;

    if (Array.isArray(doc)) {
        for (let i = 0; i < doc.length; i++) {
            if (typeof doc[i] === "string" && doc[i].includes(`res.cloudinary.com/${OLD_CLOUD_NAME}`)) {
                const newUrl = await migrateUrl(doc[i]);
                if (newUrl !== doc[i]) {
                    doc[i] = newUrl;
                    modified = true;
                }
            } else if (typeof doc[i] === "object" && doc[i] !== null) {
                const childModified = await processDocument(doc[i]);
                if (childModified) modified = true;
            }
        }
    } else if (typeof doc === "object" && doc !== null) {
        for (const key in doc) {
            // Skip mongoose specific fields or built-ins
            if (key === "_id" || key === "__v") continue;

            if (typeof doc[key] === "string" && doc[key].includes(`res.cloudinary.com/${OLD_CLOUD_NAME}`)) {
                const newUrl = await migrateUrl(doc[key]);
                if (newUrl !== doc[key]) {
                    doc[key] = newUrl;
                    modified = true;
                }
            } else if (typeof doc[key] === "object" && doc[key] !== null) {
                const childModified = await processDocument(doc[key]);
                if (childModified) modified = true;
            }
        }
    }
    return modified;
}

async function runMigration() {
    try {
        console.log("Connecting to MongoDB...");
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        // Dynamically load all models (since this is an ES module, we import them)
        const models = [
            (await import("../models/productModal.js")).default,
            (await import("../models/heroModal.js")).default,
            (await import("../models/categoriesModal.js")).default,
            (await import("../models/blogModal.js")).default,
            (await import("../models/marketingCollectionModal.js")).default,
            (await import("../models/festiveSaleModal.js")).default,
            (await import("../models/festiveBannerModal.js")).default,
            (await import("../models/celebrityBannerModal.js")).default,
            (await import("../models/categoryBannerModal.js")).default,
            (await import("../models/orderModal.js")).default,
            (await import("../models/reviewModal.js")).default,
            (await import("../models/userModal.js")).default,
        ];

        let totalModified = 0;

        for (const Model of models) {
            if (!Model) continue;
            console.log(`\n--- Checking collection: ${Model.collection.name} ---`);
            
            const documents = await Model.find({}).lean(); // Fetch as plain JS objects
            let collectionModified = 0;

            for (const doc of documents) {
                const isModified = await processDocument(doc);
                
                if (isModified) {
                    // Update document in the DB
                    await Model.updateOne({ _id: doc._id }, { $set: doc });
                    collectionModified++;
                }
            }
            console.log(`Modified ${collectionModified} documents in ${Model.collection.name}.`);
            totalModified += collectionModified;
        }

        console.log(`\nMigration completed! Total documents modified: ${totalModified}`);
    } catch (error) {
        console.error("Migration Error:", error);
    } finally {
        mongoose.connection.close();
        process.exit(0);
    }
}

runMigration();
