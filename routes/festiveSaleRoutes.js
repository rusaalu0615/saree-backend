import express from "express";
import { getFestiveSale, updateFestiveSale } from "../controllers/festiveSaleController.js";
import upload from "../middlewares/uploadImage.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";

const router = express.Router();

// GET festive sale settings (Public)
router.get("/", getFestiveSale);

// UPDATE festive sale settings (Admin)
router.put("/", adminProtect, upload.single('image'), updateFestiveSale);

export default router;
