import "dotenv/config";
import express from "express";
import connectDB from "./config/db.js";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import compression from "compression";
import indexRoutes from "./routes/index.js";
import categoryBannerRoutes from "./routes/categoryBannerRoutes.js";
import { globalLimiter } from "./middlewares/rateLimiter.js";
import AppError from "./utils/AppError.js";

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const isProduction = process.env.NODE_ENV === "production";

// Trust reverse proxy (Nginx) for accurate IP resolution in rate-limiting
app.set("trust proxy", 1);

// Security headers (X-Content-Type-Options, HSTS, frame guarding, etc.)
app.use(helmet());

app.use(compression());

const allowedOrigins = [
    "http://localhost:3000",

    "https://linen-saree.vercel.app",

    "https://handloomer.com",
    "https://www.handloomer.com",

    "https://linensaree.in",
    "https://www.linensaree.in",

    "https://sareeghar.com",
    "https://www.sareeghar.com",
];

// CORS Configuration
app.use(
    cors({
        origin: (origin, callback) => {
            console.log("Incoming Origin:", origin);

            // Allow requests with no origin
            // (Postman, curl, server-to-server requests)
            if (!origin) {
                return callback(null, true);
            }

            // Allow localhost and local network during development ONLY.
            // In production these wildcards are a credential-theft surface.
            if (!isProduction) {
                if (
                    origin.startsWith("http://localhost:") ||
                    origin.startsWith("http://127.0.0.1:") ||
                    origin.startsWith("http://192.168.") ||
                    origin.startsWith("http://10.") ||
                    origin.startsWith("http://172.")
                ) {
                    return callback(null, true);
                }
            }

            // Allow configured origins
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }

            // Allow Vercel preview deployments during development only
            if (!isProduction && origin.endsWith(".vercel.app")) {
                return callback(null, true);
            }

            console.log("Blocked Origin:", origin);

            return callback(
                new Error(`Not allowed by CORS: ${origin}`)
            );
        },

        credentials: true,

        methods: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
        ],

        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "X-Requested-With",
        ],
    })
);

// Keep the exact unparsed bytes on req.rawBody — required by the Razorpay
// webhook to verify its signature against the true payload.
app.use(express.json({
    limit: "50mb",
    verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// Apply global rate limiter
app.use("/api", globalLimiter);

// Serve uploads folder
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Health Check & Root Route
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Handloomer Backend API is live & running!",
        timestamp: new Date().toISOString(),
    });
});

app.get("/health", (req, res) => {
    res.json({ status: "healthy", uptime: process.uptime() });
});

// Routes
app.use("/api", indexRoutes);
app.use("/api/category-banner", categoryBannerRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
    console.error("[Global Error Handler]:", err);

    // Never leak internal error details (driver paths, validation internals) in production
    const isOperational = err instanceof AppError || err.statusCode;
    const message =
        !isProduction || isOperational
            ? err.message || "Internal server error"
            : "Something went wrong. Please try again.";

    res.status(err.statusCode || 500).json({
        success: false,
        message,
    });
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
    try {
        await connectDB();

        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Server startup failed:", error);
    }
};

startServer();