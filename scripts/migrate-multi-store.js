/**
 * Production-Safe Multi-Store Database Migration Script
 * 
 * ---------------------------------------------------------------------------
 * PURPOSE:
 * ---------------------------------------------------------------------------
 * Supports exactly two stores: "handloomer" (Store 1) and "linen" (Store 2).
 * 
 * 1. Backfills `storeId: "handloomer"` on legacy users, orders, reviews, and OTPs
 *    that were created before multi-store support was introduced.
 * 2. Preserves historical guest orders as unclaimed until explicit ownership verification
 *    succeeds via checkout capability token.
 * 3. Migrates `users` collection unique index from single-field `email_1`
 *    to compound `{ email: 1, storeId: 1 }`. This allows a customer to register
 *    independently on both Handloomer and House of Qalakari (linen) using the same email address.
 * 4. Creates a non-unique compound index on `{ phone: 1, storeId: 1 }`.
 *    (Note: Phone numbers are intentionally non-unique because family members
 *    and guest checkouts frequently share mobile numbers).
 * 5. Builds store-aware query indexes on `orders` for performant isolation.
 * 
 * ---------------------------------------------------------------------------
 * SAFETY GUARANTEES:
 * ---------------------------------------------------------------------------
 * - DEFAULTS TO DRY-RUN MODE: Running without `--execute` audits data only; no writes occur.
 * - IDEMPOTENT: Safe to run multiple times without duplicating side effects.
 * - NON-DESTRUCTIVE: Never drops customer data or collections.
 * - VALIDATES DATA BEFORE INDEXING: Verifies no duplicate (email, storeId) pairs exist before creating unique index.
 * 
 * ---------------------------------------------------------------------------
 * USAGE:
 * ---------------------------------------------------------------------------
 * Dry-run (audit only, no changes):
 *   node scripts/migrate-multi-store.js
 * 
 * Live execution:
 *   node scripts/migrate-multi-store.js --execute
 * 
 * ---------------------------------------------------------------------------
 * ROLLBACK PROCEDURE (If Reverting to Single-Store Architecture):
 * ---------------------------------------------------------------------------
 * If customers have registered with the SAME email address across both stores,
 * MongoDB will reject creating single-field unique index `email_1` with error E11000.
 * 
 * Step 1: Detect cross-store duplicate emails:
 *   db.users.aggregate([
 *     { $group: { _id: "$email", count: { $sum: 1 }, stores: { $push: "$storeId" }, ids: { $push: "$_id" } } },
 *     { $match: { count: { $gt: 1 } } }
 *   ])
 * 
 * Step 2: For any duplicate email found, archive or rename secondary store accounts:
 *   db.users.updateOne(
 *     { _id: ObjectId("<secondary_user_id>"), storeId: "linen" },
 *     { $set: { email: "<email>+linen_archived@domain.com" } }
 *   )
 * 
 * Step 3: Recreate the legacy global unique index on email:
 *   db.users.createIndex({ email: 1 }, { unique: true })
 * 
 * Step 4: Drop the compound index:
 *   db.users.dropIndex("email_1_storeId_1")
 */

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const isDryRun = !process.argv.includes("--execute");

const UNMIGRATED_STORE_FILTER = {
    $or: [
        { storeId: { $exists: false } },
        { storeId: null },
        { storeId: "" },
    ],
};

