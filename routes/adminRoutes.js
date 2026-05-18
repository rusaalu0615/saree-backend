import express from "express";
import adminController from "../controllers/adminController.js";

const router = express.Router();

const {
    getDashboardStats,
    getRevenueChart,
    getSalesChart,
    getCustomers,
    getRecentOrders,
} = adminController;

// All admin routes require authentication
// TODO: Add admin role check middleware
router.get("/stats", getDashboardStats);
router.get("/revenue-chart", getRevenueChart);
router.get("/sales-chart", getSalesChart);
router.get("/customers", getCustomers);
router.get("/recent-orders", getRecentOrders);

export default router;
