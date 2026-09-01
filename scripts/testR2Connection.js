import "dotenv/config";
import { ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET_NAME, R2_PUBLIC_URL } from "../config/r2.js";

async function testConnection() {
    console.log("==========================================");
    console.log("       CLOUDFLARE R2 CONNECTION TEST      ");
    console.log("==========================================");
    console.log("Account ID:  ", process.env.R2_ACCOUNT_ID ? "[SET]" : "[MISSING]");
    console.log("Access Key:  ", process.env.R2_ACCESS_KEY_ID ? "[SET]" : "[MISSING]");
    console.log("Secret Key:  ", process.env.R2_SECRET_ACCESS_KEY ? "[SET]" : "[MISSING]");
    console.log("Bucket Name: ", R2_BUCKET_NAME || "[MISSING]");
    console.log("Public URL:  ", R2_PUBLIC_URL || "[MISSING / OPTIONAL]");
    console.log("------------------------------------------");

    if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
        console.error("❌ Missing required R2 credentials in .env. Please define R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME.");
        process.exit(1);
    }

    try {
        console.log(`1. Testing connection to bucket "${R2_BUCKET_NAME}"...`);
        const listCmd = new ListObjectsV2Command({
            Bucket: R2_BUCKET_NAME,
            MaxKeys: 5,
        });
        const listRes = await r2Client.send(listCmd);
        console.log(`✅ Successfully connected! Found ${listRes.KeyCount || 0} existing objects in first page.`);

        console.log(`2. Testing test file upload & deletion...`);
        const testKey = `test-healthcheck-${Date.now()}.txt`;
        const putCmd = new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: testKey,
            Body: Buffer.from("R2 Connection Test Successful"),
            ContentType: "text/plain",
        });
        await r2Client.send(putCmd);
        console.log(`✅ Successfully uploaded test object "${testKey}".`);

        const delCmd = new DeleteObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: testKey,
        });
        await r2Client.send(delCmd);
        console.log(`✅ Successfully deleted test object.`);

        console.log("------------------------------------------");
        console.log("🎉 Cloudflare R2 connection is completely verified and working!");
        console.log("==========================================");
        process.exit(0);
    } catch (err) {
        console.error("❌ R2 Connection Error:", err.message);
        process.exit(1);
    }
}

testConnection();
