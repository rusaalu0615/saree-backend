import mongoose from "mongoose";
import sharp from "sharp";
import { v2 as cloudinary } from "cloudinary";
import "dotenv/config";
import productModal from "../models/productModal.js";
import { uploadImage, deleteFromCloudinary, extractPublicId } from "../utils/cloudinaryUpload.js";

// Ensure Cloudinary is configured since dotenv/config might run differently here
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const DB_URI = process.env.CUSTOM_MONGO_URI || process.env.MONGO_URI;

async function fetchImageBuffer(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

async function processImage(url, type) {
    if (!url || !url.includes("res.cloudinary.com")) return url;
    
    // Check if it's already WebP and properly sized
    // Cloudinary URLs that have been processed by us typically end in .webp
    if (url.endsWith(".webp")) {
        console.log(`[SKIP] Already WebP: ${url}`);
        return url;
    }

    try {
        console.log(`[PROCESS] Downloading ${type}: ${url}`);
        const imageBuffer = await fetchImageBuffer(url);

        console.log(`[PROCESS] Optimizing & Uploading...`);
        // uploadImage from utils already does sharp resize and webp conversion
        const newUrl = await uploadImage(imageBuffer, "migrated-image");
        
        console.log(`[SUCCESS] New URL: ${newUrl}`);
        
        // Delete old image
        console.log(`[CLEANUP] Deleting old image...`);
        await deleteFromCloudinary(url);
        
        return newUrl;
    } catch (error) {
        console.error(`[ERROR] Failed to process ${url}:`, error.message);
        return url; // Return original url on failure
    }
}

async function migrate() {
    if (!DB_URI) {
        console.error("No MongoDB URI found!");
        process.exit(1);
    }

    try {
        console.log(`Connecting to MongoDB...`);
        await mongoose.connect(DB_URI);
        console.log("Connected successfully.\n");

        const products = await productModal.find({});
        console.log(`Found ${products.length} products to process.\n`);

        let updatedCount = 0;

        for (const product of products) {
            console.log(`===========================================`);
            console.log(`Processing Product: ${product.name} (SKU: ${product.sku})`);
            
            let hasChanges = false;

            // Process mainImage
            if (product.mainImage) {
                const newMain = await processImage(product.mainImage, "Main Image");
                if (newMain !== product.mainImage) {
                    product.mainImage = newMain;
                    hasChanges = true;
                }
            }

            // Process galleryImages
            if (product.galleryImages && product.galleryImages.length > 0) {
                for (let i = 0; i < product.galleryImages.length; i++) {
                    const galleryObj = product.galleryImages[i];
                    if (galleryObj.url) {
                        const newUrl = await processImage(galleryObj.url, `Gallery Image ${i + 1}`);
                        if (newUrl !== galleryObj.url) {
                            product.galleryImages[i].url = newUrl;
                            hasChanges = true;
                        }
                    }
                }
            }

            if (hasChanges) {
                console.log(`Saving updated product to DB...`);
                await product.save();
                updatedCount++;
                console.log(`Saved successfully.`);
            } else {
                console.log(`No changes needed for this product.`);
            }
        }

        console.log(`\n===========================================`);
        console.log(`Migration Complete!`);
        console.log(`Successfully updated ${updatedCount} out of ${products.length} products.`);

    } catch (error) {
        console.error("Migration failed:", error);
    } finally {
        mongoose.connection.close();
        process.exit(0);
    }
}

migrate();
