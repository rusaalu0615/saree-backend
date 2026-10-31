import express from "express";
import contactController from "../controllers/contactController.js";
import { protect, adminOnly } from "../middlewares/authMiddleware.js";

const router = express.Router();

// Public submission
router.post("/", contactController.submitContactMessage);

// Admin review
router.get("/admin", protect, adminOnly, contactController.getContactMessages);

export default router;