async function runMigration() {
    console.log("============================================================");
    console.log(" MULTI-STORE DATABASE MIGRATION (Two Stores: handloomer & linen)");
    console.log(` MODE: ${isDryRun ? "DRY RUN (Preview Only - No writes will occur)" : "EXECUTE (Live Database Changes)"}`);
    console.log("============================================================\n");

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
        console.error("❌ ERROR: MONGO_URI is not set in environment.");
        process.exit(1);
    }

    try {
        await mongoose.connect(mongoUri);
        console.log(" Connected to MongoDB successfully.\n");
        const db = mongoose.connection.db;

        const usersColl = db.collection("users");
        const ordersColl = db.collection("orders");
        const reviewsColl = db.collection("reviews");
        const otpsColl = db.collection("otps");

        // ---------------------------------------------------------------------
        // 1. Audit Unmigrated Records
        // ---------------------------------------------------------------------
        const unmigratedUsers = await usersColl.countDocuments(UNMIGRATED_STORE_FILTER);
        const unmigratedOrders = await ordersColl.countDocuments(UNMIGRATED_STORE_FILTER);
        const unmigratedReviews = await reviewsColl.countDocuments(UNMIGRATED_STORE_FILTER);
        const unmigratedOtps = await otpsColl.countDocuments(UNMIGRATED_STORE_FILTER);

        console.log("📊 Unmigrated Record Audit (Missing / Null storeId):");
        console.log(`  - Users:   ${unmigratedUsers}`);
        console.log(`  - Orders:  ${unmigratedOrders}`);
        console.log(`  - Reviews: ${unmigratedReviews}`);
        console.log(`  - OTPs:    ${unmigratedOtps}\n`);

        // ---------------------------------------------------------------------
        // 2. Duplicate Pre-Check: Validate Data Before Creating Unique Indexes
        // ---------------------------------------------------------------------
        console.log("🔍 Checking for duplicate (email, storeId) in users...");
        const duplicates = await usersColl.aggregate([
            {
                $project: {
                    email: 1,
                    effectiveStoreId: { $ifNull: ["$storeId", "handloomer"] },
                },
            },
            {
                $group: {
                    _id: { email: "$email", storeId: "$effectiveStoreId" },
                    count: { $sum: 1 },
                    ids: { $push: "$_id" },
                },
            },
            { $match: { count: { $gt: 1 } } },
        ]).toArray();

        if (duplicates.length > 0) {
            console.error("❌ Pre-migration validation FAILED: Duplicate (email, storeId) records found:");
            console.error(JSON.stringify(duplicates, null, 2));
            console.error("Please resolve duplicate accounts before proceeding.");
            process.exit(1);
        }
        console.log("  ✅ No duplicate (email, storeId) records detected.\n");

        // ---------------------------------------------------------------------
        // 3. Backfill storeId: "handloomer" on Legacy Records
        // ---------------------------------------------------------------------
        if (!isDryRun) {
            console.log("⚙️  Backfilling storeId: 'handloomer' on legacy records...");
            
            if (unmigratedUsers > 0) {
                const uRes = await usersColl.updateMany(
                    UNMIGRATED_STORE_FILTER,
                    { $set: { storeId: "handloomer" } }
                );
                console.log(`  ✅ Users backfilled: ${uRes.modifiedCount}`);
            }

            if (unmigratedOrders > 0) {
                const oRes = await ordersColl.updateMany(
                    UNMIGRATED_STORE_FILTER,
                    { $set: { storeId: "handloomer" } }
                );
                console.log(`  ✅ Orders backfilled: ${oRes.modifiedCount}`);
            }

            if (unmigratedReviews > 0) {
                const rRes = await reviewsColl.updateMany(
                    UNMIGRATED_STORE_FILTER,
                    { $set: { storeId: "handloomer" } }
                );
                console.log(`  ✅ Reviews backfilled: ${rRes.modifiedCount}`);
            }

            if (unmigratedOtps > 0) {
                const otpRes = await otpsColl.updateMany(
                    UNMIGRATED_STORE_FILTER,
                    { $set: { storeId: "handloomer" } }
                );
                console.log(`  ✅ OTPs backfilled: ${otpRes.modifiedCount}`);
            }
            console.log();
        } else {
            console.log("ℹ️  [Dry Run] Would update missing storeId to 'handloomer' on all above documents.\n");
        }

        // ---------------------------------------------------------------------
        // 4. User Index Migration
        // ---------------------------------------------------------------------
        console.log("🔍 Inspecting User Collection Indexes...");
        const userIndexes = await usersColl.indexes();
        console.log("  Existing indexes on 'users':", userIndexes.map(i => i.name).join(", "));

        const hasOldEmailIndex = userIndexes.some(i => i.name === "email_1" && i.unique);
        const hasCompoundEmailIndex = userIndexes.some(
            i => i.key && (
                (i.key.email === 1 && i.key.storeId === 1) ||
                (i.key.storeId === 1 && i.key.email === 1)
            ) && i.unique
        );
        const hasCompoundPhoneIndex = userIndexes.some(
            i => i.key && (
                (i.key.phone === 1 && i.key.storeId === 1) ||
                (i.key.storeId === 1 && i.key.phone === 1)
            )
        );

        console.log(`  - Legacy unique email_1 index present: ${hasOldEmailIndex ? "YES" : "NO"}`);
        console.log(`  - Compound { email: 1, storeId: 1 } present: ${hasCompoundEmailIndex ? "YES" : "NO"}`);
        console.log(`  - Compound { phone: 1, storeId: 1 } present: ${hasCompoundPhoneIndex ? "YES" : "NO"}\n`);

        if (!isDryRun) {
            // Step 4a: Create compound unique index FIRST to ensure uniqueness is guarded
            if (!hasCompoundEmailIndex) {
                console.log("⚙️  Creating compound unique index: { email: 1, storeId: 1 } on users...");
                await usersColl.createIndex({ email: 1, storeId: 1 }, { unique: true, background: true });
                console.log("  ✅ Compound email index created successfully.");
            }

            // Step 4b: Create non-unique compound index on phone
            if (!hasCompoundPhoneIndex) {
                console.log("⚙️  Creating compound index: { phone: 1, storeId: 1 } on users...");
                await usersColl.createIndex({ phone: 1, storeId: 1 }, { background: true });
                console.log("  ✅ Compound phone index created successfully.");
            }

            // Step 4c: Safely drop legacy global unique email_1 index only after compound index exists
            if (hasOldEmailIndex) {
                console.log("⚠️  Dropping legacy single-field unique index email_1 from users...");
                await usersColl.dropIndex("email_1");
                console.log("  ✅ Legacy email_1 index dropped (compound { email: 1, storeId: 1 } now authoritative).");
            }
            console.log();
        } else {
            console.log("ℹ️  [Dry Run] Planned index operations:");
            if (!hasCompoundEmailIndex) console.log("  - Create index: { email: 1, storeId: 1 } (unique)");
            if (!hasCompoundPhoneIndex) console.log("  - Create index: { phone: 1, storeId: 1 } (standard index)");
            if (hasOldEmailIndex) console.log("  - Drop legacy index: email_1");
            console.log();
        }

        // ---------------------------------------------------------------------
        // 5. Order Index Migration
        // ---------------------------------------------------------------------
        console.log("🔍 Inspecting Order Collection Indexes...");
        const orderIndexes = await ordersColl.indexes();
        console.log("  Existing indexes on 'orders':", orderIndexes.map(i => i.name).join(", "));

        if (!isDryRun) {
            console.log("⚙️  Ensuring store-aware indexes on orders...");
            await ordersColl.createIndex({ storeId: 1, user: 1, createdAt: -1 }, { background: true });
            await ordersColl.createIndex({ storeId: 1, status: 1 }, { background: true });
            await ordersColl.createIndex({ storeId: 1, "shippingAddress.email": 1 }, { background: true });
            console.log("  ✅ Order store-aware indexes verified.\n");
        } else {
            console.log("ℹ️  [Dry Run] Would ensure store-aware indexes on orders.\n");
        }

        // ---------------------------------------------------------------------
        // 6. Verification & Health Summary
        // ---------------------------------------------------------------------
        console.log("============================================================");
        if (isDryRun) {
            console.log(" ✅ DRY RUN COMPLETE. No data or indexes were modified.");
            console.log(" To apply these changes to the database, run:");
            console.log("   node scripts/migrate-multi-store.js --execute");
        } else {
            console.log(" ✅ MIGRATION COMPLETED SUCCESSFULLY.");
            console.log(" Multi-store isolation constraints are now live.");
        }
        console.log("============================================================\n");

    } catch (err) {
        console.error("❌ Migration failed with error:", err);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
    }
}

runMigration();
