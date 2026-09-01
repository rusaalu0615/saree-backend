import { PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET_NAME, R2_PUBLIC_URL } from "../config/r2.js";
import sharp from "sharp";
import crypto from "crypto";
import path from "path";

/**
 * Generate a clean, unique file key
 */
function generateKey(folder, originalname = "", extension = "") {
    const randomHex = crypto.randomBytes(10).toString("hex");
    const sanitizedBase = path.basename(originalname, path.extname(originalname))
        .replace(/[^a-zA-Z0-9-_]/g, "-")
        .toLowerCase()
        .slice(0, 30);
    const ext = extension.startsWith(".") ? extension : `.${extension}`;
    const namePart = sanitizedBase ? `${sanitizedBase}-${randomHex}` : randomHex;
    return `${folder}/${namePart}${ext}`;
}

/**
 * Upload a raw buffer to Cloudflare R2 bucket.
 * @param {Buffer} buffer - File buffer
 * @param {string} key - Object key in bucket (e.g. 'images/foo.webp')
 * @param {string} contentType - MIME type (e.g. 'image/webp')
 * @param {string} [cacheControl='public, max-age=31536000, immutable']
 * @returns {Promise<string>} - Full public URL of the uploaded asset
 */
export async function uploadBufferToR2(buffer, key, contentType, cacheControl = "public, max-age=31536000, immutable") {
    if (!R2_BUCKET_NAME) {
        throw new Error("R2_BUCKET_NAME environment variable is not defined");
    }

    const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: cacheControl,
    });

    await r2Client.send(command);

    if (R2_PUBLIC_URL) {
        return `${R2_PUBLIC_URL}/${key}`;
    }
    // Fallback if R2_PUBLIC_URL is not set
    return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${key}`;
}

/**
 * Upload a single image buffer to Cloudflare R2 (optimized with Sharp to WebP).
 * @param {Buffer} buffer - Multer file buffer
 * @param {string} [originalname="image"] - Original filename
 * @returns {Promise<string>} - Public URL
 */
export async function uploadImage(buffer, originalname = "image") {
    let processedBuffer = buffer;
    let contentType = "image/webp";
    let ext = ".webp";

    try {
        // Optimize image to high-efficiency WebP with sharp
        processedBuffer = await sharp(buffer)
            .resize({ width: 1920, withoutEnlargement: true })
            .webp({ quality: 85 })
            .toBuffer();
    } catch (error) {
        console.warn(`[Sharp Error] Failed to optimize image ${originalname}:`, error.message);
        // Fallback to original buffer and inspect extension
        const originalExt = path.extname(originalname) || ".jpg";
        ext = originalExt;
        contentType = originalExt.endsWith("png") ? "image/png" : "image/jpeg";
    }

    const key = generateKey("images", originalname, ext);
    return await uploadBufferToR2(processedBuffer, key, contentType);
}

/**
 * Upload multiple image buffers to Cloudflare R2 in parallel.
 * @param {Array<{buffer: Buffer, originalname: string}>} files - Array of multer files
 * @returns {Promise<string[]>} - Array of public URLs
 */
export async function uploadImages(files) {
    if (!files || files.length === 0) return [];
    const uploads = files.map((file) =>
        uploadImage(file.buffer, file.originalname)
    );
    return Promise.all(uploads);
}

/**
 * Upload a single video buffer to Cloudflare R2.
 * @param {Buffer} buffer - Video buffer from multer
 * @param {string} [originalname="video.mp4"] - Original filename
 * @param {string} [mimetype="video/mp4"] - Video MIME type
 * @returns {Promise<string>} - Public URL
 */
export async function uploadVideo(buffer, originalname = "video.mp4", mimetype = "video/mp4") {
    const ext = path.extname(originalname) || ".mp4";
    const key = generateKey("videos", originalname, ext);
    return await uploadBufferToR2(buffer, key, mimetype || "video/mp4");
}

/**
 * Extract R2 object key from public URL.
 * Handles both custom domain (e.g. "https://media.domain.com/images/xyz.webp")
 * and pub-xxx.r2.dev or r2.cloudflarestorage.com URLs.
 * @param {string} url - Public URL
 * @returns {string|null} - Object key or null
 */
export function extractR2Key(url) {
    if (!url || typeof url !== "string") return null;

    try {
        const parsed = new URL(url);
        let pathname = parsed.pathname.replace(/^\/+/, ""); // remove leading slashes

        // If pathname starts with bucket name (e.g. endpoint style), strip bucket name
        if (R2_BUCKET_NAME && pathname.startsWith(`${R2_BUCKET_NAME}/`)) {
            pathname = pathname.replace(`${R2_BUCKET_NAME}/`, "");
        }

        // Return if it looks like an image or video key
        if (pathname.startsWith("images/") || pathname.startsWith("videos/")) {
            return pathname;
        }

        // Otherwise return pathname if non-empty
        return pathname || null;
    } catch {
        return null;
    }
}

/**
 * Delete a single asset from Cloudflare R2 by URL or Key.
 * @param {string} urlOrKey - The asset URL or object key to delete
 */
export async function deleteFromR2(urlOrKey) {
    if (!urlOrKey || !R2_BUCKET_NAME) return;

    let key = urlOrKey;
    if (urlOrKey.startsWith("http://") || urlOrKey.startsWith("https://")) {
        key = extractR2Key(urlOrKey);
    }

    if (!key) return;

    try {
        const command = new DeleteObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
        });
        await r2Client.send(command);
    } catch (err) {
        console.warn(`[Cloudflare R2] Failed to delete asset ${key}:`, err.message);
    }
}

/**
 * Delete multiple assets from Cloudflare R2.
 * @param {string[]} urls - Array of asset URLs or keys
 */
export async function deleteMultipleFromR2(urls) {
    if (!urls || !urls.length || !R2_BUCKET_NAME) return;

    const deletions = urls
        .filter(Boolean)
        .map((url) => deleteFromR2(url));
    await Promise.allSettled(deletions);
}
