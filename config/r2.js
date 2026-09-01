import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
dotenv.config();

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME;
const publicUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    console.warn("[Cloudflare R2] Warning: One or more Cloudflare R2 environment variables are missing (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME).");
}

export const r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: accessKeyId || "",
        secretAccessKey: secretAccessKey || "",
    },
});

export const R2_BUCKET_NAME = bucketName;
export const R2_PUBLIC_URL = publicUrl;

export default r2Client;
