import express from "express";
import categoryController from "../controllers/categorisController.js";
import upLoadImage from "../middlewares/uploadImage.js";

const { addCategory, deletCategory, getAllCategory, updateCategory } = categoryController;

const router = express.Router();

router.post("/add-category", upLoadImage.single("image"), addCategory);
router.put("/:id", upLoadImage.single("image"), updateCategory);
router.delete("/:id", deletCategory);
router.get("/allcategory", getAllCategory);

export default router;