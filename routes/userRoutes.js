import userController from "../controllers/userController.js";
import express from "express";
import { authLimiter } from "../middlewares/rateLimiter.js";

const router = express.Router();

router.post("/register", authLimiter, userController.registerUser);
router.post("/login", authLimiter, userController.loginUser);

export default router;