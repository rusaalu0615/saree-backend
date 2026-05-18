import express from "express";
import wishlistController from "../controllers/wishlistController.js";
import { protect } from "../middlewares/authMiddleware.js";

const router = express.Router();

// All wishlist routes are protected
router.use(protect);

router.get("/", wishlistController.getWishlist);
router.post("/add", wishlistController.addToWishlist);
router.post("/sync", wishlistController.syncWishlist);
router.delete("/clear", wishlistController.clearWishlist);
router.delete("/:productId", wishlistController.removeFromWishlist);

export default router;
