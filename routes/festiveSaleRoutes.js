import express from "express";
import { getFestiveSale, updateFestiveSale } from "../controllers/festiveSaleController.js";
import upload from "../middlewares/uploadImage.js";

const router = express.Router();

// GET festive sale settings (Public)
router.get("/", getFestiveSale);

// UPDATE festive sale settings (Admin)
router.put("/", upload.single('image'), updateFestiveSale);

export default router;
