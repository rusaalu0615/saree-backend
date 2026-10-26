/**
 * DATABASE INDEX & COLLECTION READINESS VERIFICATION
 *
 * Requirements (spec §6):
 *  - Identify indexes required for correctness: checkout idempotency, event deduplication,
 *    email-job deduplication, and actual unique constraints.
 *  - Verify critical indexes during startup/deployment readiness.
 *  - Fail readiness clearly when a required uniqueness guarantee is absent.
 *  - Treat optional performance indexes separately (warn, do not abort).
 *  - Prepare all collections used by transactions, including EmailJob.
 *  - Avoid expensive initialization on the checkout request path.
 *  - Never automatically drop indexes or run destructive syncIndexes.
 *  - Document safe migration steps when existing duplicate records block indexes.
 */

import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import Coupon from "../models/couponModal.js";
import User from "../models/userModal.js";
import WebhookEvent from "../models/webhookEventModel.js";
import EmailJob from "../models/emailJobModel.js";

export const REQUIRED_COLLECTION_MODELS = [
    Order,
    Product,
    Coupon,
    User,
    WebhookEvent,
    EmailJob,
];

/**
 * Critical unique indexes that MUST exist to guarantee correctness and idempotency.
 * If any of these are missing and cannot be built (e.g. blocked by duplicate records),
 * database readiness FAILS.
 */
export const CRITICAL_UNIQUE_INDEXES = [
    {
        model: Order,
        modelName: "Order",
        key: { orderId: 1 },
        options: { unique: true },
        description: "Primary business order identifier uniqueness",
    },
    {
        model: Order,
        modelName: "Order",
        key: { checkoutKey: 1 },
        options: { unique: true, sparse: true },
        description: "Checkout idempotency — one order per checkout attempt",
    },
    {
        model: WebhookEvent,
        modelName: "WebhookEvent",
        key: { eventId: 1 },
        options: { unique: true },
        description: "Gateway webhook deduplication — prevents double capture/refund",
    },
    {
        model: EmailJob,
        modelName: "EmailJob",
        key: { dedupeKey: 1 },
        options: { unique: true },
        description: "Transactional outbox deduplication — one confirmation mail per order",
    },
    {
        model: User,
        modelName: "User",
        key: { email: 1 },
        options: { unique: true },
        description: "Customer account uniqueness",
    },
    {
        model: Coupon,
        modelName: "Coupon",
        key: { code: 1 },
        options: { unique: true },
        description: "Promo code uniqueness",
    },
];

let readinessPromise = null;
let readinessState = {
    isReady: false,
    checkedAt: null,
    errors: [],
    warnings: [],
};

/**
 * Check if an index specification matches an existing index in MongoDB.
 */
function indexMatchesKey(existingKey, targetKey) {
    const existingProps = Object.keys(existingKey);
    const targetProps = Object.keys(targetKey);
    if (existingProps.length !== targetProps.length) return false;
    return targetProps.every((k) => existingKey[k] === targetKey[k]);
}

/**
 * Ensure a collection exists so MongoDB transactions do not throw InvalidNamespace.
 */
async function ensureCollection(model) {
    try {
        await model.createCollection();
    } catch (err) {
        // Code 48 / NamespaceExists is expected if the collection is already present
        if (err.code !== 48 && err.codeName !== "NamespaceExists") {
            throw err;
        }
    }
}

/**
 * Inspect and build required critical unique indexes.
 */
async function verifyCriticalIndex(item) {
    const { model, modelName, key, options, description } = item;
    const collection = model.collection;

    let existingIndexes = [];
    try {
        existingIndexes = await collection.indexes();
    } catch (err) {
        if (err.code === 26 || err.codeName === "NamespaceNotFound") {
            await ensureCollection(model);
            existingIndexes = await collection.indexes();
        } else {
            throw err;
        }
    }

    const found = existingIndexes.find((idx) => indexMatchesKey(idx.key, key));

    if (found) {
        if (options.unique && !found.unique) {
            return {
                ok: false,
                critical: true,
                error: `Index on ${modelName} ${JSON.stringify(key)} exists but is NOT UNIQUE! Uniqueness guarantee is broken.`,
                migrationHelp: `Safe migration: Find duplicates on ${modelName} with field ${Object.keys(key).join(", ")}, resolve them, and rebuild index with unique: true.`,
            };
        }
        return { ok: true, modelName, key };
    }

    // Attempt to build the missing critical index
    try {
        await collection.createIndex(key, options);
        return { ok: true, created: true, modelName, key };
    } catch (err) {
        const isDuplicateKey = err.code === 11000 || err.codeName === "DuplicateKey";
        return {
            ok: false,
            critical: true,
            error: `Failed to build critical unique index for ${modelName} on ${JSON.stringify(key)}: ${err.message}`,
            isDuplicateKey,
            migrationHelp: isDuplicateKey
                ? `Duplicate records exist in "${modelName}" preventing unique index creation. Safe migration:
1. Run: db.${collection.name}.aggregate([{ $group: { _id: "$${Object.keys(key)[0]}", count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }])
2. Deduplicate or archive duplicate records.
3. Re-run index creation.`
                : "Check database permissions and server status.",
        };
    }
}

