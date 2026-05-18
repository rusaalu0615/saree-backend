import express from "express"
import { getHero, addHeroSlide, deleteHeroSlide } from "../controllers/heroController.js"
import upload from "../middlewares/uploadImage.js"

const router = express.Router()

// Public route to fetch hero slides
router.get("/", getHero)

// Admin routes to manage hero slides
router.post("/", upload.single('image'), addHeroSlide)
router.delete("/:slideId", deleteHeroSlide)

export default router
