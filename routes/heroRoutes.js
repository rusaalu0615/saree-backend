import express from "express"
import { getHero, addHeroSlide, updateHeroSlide, deleteHeroSlide } from "../controllers/heroController.js"
import upload from "../middlewares/uploadImage.js"
import { adminProtect } from "../middlewares/adminMiddleware.js"

const router = express.Router()

// Public route to fetch hero slides
router.get("/", getHero)

// Admin routes to manage hero slides
router.post("/", adminProtect, upload.single('image'), addHeroSlide)
router.put("/:slideId", adminProtect, upload.single('image'), updateHeroSlide)
router.delete("/:slideId", adminProtect, deleteHeroSlide)

export default router
