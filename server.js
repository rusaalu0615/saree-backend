import "dotenv/config";
import express from "express";
import connectDB from "./config/db.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import indexRoutes from "./routes/index.js";
import categoryBannerRoutes from "./routes/categoryBannerRoutes.js";
import { globalLimiter } from "./middlewares/rateLimiter.js";

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express()

const allowedOrigins = [
    "https://linen-saree.vercel.app",
    "http://localhost:3000",
    "https://www.linen-saree.vercel.app"
];

// Dynamic origin CORS support allowing credentials
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        // Allow local network IPs for mobile testing during development
        if (
            origin.startsWith("http://localhost:") || 
            origin.startsWith("http://127.0.0.1:") ||
            origin.startsWith("http://192.168.") ||
            origin.startsWith("http://10.") ||
            origin.startsWith("http://172.")
        ) {
            return callback(null, true);
        }

        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
})

// Apply global rate limiter to all api routes
app.use("/api", globalLimiter);

// Serve uploads folder
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use("/api", indexRoutes);
app.use("/api/category-banner", categoryBannerRoutes);

// Global JSON Error Handler
app.use((err, req, res, next) => {
    console.error("[Global Error Handler]:", err);

    res.status(err.statusCode || 500).json({
        success: false,
        message: err.message || "Internal server error"
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