import express from "express";
import cartController from "../controllers/cartController.js";
import { protect } from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validate.js";
import { addToCartSchema, updateCartItemSchema, syncCartSchema } from "../validations/schemas.js";

const router = express.Router();

const { getCart, addToCart, updateCartItem, removeFromCart, clearCart, syncCart } = cartController;

// All cart routes require authentication
router.use(protect);

router.get("/", getCart);
router.post("/add", validate(addToCartSchema), addToCart);
router.put("/update", validate(updateCartItemSchema), updateCartItem);
router.post("/sync", validate(syncCartSchema), syncCart);
router.delete("/clear", clearCart);
router.delete("/:productId", removeFromCart);

export default router;
