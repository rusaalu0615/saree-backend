import AppError from "../utils/AppError.js";

/**
 * Gate-only Zod validation middleware.
 *
 * Parses req[target] against `schema`. On failure it forwards a 400 AppError
 * whose message joins every field issue ("email: Email is required. phone: ...").
 * On success it deliberately does NOT overwrite the request payload — the
 * downstream controller still receives the raw body and applies its own
 * normalization (trim/lowercase/Number/etc).
 *
 * This makes the layer purely additive: it can only reject clearly-invalid
 * input earlier and with clearer messages, never change an existing
 * happy-path request. That is why schemas are kept no stricter than the
 * validation each controller already performs.
 *
 * @param {import("zod").ZodType} schema
 * @param {"body"|"query"|"params"} target
 */
const validate = (schema, target = "body") => (req, _res, next) => {
    const parsed = schema.safeParse(req[target] ?? {});
    if (!parsed.success) {
        const message = parsed.error.issues
            .map((issue) =>
                issue.path.length
                    ? `${issue.path.join(".")}: ${issue.message}`
                    : issue.message
            )
            .join(". ");
        return next(new AppError(message || "Invalid request data", 400));
    }
    next();
};

export default validate;
