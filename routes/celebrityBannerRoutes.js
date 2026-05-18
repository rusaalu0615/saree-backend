import express from "express";
import { getCelebrityBanner, upsertCelebrityBanner } from "../controllers/celebrityBannerController.js";
import upload from "../middlewares/uploadImage.js";

const router = express.Router();

router.route("/")
    .get(getCelebrityBanner)
    .post(upload.single("image"), upsertCelebrityBanner);

export default router;
