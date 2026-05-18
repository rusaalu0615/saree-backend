import "dotenv/config";
import express from "express";
import connectDB from "./config/db.js";
import cors from "cors";
import indexRoutes from "./routes/index.js";
import categoryBannerRoutes from "./routes/categoryBannerRoutes.js";

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express()

app.use(cors())
app.use(express.json())
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
})
// Serve uploads folder
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

connectDB()

app.use("/api", indexRoutes)
app.use("/api/category-banner", categoryBannerRoutes)

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
})