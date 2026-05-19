import express from "express";
import categoryController from "../controllers/categoryController.js";
import upLoadImage from "../middlewares/uploadImage.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";

const { addCategory, deleteCategory, getAllCategory, updateCategory } = categoryController;

const router = express.Router();

router.post("/add-category", adminProtect, upLoadImage.single("image"), addCategory);
router.put("/:id", adminProtect, upLoadImage.single("image"), updateCategory);
router.delete("/:id", adminProtect, deleteCategory);
router.get("/allcategory", getAllCategory);

export default router;