import express from "express";
import productController from "../controllers/productController.js";
import upLoadImage from "../middlewares/uploadImage.js";
import upLoadVideo from "../middlewares/uploadVideo.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";

const { addProduct, getAllProducts, getProductById, getProductBySku, deleteProduct, deleteMultipleProducts, updateProduct, updateGalleryImageInfo, uploadProductVideo, quickUpdateProduct, getFilters } = productController;

const router = express.Router();

// Public routes
router.get("/allproducts", getAllProducts);
router.get("/filters", getFilters);
router.get("/by-sku/:sku", getProductBySku);
router.get("/:id", getProductById);

// Protected Admin routes (require whitelisted Admin token)
router.post("/add-product", adminProtect, upLoadImage.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "galleryImages", maxCount: 10 },
    { name: "videoFile", maxCount: 1 },
]), addProduct);

router.put("/update/:id", adminProtect, upLoadImage.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "galleryImages", maxCount: 10 },
    { name: "videoFile", maxCount: 1 },
]), updateProduct);

router.patch("/quick-update/:id", adminProtect, quickUpdateProduct);

router.put("/upload-video/:id", adminProtect, upLoadVideo.single("videoFile"), uploadProductVideo);

router.delete("/bulk-delete", adminProtect, deleteMultipleProducts);
router.delete("/:id", adminProtect, deleteProduct);
router.put("/:id/gallery-image-info", adminProtect, updateGalleryImageInfo);

export default router;
