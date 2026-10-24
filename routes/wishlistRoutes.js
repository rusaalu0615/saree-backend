import express from "express";
import wishlistController from "../controllers/wishlistController.js";
import { protect } from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validate.js";
import { addToWishlistSchema, syncWishlistSchema } from "../validations/schemas.js";

const router = express.Router();

// All wishlist routes are protected
router.use(protect);

router.get("/", wishlistController.getWishlist);
router.post("/add", validate(addToWishlistSchema), wishlistController.addToWishlist);
router.post("/sync", validate(syncWishlistSchema), wishlistController.syncWishlist);
router.delete("/clear", wishlistController.clearWishlist);
router.delete("/:productId", wishlistController.removeFromWishlist);

export default router;
