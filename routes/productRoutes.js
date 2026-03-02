import express from "express";
import productController from "../controllers/productController.js";
import upLoadImage from "../middlewares/uploadImage.js";
import upLoadVideo from "../middlewares/uploadVedio.js";

const { addProduct, getAllProducts, getProductById, deleteProduct, updateProduct } = productController;

const router = express.Router();

router.post("/add-product", upLoadImage.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "galleryImages", maxCount: 10 },
]), addProduct);

router.put("/update/:id", upLoadImage.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "galleryImages", maxCount: 10 },
]), updateProduct);

router.put("/upload-video/:id", upLoadVideo.single("videoFile"), async (req, res) => {
    try {
        const { id } = req.params;
        const videoFile = req.file?.path || null;
        if (!videoFile) {
            return res.status(400).json({ success: false, message: "Video file is required" });
        }
        const { default: productModal } = await import("../modal/productModal.js");
        const product = await productModal.findByIdAndUpdate(id, { videoFile }, { new: true });
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        res.status(200).json({ success: true, message: "Video uploaded successfully", product });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
});

router.get("/allproducts", getAllProducts);
router.get("/:id", getProductById);
router.delete("/:id", deleteProduct);

export default router;
