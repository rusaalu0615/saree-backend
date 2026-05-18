import express from "express";
import cartController from "../controllers/cartController.js";
import { protect } from "../middlewares/authMiddleware.js";

const router = express.Router();

const { getCart, addToCart, updateCartItem, removeFromCart, clearCart, syncCart } = cartController;

// All cart routes require authentication
router.use(protect);

router.get("/", getCart);
router.post("/add", addToCart);
router.put("/update", updateCartItem);
router.post("/sync", syncCart);
router.delete("/clear", clearCart);
router.delete("/:productId", removeFromCart);

export default router;
