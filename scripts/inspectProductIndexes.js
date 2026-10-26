/**
 * Read-only: list the indexes MongoDB actually has on the products collection
 * and compare them with the ones declared in the Mongoose schema.
 *
 *   node scripts/inspectProductIndexes.js
 *
 * Makes no writes. Used to diagnose the checkout 500:
 * "An equivalent index already exists with a different name and options".
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const run = async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    const coll = mongoose.connection.collection("products");

    const actual = await coll.indexes();
    console.log(`\nIndex count: ${actual.length}\n`);
    for (const idx of actual) {
        const isText = Object.values(idx.key).some((v) => String(v).toLowerCase() === "text");
        console.log(
            `${isText ? "[TEXT] " : "       "} ${idx.name}` +
                (isText ? `\n         weights: ${JSON.stringify(idx.weights ?? {})}` : "") +
                `\n         key: ${JSON.stringify(idx.key)}`
        );
    }

    const textIndexes = actual.filter((i) =>
        Object.values(i.key).some((v) => String(v).toLowerCase() === "text")
    );
    console.log(`\nText indexes present: ${textIndexes.length} (MongoDB allows at most 1 per collection)`);
    console.log(`Declared in schema as: ProductTextIndex (name/category/tags/color/material/shortDescription)\n`);

    await mongoose.disconnect();
};

run().catch((err) => {
    console.error("Inspection failed:", err.message);
    process.exit(1);
});
