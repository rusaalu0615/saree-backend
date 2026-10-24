import express from "express";
import upLoadImage from "../middlewares/uploadImage.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";
import validate from "../middlewares/validate.js";
import { upsertCategoryBannerSchema } from "../validations/schemas.js";
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
router.post("/", adminProtect, upLoadImage.single("image"), validate(upsertCategoryBannerSchema), upsertCategoryBanner);

export default router;
