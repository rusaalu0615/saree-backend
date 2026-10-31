/**
 * Small, dependency-free security helpers shared across controllers.
 */
import crypto from "crypto";

// Escape user-supplied text before embedding it inside a RegExp so it cannot
// inject metacharacters (bypass the intended match) or a catastrophic
// backtracking pattern like "(a+)+" that would DoS the Mongo regex engine.
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Neutralize HTML/XSS injection characters
export const escapeHtml = (s) =>
    String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

/**
 * Timing-safe string comparison that CANNOT throw: both inputs are reduced to
 * fixed-length SHA-256 digests before crypto.timingSafeEqual, so malformed,
 * non-hex or unequal-length signatures return a controlled false instead of a
 * RangeError from timingSafeEqual's length assertion.
 */
export const safeCompare = (a, b) => {
    if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) {
        return false;
    }
    const hashA = crypto.createHash("sha256").update(a).digest();
    const hashB = crypto.createHash("sha256").update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
};

/**
 * One-way hash for capability tokens (guest checkout tokens). Only the hash
 * is persisted — a leaked DB row can never be replayed as a token.
 */
export const hashToken = (token) =>
    crypto.createHash("sha256").update(String(token)).digest("hex");

// Monetary helpers: all checkout math runs in INTEGER PAISE so float drift
// (0.1 + 0.2) can never create a cent-level mismatch against the gateway.
export const toPaise = (rupees) => Math.round(Number(rupees) * 100);
export const toRupees = (paise) => Math.round(Number(paise)) / 100;

// Keys that must never be written straight from a request body.
const FORBIDDEN_KEYS = new Set(["_id", "id", "__v", "createdAt", "updatedAt"]);

/**
 * Whitelist an update payload down to fields actually declared in the given
 * Mongoose model's schema. This blocks NoSQL-operator injection ($set, $where,
 * ...) and mass assignment of unknown/internal fields. Dotted keys are dropped
 * (no nested/partial writes), and prototype-pollution keys are ignored.
 *
 * @param {import("mongoose").Model} model
 * @param {object} body           req.body to filter
 * @param {string[]} extraAllowed additional top-level keys to permit
 * @returns {object} a safe shallow copy containing only allowed fields
 */
export function pickSchemaFields(model, body = {}, extraAllowed = []) {
    const allowed = new Set([...Object.keys(model.schema.paths), ...extraAllowed]);
    const out = {};
    for (const [key, value] of Object.entries(body)) {
        if (
            key.startsWith("$") ||
            key.includes(".") ||
            key === "__proto__" ||
            key === "constructor" ||
            key === "prototype" ||
            FORBIDDEN_KEYS.has(key) ||
            !allowed.has(key)
        ) {
            continue;
        }
        out[key] = value;
    }
    return out;
}

const SENSITIVE_KEY_PATTERN = /authorization|cookie|password|secret|checkoutToken|recoverySecret|token|otp|cvv|signature/i;

/**
 * Deep redaction of sensitive operational data for safe logging.
 */
export function redactSensitiveData(obj, depth = 0) {
    if (depth > 5 || !obj) return obj;
    if (typeof obj !== "object") return obj;

    if (Array.isArray(obj)) {
        return obj.map((item) => redactSensitiveData(item, depth + 1));
    }

    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE_KEY_PATTERN.test(k)) {
            out[k] = "[REDACTED]";
        } else if (v && typeof v === "object") {
            out[k] = redactSensitiveData(v, depth + 1);
        } else {
            out[k] = v;
        }
    }
    return out;
}
