import express from "express";
import { getFestiveBanner, updateFestiveBanner } from "../controllers/festiveBannerController.js";
import upload from "../middlewares/uploadImage.js";

const router = express.Router();

// GET festive banner settings (Public)
router.get("/", getFestiveBanner);

// UPDATE festive banner settings (Admin)
router.put("/", upload.single('image'), updateFestiveBanner);

export default router;
