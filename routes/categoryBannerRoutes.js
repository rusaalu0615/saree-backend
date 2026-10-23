import express from "express";
import upLoadImage from "../middlewares/uploadImage.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";
import { 
    getCategoryBannerBySlug, 
    getAllCategoryBanners, 
    upsertCategoryBanner 
} from "../controllers/categoryBannerController.js";

const router = express.Router();

// Public routes
router.get("/all", getAllCategoryBanners);
router.get("/:slug", getCategoryBannerBySlug);

// Admin route to upsert a category banner
router.post("/", adminProtect, upLoadImage.single("image"), upsertCategoryBanner);

export default router;
