import Order from "../models/orderModal.js";
import User from "../models/userModal.js";
import Product from "../models/productModal.js";
import asyncHandler from "../utils/asyncHandler.js";

// ============================================================
// DASHBOARD STATS
// ============================================================

/**
 * GET /api/admin/stats — Dashboard overview stats
 * Returns: total revenue, order count, customer count, product stats
 */
const getDashboardStats = asyncHandler(async (req, res) => {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    // Run all queries in parallel for speed
    const [
        totalRevenue,
        thisMonthRevenue,
        lastMonthRevenue,
        totalOrders,
        thisMonthOrders,
        lastMonthOrders,
        activeOrders,
        totalCustomers,
        thisMonthCustomers,
        totalProducts,
        lowStockProducts,
        outOfStockProducts,
    ] = await Promise.all([
        // Revenue
        Order.aggregate([
            { $match: { status: { $ne: "cancelled" } } },
            { $group: { _id: null, total: { $sum: "$pricing.total" } } },
        ]),
        Order.aggregate([
            { $match: { createdAt: { $gte: thisMonthStart }, status: { $ne: "cancelled" } } },
            { $group: { _id: null, total: { $sum: "$pricing.total" } } },
        ]),
        Order.aggregate([
            { $match: { createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd }, status: { $ne: "cancelled" } } },
            { $group: { _id: null, total: { $sum: "$pricing.total" } } },
        ]),
        // Orders
        Order.countDocuments(),
        Order.countDocuments({ createdAt: { $gte: thisMonthStart } }),
        Order.countDocuments({ createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd } }),
        Order.countDocuments({ status: { $in: ["placed", "confirmed", "processing", "shipped", "in_transit", "out_for_delivery"] } }),
        // Customers
        User.countDocuments(),
        User.countDocuments({ createdAt: { $gte: thisMonthStart } }),
        // Products
        Product.countDocuments(),
        Product.countDocuments({ stock: { $gt: 0, $lte: 10 } }),
        Product.countDocuments({ stock: 0 }),
    ]);

    const totalRev = totalRevenue[0]?.total || 0;
    const thisMonthRev = thisMonthRevenue[0]?.total || 0;
    const lastMonthRev = lastMonthRevenue[0]?.total || 0;
    const revenueGrowth = lastMonthRev > 0
        ? (((thisMonthRev - lastMonthRev) / lastMonthRev) * 100).toFixed(1)
        : thisMonthRev > 0 ? "100" : "0";

    const orderGrowth = lastMonthOrders > 0
        ? (((thisMonthOrders - lastMonthOrders) / lastMonthOrders) * 100).toFixed(1)
        : thisMonthOrders > 0 ? "100" : "0";

    res.status(200).json({
        success: true,
        stats: {
            revenue: {
                total: totalRev,
                thisMonth: thisMonthRev,
                growth: parseFloat(revenueGrowth),
            },
            orders: {
                total: totalOrders,
                active: activeOrders,
                thisMonth: thisMonthOrders,
                growth: parseFloat(orderGrowth),
            },
            customers: {
                total: totalCustomers,
                newThisMonth: thisMonthCustomers,
            },
            products: {
                total: totalProducts,
                lowStock: lowStockProducts,
                outOfStock: outOfStockProducts,
            },
        },
    });
});

/**
 * GET /api/admin/revenue-chart — Monthly revenue data for charts
 * Returns: array of { name: "Jan", total: 12000 } for last 12 months
 */
