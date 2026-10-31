import express from "express";
import contactController from "../controllers/contactController.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";

const router = express.Router();

// Public submission
router.post("/", contactController.submitContactMessage);

// Admin review
router.get("/admin", adminProtect, contactController.getContactMessages);

export default router;

