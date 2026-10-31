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
    cancelUserOrder,
    adminRefundOrder,
    adminPushToShiprocket,
    verifyPayment,
    handleRazorpayWebhook,
    checkDeliveryServiceability,
    codReconcileOrder,
    confirmReturnOrder,
    resolveHoldOrder,
    handleShiprocketWebhook,
} = orderController;

// Razorpay server-to-server webhook — verified by HMAC signature, no JWT.
// MUST stay before the "/:id" style routes so it is never shadowed.
router.post("/webhook", handleRazorpayWebhook);

// Shiprocket tracking webhook
router.post("/shiprocket-webhook", handleShiprocketWebhook);

// Public route — check PIN code delivery & COD serviceability
router.get("/check-serviceability", checkDeliveryServiceability);

// Public route — track by orderId + email (no login needed)
router.post("/track-public", trackOrderPublic);

// Authenticated / Guest customer routes
router.post("/", optionalProtect, createOrder);
router.post("/verify-payment", optionalProtect, verifyPayment);
router.get("/my-orders", protect, getUserOrders);
router.get("/:id", protect, getOrderById);
router.post("/:id/cancel", protect, cancelUserOrder);
router.get("/:id/track", protect, trackOrder);

// Admin routes (require whitelisted admin token)
router.get("/admin/all", adminProtect, getAllOrders);
router.put("/admin/:id/status", adminProtect, updateOrderStatus);
router.post("/admin/:id/cancel", adminProtect, cancelOrder);
router.post("/admin/:id/refund", adminProtect, adminRefundOrder);
router.post("/admin/:id/push-shiprocket", adminProtect, adminPushToShiprocket);
router.post("/admin/:id/cod-reconcile", adminProtect, codReconcileOrder);
router.post("/admin/:id/confirm-return", adminProtect, confirmReturnOrder);
router.post("/admin/:id/resolve-hold", adminProtect, resolveHoldOrder);

export default router;
