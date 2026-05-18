import express from "express";
import categoryController from "../controllers/categoryController.js";
import upLoadImage from "../middlewares/uploadImage.js";

const { addCategory, deleteCategory, getAllCategory, updateCategory } = categoryController;

const router = express.Router();

router.post("/add-category", upLoadImage.single("image"), addCategory);
router.put("/:id", upLoadImage.single("image"), updateCategory);
router.delete("/:id", deleteCategory);
router.get("/allcategory", getAllCategory);

export default router;