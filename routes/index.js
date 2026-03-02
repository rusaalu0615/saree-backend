import express from "express";
import categoryRoutes from "./categoryRoutes.js";
import productRoutes from "./productRoutes.js";
import blogRoutes from "./blogRoutes.js";
const router = express.Router();

router.use("/category", categoryRoutes);
router.use("/product", productRoutes);
router.use("/blog", blogRoutes);

export default router;