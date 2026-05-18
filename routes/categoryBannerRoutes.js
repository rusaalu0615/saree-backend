import express from "express";
import upLoadImage from "../middlewares/uploadImage.js";
import { 
    getCategoryBannerBySlug, 
    getAllCategoryBanners, 
    upsertCategoryBanner 
} from "../controllers/categoryBannerController.js";

const router = express.Router();

// Public routes
router.get("/all", getAllCategoryBanners);
router.get("/:slug", getCategoryBannerBySlug);

// Protected routes (Add auth middleware later if needed)
router.post("/", upLoadImage.single("image"), upsertCategoryBanner);

export default router;
