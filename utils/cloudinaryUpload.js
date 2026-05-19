import cloudinary from "../config/cloudinary.js";

/**
 * Upload a single buffer to Cloudinary using upload_stream.
 * Returns the Cloudinary result (secure_url, public_id, etc.)
 */
function uploadBufferToCloudinary(buffer, options = {}) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { timeout: 60000, ...options }, // 60s timeout
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        stream.end(buffer);
    });
}

/**
 * Upload a single image buffer to Cloudinary.
 * @param {Buffer} buffer - The image buffer from multer memoryStorage
 * @param {string} [originalname] - Original filename for reference
 * @returns {Promise<string>} - The secure URL of the uploaded image
 */
export async function uploadImage(buffer, originalname = "image") {
    const result = await uploadBufferToCloudinary(buffer, {
        folder: "images",
        resource_type: "image",
        format: "webp",
        quality: "auto",
    });
    return result.secure_url;
}

/**
 * Upload multiple image buffers to Cloudinary IN PARALLEL.
 * @param {Array<{buffer: Buffer, originalname: string}>} files - Array of multer file objects
 * @returns {Promise<string[]>} - Array of secure URLs
 */
export async function uploadImages(files) {
    if (!files || files.length === 0) return [];
    const uploads = files.map((file) =>
        uploadImage(file.buffer, file.originalname)
    );
    return Promise.all(uploads);
}

/**
 * Upload a single video buffer to Cloudinary.
 * @param {Buffer} buffer - The video buffer from multer memoryStorage
 * @returns {Promise<string>} - The secure URL of the uploaded video
 */
export async function uploadVideo(buffer) {
    const result = await uploadBufferToCloudinary(buffer, {
        folder: "videos",
        resource_type: "video",
    });
    return result.secure_url;
}

/**
 * Extract public_id from a Cloudinary URL for deletion.
 * e.g. "https://res.cloudinary.com/xxx/image/upload/v123/images/abc.jpg" → "images/abc"
 * @param {string} url - Cloudinary URL
 * @returns {string|null} - The public_id or null if not a Cloudinary URL
 */
export function extractPublicId(url) {
    if (!url || !url.includes("res.cloudinary.com")) return null;
    try {
        // URL format: .../upload/v<version>/<public_id>.<ext>
        const parts = url.split("/upload/");
        if (parts.length < 2) return null;
        const afterUpload = parts[1];
        // Remove version prefix (v123456789/)
        const withoutVersion = afterUpload.replace(/^v\d+\//, "");
        // Remove file extension
        const publicId = withoutVersion.replace(/\.[^/.]+$/, "");
        return publicId;
    } catch {
        return null;
    }
}

/**
 * Delete a single asset from Cloudinary by URL.
 * @param {string} url - The Cloudinary URL to delete
 * @param {string} [resourceType="image"] - "image" or "video"
 */
export async function deleteFromCloudinary(url, resourceType = "image") {
    const publicId = extractPublicId(url);
    if (!publicId) return;
    try {
        await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    } catch (err) {
        console.warn(`Failed to delete Cloudinary asset ${publicId}:`, err.message);
    }
}

/**
 * Delete multiple assets from Cloudinary.
 * @param {string[]} urls - Array of Cloudinary URLs
 * @param {string} [resourceType="image"]
 */
export async function deleteMultipleFromCloudinary(urls, resourceType = "image") {
    const deletions = urls
        .filter(Boolean)
        .map((url) => deleteFromCloudinary(url, resourceType));
    await Promise.allSettled(deletions);
}
