import express from "express";
import categoryController from "../controllers/categoryController.js";
import upLoadImage from "../middlewares/uploadImage.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";
import validate from "../middlewares/validate.js";
import { addCategorySchema } from "../validations/schemas.js";

const { addCategory, deleteCategory, getAllCategory, updateCategory } = categoryController;

const router = express.Router();

router.post("/add-category", adminProtect, upLoadImage.single("image"), validate(addCategorySchema), addCategory);
router.put("/:id", adminProtect, upLoadImage.single("image"), updateCategory);
router.delete("/:id", adminProtect, deleteCategory);
router.get("/allcategory", getAllCategory);

export default router;