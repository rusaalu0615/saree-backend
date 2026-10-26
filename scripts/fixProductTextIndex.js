/**
 * One-time repair of the products text index.
 *
 * The schema declares ProductTextIndex (name/category/tags/color/material/
 * shortDescription with weights) while the live collection still holds an older
 * auto-named text index. MongoDB allows at most ONE text index per collection,
 * so the declared build is rejected with
 *   "An equivalent index already exists with a different name and options"
 * which used to 500 every POST /api/order.
 *
 *   node scripts/fixProductTextIndex.js            # dry run: show what would change
 *   node scripts/fixProductTextIndex.js --apply    # drop the stale index, build the declared one
 *
 * Deliberately NOT Model.syncIndexes(): that would also drop the extra indexes
 * that exist in the database but are not declared in the schema (name_1, sku_1,
 * category_1_price_1, createdAt_-1), which are load-bearing for other queries.
 * Documents are never touched — index metadata only, and the operation is
 * reversible (the old index can be rebuilt from its own definition).
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "../models/productModal.js";

dotenv.config();

// Stop Mongoose from racing us with a background index build on connect.
mongoose.set("autoIndex", false);

const DECLARED_NAME = "ProductTextIndex";

const isTextIndex = (idx) =>
    Object.values(idx.key || {}).some((v) => String(v).toLowerCase() === "text");

const show = (label, indexes) => {
    console.log(`\n${label} (${indexes.length} indexes)`);
    for (const idx of indexes) {
        console.log(
            `  ${isTextIndex(idx) ? "[text]" : "     "} ${idx.name}` +
                (isTextIndex(idx) ? `  weights=${JSON.stringify(idx.weights ?? {})}` : "")
        );
    }
};

const run = async () => {
    const apply = process.argv.includes("--apply");
    console.log(apply ? "MODE: APPLY (will mutate indexes)" : "MODE: DRY RUN (nothing is changed)");

    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    const coll = Product.collection;

    const before = await coll.indexes();
    show("BEFORE", before);

    // Any text index that is not the declared one is stale by definition.
    const stale = before.filter((idx) => isTextIndex(idx) && idx.name !== DECLARED_NAME);

    if (stale.length === 0 && before.some((i) => i.name === DECLARED_NAME)) {
        console.log(`\nAlready correct: "${DECLARED_NAME}" exists and no stale text index remains.`);
        await mongoose.disconnect();
        return;
    }

    if (!apply) {
        console.log(`\nWould drop ${stale.length} stale text index/indices:`);
        for (const idx of stale) console.log(`  - ${idx.name}`);
        console.log(`Would build the declared index: ${DECLARED_NAME}`);
        console.log("\nRe-run with --apply to make it happen.");
        await mongoose.disconnect();
        return;
    }

    for (const idx of stale) {
        await coll.dropIndex(idx.name);
        console.log(`\nDropped stale text index: ${idx.name}`);
    }

    // Exactly what checkout needs to succeed: the schema-declared indexes build
    // cleanly now that the namespace conflict is gone.
    await Product.createIndexes();
    console.log(`Built declared indexes for "${Product.modelName}".`);

    const after = await coll.indexes();
    show("AFTER", after);

    const built = after.find((i) => i.name === DECLARED_NAME);
    if (!built) {
        console.error(`\nFAILED: ${DECLARED_NAME} is still missing.`);
        process.exitCode = 1;
    } else {
        console.log(`\nOK: ${DECLARED_NAME} weights=${JSON.stringify(built.weights ?? {})}`);
    }

    await mongoose.disconnect();
};

run().catch((err) => {
    console.error("Repair failed:", err.message);
    process.exit(1);
});
