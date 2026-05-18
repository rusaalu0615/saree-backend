import express from "express";
import orderController from "../controllers/orderController.js";
import { protect } from "../middlewares/authMiddleware.js";

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
} = orderController;

// Public route — track by orderId + email (no login needed)
router.post("/track-public", trackOrderPublic);

// Authenticated customer routes
router.post("/", protect, createOrder);
router.get("/my-orders", protect, getUserOrders);
router.get("/:id", protect, getOrderById);
router.get("/:id/track", protect, trackOrder);

// Admin routes (uses same protect middleware — role check can be added later)
router.get("/admin/all", getAllOrders);
router.put("/admin/:id/status", updateOrderStatus);
router.post("/admin/:id/cancel", cancelOrder);

export default router;