/**
 * Verify complete database readiness for checkout and order processing.
 * Pre-creates collections, validates critical unique indexes, and warns on optional performance indexes.
 */
export async function verifyDatabaseReadiness() {
    const errors = [];
    const warnings = [];

    // 1. Ensure all collections exist (hard prerequisite for replica set transactions and transaction queries)
    for (const model of REQUIRED_COLLECTION_MODELS) {
        try {
            await ensureCollection(model);
        } catch (err) {
            errors.push(`Failed to ensure collection "${model.modelName}": ${err.message}`);
        }
    }

    // 2. Verify real MongoDB replica set and multi-document transaction capability
    if (mongoose.connection.readyState === 1) {
        try {
            const testSession = await mongoose.startSession();
            try {
                await testSession.withTransaction(async () => {
                    // Perform a safe, real database query on a prepared collection within the transaction.
                    // This forces a wire command to the MongoDB server with lsid and txnNumber.
                    // A standalone MongoDB deployment immediately rejects this with:
                    // "Transaction numbers are only allowed on a replica set member or mongos"
                    await EmailJob.findOne({}).session(testSession).select("_id").lean();
                    return true;
                });
            } finally {
                await testSession.endSession().catch(() => {});
            }
        } catch (txErr) {
            const msg = txErr?.message || "";
            if (/replica set|Transaction numbers are only allowed|not enabled/i.test(msg)) {
                errors.push(
                    `MongoDB replica set transactions are required for checkout and order safety, but the current database does not support them (${msg}). Development setup requirement: Start MongoDB as a single-node or multi-node replica set (e.g. 'mongod --replSet rs0' and execute 'rs.initiate()') or configure a replica set connection string.`
                );
            } else {
                errors.push(`Failed to verify transaction support on MongoDB: ${msg}`);
            }
        }
    } else {
        errors.push("MongoDB connection is not ready for transactions (readyState !== 1).");
    }

    // 2. Validate all critical unique indexes
    for (const item of CRITICAL_UNIQUE_INDEXES) {
        try {
            const res = await verifyCriticalIndex(item);
            if (!res.ok) {
                errors.push(res.error);
                if (res.migrationHelp) {
                    console.error(`[IndexReadiness] MIGRATION REQUIRED for ${item.modelName}:\n${res.migrationHelp}`);
                }
            }
        } catch (err) {
            errors.push(`Error checking index for ${item.modelName}: ${err.message}`);
        }
    }

    // 3. Soft build for secondary/schema declared performance indexes
    for (const model of REQUIRED_COLLECTION_MODELS) {
        try {
            await model.createIndexes();
        } catch (err) {
            warnings.push(
                `Optional performance index skipped for "${model.modelName}" (${err.codeName || err.code || "error"}: ${err.message})`
            );
        }
    }

    const isReady = errors.length === 0;
    readinessState = {
        isReady,
        checkedAt: new Date(),
        errors,
        warnings,
    };

    if (!isReady) {
        console.error("[IndexReadiness] CRITICAL DATABASE READINESS CHECK FAILED:");
        errors.forEach((e) => console.error("  -", e));
    } else {
        console.log("[IndexReadiness] All critical unique indexes and transactional collections verified successfully.");
        if (warnings.length > 0) {
            warnings.forEach((w) => console.warn("  [warn]", w));
        }
    }

    return readinessState;
}

/**
 * Ensure readiness is cached and fast for the checkout request path.
 */
export async function ensureDatabaseReady() {
    if (readinessState.isReady) {
        return readinessState;
    }
    if (!readinessPromise) {
        readinessPromise = verifyDatabaseReadiness().finally(() => {
            if (!readinessState.isReady) readinessPromise = null; // allow retry if failed
        });
    }
    return readinessPromise;
}

export function getReadinessStatus() {
    return readinessState;
}

export default {
    REQUIRED_COLLECTION_MODELS,
    CRITICAL_UNIQUE_INDEXES,
    verifyDatabaseReadiness,
    ensureDatabaseReady,
    getReadinessStatus,
};
