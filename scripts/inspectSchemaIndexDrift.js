/**
 * Read-only schema-vs-database INDEX DRIFT audit for every Mongoose model.
 *
 *   node scripts/inspectSchemaIndexDrift.js
 *
 * Why this exists: ProductTextIndex collided with a stale text index and that
 * made Model.init() reject, which 500-ed every checkout attempt while the
 * frontend reported a generic "could not confirm your order" toast. The same
 * class of drift can sit latent on any other collection — including MISSING
 * UNIQUE indexes, which silently remove a data-integrity guarantee (e.g. one
 * order per checkoutKey, one review per user+product).
 *
 * Makes no writes. Classifies each declared index as:
 *   OK              - present with the same key pattern and options
 *   MISSING         - never built (queries/integrity not protected)
 *   NAME-DRIFT      - same keys, different index name
 *   OPTIONS-DRIFT   - same name/keys but different options (unique/sparse/weights)
 * and flags any text index in the DB that is not the declared one (collision).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();
mongoose.set("autoIndex", false); // do not build anything while auditing

const here = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = path.join(here, "..", "models");

const keySig = (key) =>
    Object.entries(key || {})
        .map(([k, v]) => `${k}:${String(v)}`)
        .join(",");

// MongoDB stores EVERY text index under the synthetic key { _fts: "text",
// _ftsx: 1 } — the declared field names survive only in `weights`. So a text
// index can never be matched by key signature; it must be matched by name and
// compared by weights, or the audit reports a false MISSING.
const isTextKeys = (keys) =>
    Object.values(keys || {}).some((v) => String(v).toLowerCase() === "text");
const isTextIndex = (idx) => isTextKeys(idx.key) || !!idx.weights;
const weightsSig = (w) =>
    w ? JSON.stringify(Object.entries(w).sort((a, b) => (a[0] < b[0] ? -1 : 1))) : null;

// Mongoose's default index name, e.g. { a: "text", b: "text" } -> "a_text_b_text".
const generatedTextName = (keys) =>
    Object.entries(keys)
        .map(([k, v]) => `${k}_${v}`)
        .join("_");

// Options that must match for an index to be considered equivalent.
const optSig = (idx) =>
    JSON.stringify({
        unique: !!idx.unique,
        sparse: !!idx.sparse,
        background: !!idx.background,
        expireAfterSeconds: idx.expireAfterSeconds ?? null,
        weights: idx.weights ? Object.entries(idx.weights).sort() : null,
        partialFilterExpression: idx.partialFilterExpression
            ? JSON.stringify(idx.partialFilterExpression)
            : null,
    });

const declaredFor = (schema) => {
    // schema.indexes() -> [ [keys, options], ... ]
    return schema
        .indexes()
        .map(([keys, options = {}]) => ({ keys, options }));
};

const run = async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });

    const files = fs.readdirSync(modelsDir).filter((f) => f.endsWith(".js"));
    const report = [];

    for (const file of files) {
        try {
            await import(pathToFileURL(path.join(modelsDir, file)).href);
        } catch (err) {
            console.error(`! could not load ${file}: ${err.message}`);
        }
    }

    for (const name of Object.keys(mongoose.models)) {
        const model = mongoose.models[name];
        const collName = model.collection.collectionName;
        let actual = [];
        let collectionExists = true;
        try {
            actual = await model.collection.indexes();
        } catch (err) {
            if (err.code === 26 || err.codeName === "NamespaceNotFound") {
                collectionExists = false;
            } else {
                throw err;
            }
        }

        const declared = declaredFor(model.schema);
        const findings = [];

        for (const d of declared) {
            const wantKey = keySig(d.keys);
            const isText = isTextKeys(d.keys);
            const wantName = d.options.name || (isText ? generatedTextName(d.keys) : null);
            const wantWeights = weightsSig(d.options.weights);

            if (isText) {
                // Matched by NAME and compared by WEIGHTS — see the note above.
                const byName = actual.find((a) => isTextIndex(a) && a.name === wantName);
                if (!byName) {
                    findings.push({ kind: "MISSING", want: wantName, have: "-", detail: `no text index named "${wantName}" exists` });
                    continue;
                }
                if (weightsSig(byName.weights) !== wantWeights || optSig(byName) !== optSig(d.options)) {
                    findings.push({
                        kind: "OPTIONS-DRIFT",
                        want: wantName,
                        have: byName.name,
                        detail: `weights/options differ: declared=${wantWeights} actual=${weightsSig(byName.weights)}`,
                    });
                }
                continue;
            }

            const exact = actual.find(
                (a) => keySig(a.key) === wantKey && optSig(a) === optSig(d.options) && (!wantName || a.name === wantName)
            );
            if (exact) {
                continue;
            }
            const sameKey = actual.find((a) => keySig(a.key) === wantKey);
            if (sameKey) {
                findings.push({
                    kind: optSig(sameKey) === optSig(d.options) ? "NAME-DRIFT" : "OPTIONS-DRIFT",
                    want: wantName || wantKey,
                    have: sameKey.name,
                    detail:
                        optSig(sameKey) === optSig(d.options)
                            ? "keys+options match, name differs"
                            : `options differ: declared=${optSig(d.options)} actual=${optSig(sameKey)}`,
                });
            } else {
                findings.push({ kind: "MISSING", want: wantName || wantKey, have: "-", detail: `keys {${wantKey}} not built` });
            }
        }

        // Text-index collision detection (the bug that broke checkout).
        const declaredTextNames = declared.filter((d) => isTextKeys(d.keys)).map((d) => d.options.name || generatedTextName(d.keys));
        const staleText = actual.filter((a) => isTextIndex(a) && !declaredTextNames.includes(a.name));
        for (const s of staleText) {
            findings.push({
                kind: "TEXT-COLLISION",
                want: declaredTextNames.join(",") || "(none declared)",
                have: s.name,
                detail: "undeclared text index present — MongoDB allows one per collection, so the declared build would be rejected",
            });
        }

        report.push({ model: name, collName, collectionExists, declared: declared.length, actual: actual.length, findings });

        const status = findings.length === 0 ? "OK" : "DRIFT";
        console.log(`\n${status.padEnd(6)} ${name} (${collName}) — ${declared.length} declared / ${actual.length} in DB`);
        for (const f of findings) {
            console.log(`   • ${f.kind.padEnd(15)} declared=${f.want}  actual=${f.have}  ${f.detail}`);
        }
    }

    const drifted = report.filter((r) => r.findings.length > 0);
    console.log(`\n=== SUMMARY ===`);
    console.log(`collections audited: ${report.length}`);
    console.log(`with drift: ${drifted.length}`);
    for (const r of drifted) console.log(`   ${r.model}: ${r.findings.map((f) => f.kind).join(", ")}`);

    await mongoose.disconnect();
};

run().catch((err) => {
    console.error("Audit failed:", err.message);
    process.exit(1);
});
