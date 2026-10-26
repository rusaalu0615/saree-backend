import "dotenv/config";
import express from "express";
import connectDB from "./config/db.js";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import compression from "compression";
import indexRoutes from "./routes/index.js";
import categoryBannerRoutes from "./routes/categoryBannerRoutes.js";
import { startReservationSweeper } from "./services/reservationSweeper.js";
import { globalLimiter } from "./middlewares/rateLimiter.js";
import AppError from "./utils/AppError.js";
import { verifyDatabaseReadiness, getReadinessStatus } from "./config/indexReadiness.js";
import { verifyEmailConfig } from "./services/emailService.js";
import { csrfGuard } from "./middlewares/csrfGuard.js";

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

// CSRF guard: require the custom X-Requested-With header on state-changing
// requests (cookie auth is SameSite=None). Razorpay webhook is exempted inside.
app.use("/api", csrfGuard);

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

// Liveness probe (process is alive)
app.get("/health", (req, res) => {
    res.json({ status: "healthy", uptime: process.uptime() });
});

// Readiness probe (critical database uniqueness & collections verified)
app.get("/health/readiness", (req, res) => {
    const readiness = getReadinessStatus();
    if (!readiness.isReady) {
        return res.status(503).json({
            status: "not_ready",
            checkedAt: readiness.checkedAt,
            errors: readiness.errors,
            warnings: readiness.warnings,
        });
    }
    res.status(200).json({
        status: "ready",
        checkedAt: readiness.checkedAt,
        warnings: readiness.warnings,
    });
});

// Database readiness guard: gate business endpoints with 503 if critical uniqueness checks failed
app.use("/api", (req, res, next) => {
    const readiness = getReadinessStatus();
    if (!readiness.isReady) {
        return res.status(503).json({
            success: false,
            code: "DATABASE_NOT_READY",
            message: "The store database is currently preparing critical indexes or undergoing migration. Business operations are temporarily gated.",
            errors: !isProduction ? readiness.errors : undefined,
        });
    }
    next();
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
        const readiness = await verifyDatabaseReadiness();
        // Check email configuration (non-blocking for DB readiness)
        await verifyEmailConfig().catch((e) => console.warn("[Startup] Email config check:", e.message));

        if (!readiness.isReady) {
            console.error("[Startup] CRITICAL DATABASE READINESS CHECK FAILED:");
            readiness.errors.forEach((err) => console.error("  -", err));
            if (isProduction) {
                console.error("[Startup] Aborting startup in production because critical uniqueness constraints are missing.");
                process.exit(1);
            }
        }

        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
            // Do NOT start mutation workers against an unready database!
            if (readiness.isReady && process.env.ENABLE_SWEEPER !== "false") {
                startReservationSweeper();
            } else if (!readiness.isReady) {
                console.warn("[Startup] Reservation sweeper NOT started: database readiness checks failed.");
            }
        });
    } catch (error) {
        console.error("Server startup failed:", error);
        process.exit(1);
    }
};

startServer();