import rateLimit from "express-rate-limit";

// Global limiter: 100 requests per 15 minutes for general routes
export const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 150,
    limit: 150, // compatible with v6 and v7
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many requests from this IP, please try again after 15 minutes."
    }
});

// Stricter auth limiter: 15 requests per 10 minutes for brute-force sensitive routes
export const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 15,
    limit: 15, // compatible with v6 and v7
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many login or OTP attempts. Please wait 10 minutes before trying again."
    }
});
