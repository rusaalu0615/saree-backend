import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import connectDB from "../config/db.js";
import { retryConfigFailedEmailJobs } from "../services/emailWorker.js";

async function main() {
    console.log("[OperationalRecovery] Connecting to database...");
    await connectDB();

    console.log("[OperationalRecovery] Checking configuration and recovering eligible config-failed email jobs...");
    const result = await retryConfigFailedEmailJobs();

    if (result.success) {
        console.log(`[OperationalRecovery] Successfully recovered ${result.resetCount} email jobs for delivery.`);
    } else {
        console.warn(`[OperationalRecovery] Recovery aborted: ${result.reason}`);
    }

    await mongoose.disconnect();
    process.exit(result.success ? 0 : 1);
}

main().catch(async (err) => {
    console.error("[OperationalRecovery] Fatal error during email recovery:", err.message);
    try {
        await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
});