const getRevenueChart = asyncHandler(async (req, res) => {
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const monthlyRevenue = await Order.aggregate([
        {
            $match: {
                createdAt: { $gte: twelveMonthsAgo },
                status: { $ne: "cancelled" },
            },
        },
        {
            $group: {
                _id: {
                    year: { $year: "$createdAt" },
                    month: { $month: "$createdAt" },
                },
                total: { $sum: "$pricing.total" },
                count: { $sum: 1 },
            },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    // Fill in all 12 months (even empty ones)
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const chartData = [];

    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const year = d.getFullYear();
        const month = d.getMonth() + 1; // 1-indexed

        const found = monthlyRevenue.find(
            (r) => r._id.year === year && r._id.month === month
        );

        chartData.push({
            name: months[d.getMonth()],
            total: found ? found.total : 0,
            orders: found ? found.count : 0,
        });
    }

    res.status(200).json({ success: true, chartData });
});

/**
 * GET /api/admin/sales-chart — Daily sales for last 7 days
 */
const getSalesChart = asyncHandler(async (req, res) => {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const dailySales = await Order.aggregate([
        {
            $match: {
                createdAt: { $gte: sevenDaysAgo },
                status: { $ne: "cancelled" },
            },
        },
        {
            $group: {
                _id: {
                    year: { $year: "$createdAt" },
                    month: { $month: "$createdAt" },
                    day: { $dayOfMonth: "$createdAt" },
                },
                sales: { $sum: 1 },
                revenue: { $sum: "$pricing.total" },
            },
        },
        { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);

    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const chartData = [];

    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);

        const found = dailySales.find(
            (r) =>
                r._id.year === d.getFullYear() &&
                r._id.month === d.getMonth() + 1 &&
                r._id.day === d.getDate()
        );

        chartData.push({
            name: days[d.getDay()],
            sales: found ? found.sales : 0,
            revenue: found ? found.revenue : 0,
        });
    }

    res.status(200).json({ success: true, chartData });
});

// ============================================================
// CUSTOMERS
// ============================================================

/**
 * GET /api/admin/customers — List all customers with order stats
 * Query: ?page=1&limit=20&search=query
 */
const getCustomers = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const search = req.query.search || "";

    // Build search filter
    const filter = {};
    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { phone: { $regex: search, $options: "i" } },
        ];
    }

    const [users, total] = await Promise.all([
        User.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select("name email phone createdAt"),
        User.countDocuments(filter),
    ]);

    // Enrich with order stats using aggregation
    const userIds = users.map((u) => u._id);

    const orderStats = await Order.aggregate([
        { $match: { user: { $in: userIds }, status: { $ne: "cancelled" } } },
        {
            $group: {
                _id: "$user",
                totalOrders: { $sum: 1 },
                totalSpent: { $sum: "$pricing.total" },
                lastOrderDate: { $max: "$createdAt" },
            },
        },
    ]);

    // Build a map for fast lookup
    const statsMap = {};
    orderStats.forEach((s) => {
        statsMap[s._id.toString()] = s;
    });

    const customers = users.map((user) => {
        const stats = statsMap[user._id.toString()] || {};
        const totalSpent = stats.totalSpent || 0;
        const totalOrders = stats.totalOrders || 0;

        // Determine status based on order history
        let status = "inactive";
        if (totalOrders > 0) status = "active";
        if (totalSpent >= 10000) status = "vip";

        return {
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone || "",
            createdAt: user.createdAt,
            totalOrders,
            totalSpent,
            lastOrderDate: stats.lastOrderDate || null,
            status,
        };
    });

    // Customer summary stats
    const [totalCustomers, totalCustomerRevenue] = await Promise.all([
        User.countDocuments(),
        Order.aggregate([
            { $match: { status: { $ne: "cancelled" } } },
            { $group: { _id: null, total: { $sum: "$pricing.total" } } },
        ]),
    ]);

    const activeCount = customers.filter((c) => c.status !== "inactive").length;
    const vipCount = customers.filter((c) => c.status === "vip").length;

    res.status(200).json({
        success: true,
        customers,
        summary: {
            total: totalCustomers,
            active: activeCount,
            vip: vipCount,
            totalRevenue: totalCustomerRevenue[0]?.total || 0,
        },
        pagination: {
            page,
            limit,
            totalCount: total,
            totalPages: Math.ceil(total / limit),
        },
    });
});

/**
 * GET /api/admin/recent-orders — Last 5 orders for dashboard
 */
const getRecentOrders = asyncHandler(async (req, res) => {
    const orders = await Order.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("user", "name email")
        .select("orderId status pricing createdAt user items");

    res.status(200).json({ success: true, orders });
});

export default {
    getDashboardStats,
    getRevenueChart,
    getSalesChart,
    getCustomers,
    getRecentOrders,
};
