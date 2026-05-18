import express from "express";
import productController from "../controllers/productController.js";
import upLoadImage from "../middlewares/uploadImage.js";
import upLoadVideo from "../middlewares/uploadVideo.js";
import { protect } from "../middlewares/authMiddleware.js";

const { addProduct, getAllProducts, getProductById, deleteProduct, deleteMultipleProducts, updateProduct, updateGalleryImageInfo, uploadProductVideo, quickUpdateProduct } = productController;

const router = express.Router();

// Public routes
router.get("/allproducts", getAllProducts);
router.get("/:id", getProductById);

// Protected routes (require authentication)
router.post("/add-product", upLoadImage.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "galleryImages", maxCount: 10 },
    { name: "videoFile", maxCount: 1 },
]), addProduct);

router.put("/update/:id", protect, upLoadImage.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "galleryImages", maxCount: 10 },
    { name: "videoFile", maxCount: 1 },
]), updateProduct);

router.patch("/quick-update/:id", protect, quickUpdateProduct);

router.put("/upload-video/:id", protect, upLoadVideo.single("videoFile"), uploadProductVideo);

router.delete("/bulk-delete", protect, deleteMultipleProducts);
router.delete("/:id", protect, deleteProduct);
router.put("/:id/gallery-image-info", protect, updateGalleryImageInfo);

export default router;
