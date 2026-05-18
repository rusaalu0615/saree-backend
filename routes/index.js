import express from "express";
import categoryRoutes from "./categoryRoutes.js";
import productRoutes from "./productRoutes.js";
import blogRoutes from "./blogRoutes.js";
import userRoutes from "./userRoutes.js";
import wishlistRoutes from "./wishlistRoutes.js";
import cartRoutes from "./cartRoutes.js";
import adminRoutes from "./adminRoutes.js";
import couponRoutes from "./couponRoutes.js";
import orderRoutes from "./orderRoutes.js";
import reviewRoutes from "./reviewRoutes.js";
import heroRoutes from "./heroRoutes.js";
import festiveSaleRoutes from "./festiveSaleRoutes.js";
import festiveBannerRoutes from "./festiveBannerRoutes.js";
import celebrityBannerRoutes from "./celebrityBannerRoutes.js";
import marketingCollectionRoutes from "./marketingCollectionRoutes.js";

const router = express.Router();

router.use("/category", categoryRoutes);
router.use("/product", productRoutes);
router.use("/blog", blogRoutes);
router.use("/user", userRoutes);
router.use("/wishlist", wishlistRoutes);
router.use("/cart", cartRoutes);
router.use("/admin", adminRoutes);
router.use("/coupon", couponRoutes);
router.use("/order", orderRoutes);
router.use("/review", reviewRoutes);
router.use("/hero", heroRoutes);
router.use("/festive-sale", festiveSaleRoutes);
router.use("/festive-banner", festiveBannerRoutes);
router.use("/celebrity-collection", celebrityBannerRoutes);
router.use("/marketing-collections", marketingCollectionRoutes);

export default router;