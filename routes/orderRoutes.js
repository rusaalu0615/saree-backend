import express from "express";
import orderController from "../controllers/orderController.js";
import { protect, optionalProtect } from "../middlewares/authMiddleware.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";

const router = express.Router();

const {
    createOrder,
    getUserOrders,
    getOrderById,
    trackOrder,
    trackOrderPublic,
    getAllOrders,
    updateOrderStatus,
    cancelOrder,
    verifyPayment,
} = orderController;

// Public route — track by orderId + email (no login needed)
router.post("/track-public", trackOrderPublic);

// Authenticated / Guest customer routes
router.post("/", optionalProtect, createOrder);
router.post("/verify-payment", optionalProtect, verifyPayment);
router.get("/my-orders", protect, getUserOrders);
router.get("/:id", protect, getOrderById);
router.get("/:id/track", protect, trackOrder);

// Admin routes (require whitelisted admin token)
router.get("/admin/all", adminProtect, getAllOrders);
router.put("/admin/:id/status", adminProtect, updateOrderStatus);
router.post("/admin/:id/cancel", adminProtect, cancelOrder);

export default router;
