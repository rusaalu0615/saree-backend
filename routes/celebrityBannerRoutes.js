import express from "express";
import { getCelebrityBanner, upsertCelebrityBanner } from "../controllers/celebrityBannerController.js";
import upload from "../middlewares/uploadImage.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";

const router = express.Router();

router.route("/")
    .get(getCelebrityBanner)
    .post(adminProtect, upload.single("image"), upsertCelebrityBanner);

export default router;
