import Order from "../models/orderModal.js";
import User from "../models/userModal.js";
import Product from "../models/productModal.js";
import asyncHandler from "../utils/asyncHandler.js";
import { escapeRegex } from "../utils/security.js";

// ============================================================
// DASHBOARD STATS
// ============================================================

/**
 * Helper to compute accounting metrics for an order filter match
 */
const buildAccountingPipeline = (matchFilter = {}) => [
    { $match: matchFilter },
    {
        $facet: {
            // 1. Gross Order Value: total of non-cancelled orders
            gross: [
                { $match: { status: { $ne: "cancelled" } } },
                { $group: { _id: null, total: { $sum: "$pricing.total" } } },
            ],
            // 2. Captured Prepaid: prepaid orders where payment was captured
            prepaid: [
                {
                    $match: {
                        "payment.method": { $ne: "cod" },
                        "payment.status": { $in: ["paid", "refunded"] },
                    },
                },
                {
                    $group: {
                        _id: null,
                        total: {
                            $sum: {
                                $ifNull: [
                                    "$payment.amountPaid",
                                    {
                                        $ifNull: [
                                            { $divide: ["$payment.amount", 100] },
                                            "$pricing.total",
                                        ],
                                    },
                                ],
                            },
                        },
                    },
                },
            ],
            // 3. Confirmed COD Collected: COD orders collected at delivery
            codCollected: [
                {
                    $match: {
                        "payment.method": "cod",
                        $or: [
                            { "codAccounting.collectedAtDelivery": true },
                            { "payment.status": "paid" },
                        ],
                    },
                },
                {
                    $group: {
                        _id: null,
                        total: {
                            $sum: {
                                $cond: [
                                    { $gt: [{ $ifNull: ["$codAccounting.collectedAmountPaise", 0] }, 0] },
                                    { $divide: ["$codAccounting.collectedAmountPaise", 100] },
                                    "$pricing.total",
                                ],
                            },
                        },
                    },
                },
            ],
            // 4. Processed Refunds: refunds actually processed
            refunds: [
                {
                    $match: {
                        $or: [
                            { "payment.refundedAmount": { $gt: 0 } },
                            { "refund.status": "processed" },
                        ],
                    },
                },
                {
                    $group: {
                        _id: null,
                        total: {
                            $sum: {
                                $cond: [
                                    { $gt: [{ $ifNull: ["$payment.refundedAmount", 0] }, 0] },
                                    "$payment.refundedAmount",
                                    {
                                        $cond: [
                                            { $eq: ["$refund.status", "processed"] },
                                            { $divide: [{ $ifNull: ["$refund.amountPaise", 0] }, 100] },
                                            0,
                                        ],
                                    },
                                ],
                            },
                        },
                    },
                },
            ],
            // 5. COD Receivable / Remittance Pending: cash collected from customer, awaiting courier payout
            codReceivable: [
                {
                    $match: {
                        "payment.method": "cod",
                        "codAccounting.remittanceStatus": "pending",
                    },
                },
                {
                    $group: {
                        _id: null,
                        total: {
                            $sum: {
                                $cond: [
                                    { $gt: [{ $ifNull: ["$codAccounting.amountDuePaise", 0] }, 0] },
                                    { $divide: ["$codAccounting.amountDuePaise", 100] },
                                    "$pricing.total",
                                ],
                            },
                        },
                    },
                },
            ],
        },
    },
];

const extractAccounting = (facetResult) => {
    const gross = facetResult?.gross?.[0]?.total || 0;
    const prepaid = facetResult?.prepaid?.[0]?.total || 0;
    const cod = facetResult?.codCollected?.[0]?.total || 0;
    const refunds = facetResult?.refunds?.[0]?.total || 0;
    const codReceivable = facetResult?.codReceivable?.[0]?.total || 0;
    const netCollected = Math.max(0, prepaid + cod - refunds);

    return {
        grossOrderValue: Math.round(gross * 100) / 100,
        capturedPrepaid: Math.round(prepaid * 100) / 100,
        confirmedCodCollected: Math.round(cod * 100) / 100,
        processedRefunds: Math.round(refunds * 100) / 100,
        netCollectedAmount: Math.round(netCollected * 100) / 100,
        codRemittancePending: Math.round(codReceivable * 100) / 100,
    };
};

/**
 * GET /api/admin/stats — Dashboard overview stats
 * Distinguishes Gross Order Value from Net Collected Amount
 */
const getDashboardStats = asyncHandler(async (req, res) => {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [
        allTimeFinancials,
        thisMonthFinancials,
        lastMonthFinancials,
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
        Order.aggregate(buildAccountingPipeline({})),
        Order.aggregate(buildAccountingPipeline({ createdAt: { $gte: thisMonthStart } })),
        Order.aggregate(buildAccountingPipeline({ createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd } })),
        Order.countDocuments(),
        Order.countDocuments({ createdAt: { $gte: thisMonthStart } }),
        Order.countDocuments({ createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd } }),
        Order.countDocuments({
            status: { $in: ["placed", "confirmed", "processing", "shipped", "in_transit", "out_for_delivery"] },
        }),
        User.countDocuments(),
        User.countDocuments({ createdAt: { $gte: thisMonthStart } }),
        Product.countDocuments(),
        Product.countDocuments({ stock: { $gt: 0, $lte: 10 } }),
        Product.countDocuments({ stock: 0 }),
    ]);

    const allTime = extractAccounting(allTimeFinancials[0]);
    const thisMonth = extractAccounting(thisMonthFinancials[0]);
    const lastMonth = extractAccounting(lastMonthFinancials[0]);

    const revenueGrowth = lastMonth.netCollectedAmount > 0
        ? (((thisMonth.netCollectedAmount - lastMonth.netCollectedAmount) / lastMonth.netCollectedAmount) * 100).toFixed(1)
        : thisMonth.netCollectedAmount > 0 ? "100" : "0";

    const orderGrowth = lastMonthOrders > 0
        ? (((thisMonthOrders - lastMonthOrders) / lastMonthOrders) * 100).toFixed(1)
        : thisMonthOrders > 0 ? "100" : "0";

    res.status(200).json({
        success: true,
        stats: {
            revenue: {
                total: allTime.netCollectedAmount,
                thisMonth: thisMonth.netCollectedAmount,
                growth: parseFloat(revenueGrowth),
            },
            financials: allTime,
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
 * Based on collected net revenue
 */
const getRevenueChart = asyncHandler(async (req, res) => {
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const monthlyRevenue = await Order.aggregate([
        {
            $match: {
                createdAt: { $gte: twelveMonthsAgo },
                status: { $ne: "cancelled" },
                $or: [
                    { "payment.method": { $ne: "cod" }, "payment.status": { $in: ["paid", "refunded"] } },
                    { "payment.method": "cod", "codAccounting.collectedAtDelivery": true },
                    { "payment.method": "cod", "payment.status": "paid" },
                ],
            },
        },
        {
            $group: {
                _id: {
                    year: { $year: "$createdAt" },
                    month: { $month: "$createdAt" },
                },
                total: {
                    $sum: {
                        $subtract: [
                            { $ifNull: ["$payment.amountPaid", "$pricing.total"] },
                            { $ifNull: ["$payment.refundedAmount", 0] },
                        ],
                    },
                },
                count: { $sum: 1 },
            },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

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
            total: found ? Math.max(0, Math.round(found.total * 100) / 100) : 0,
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
                $or: [
                    { "payment.method": { $ne: "cod" }, "payment.status": { $in: ["paid", "refunded"] } },
                    { "payment.method": "cod", "codAccounting.collectedAtDelivery": true },
                    { "payment.method": "cod", "payment.status": "paid" },
                ],
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
                revenue: {
                    $sum: {
                        $subtract: [
                            { $ifNull: ["$payment.amountPaid", "$pricing.total"] },
                            { $ifNull: ["$payment.refundedAmount", 0] },
                        ],
                    },
                },
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
            revenue: found ? Math.max(0, Math.round(found.revenue * 100) / 100) : 0,
        });
    }

    res.status(200).json({ success: true, chartData });
});

// ============================================================
// CUSTOMERS
// ============================================================

/**
 * GET /api/admin/customers — List all customers with collected order stats
 * Query: ?page=1&limit=20&search=query
 */
const getCustomers = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const rawSearch = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const search = escapeRegex(rawSearch);

    const filter = {};
    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { phone: { $regex: search, $options: "i" } },
        ];
    }

    // 1. Fetch paginated users and total matching users
    const [users, totalMatchingUsers] = await Promise.all([
        User.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select("name email phone createdAt")
            .lean(),
        User.countDocuments(filter),
    ]);

    const userIds = users.map((u) => u._id);

    // 2. Fetch order stats for these users based on collected spend
    const orderStats = await Order.aggregate([
        {
            $match: {
                user: { $in: userIds },
                status: { $ne: "cancelled" },
                $or: [
                    { "payment.method": { $ne: "cod" }, "payment.status": { $in: ["paid", "refunded"] } },
                    { "payment.method": "cod", "codAccounting.collectedAtDelivery": true },
                    { "payment.method": "cod", "payment.status": "paid" },
                ],
            },
        },
        {
            $group: {
                _id: "$user",
                totalOrders: { $sum: 1 },
                totalSpent: {
                    $sum: {
                        $subtract: [
                            { $ifNull: ["$payment.amountPaid", "$pricing.total"] },
                            { $ifNull: ["$payment.refundedAmount", 0] },
                        ],
                    },
                },
                lastOrderDate: { $max: "$createdAt" },
            },
        },
    ]);

    const statsMap = {};
    orderStats.forEach((s) => {
        statsMap[s._id.toString()] = s;
    });

    const customers = users.map((user) => {
        const stats = statsMap[user._id.toString()] || {};
        const totalSpent = Math.max(0, stats.totalSpent || 0);
        const totalOrders = stats.totalOrders || 0;

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
            totalSpent: Math.round(totalSpent * 100) / 100,
            lastOrderDate: stats.lastOrderDate || null,
            status,
        };
    });

    // 3. Compute global customer summary across the full database (not just the current page)
    const [totalCustomersGlobal, globalOrderStats] = await Promise.all([
        User.countDocuments(),
        Order.aggregate([
            {
                $match: {
                    user: { $ne: null },
                    status: { $ne: "cancelled" },
                    $or: [
                        { "payment.method": { $ne: "cod" }, "payment.status": { $in: ["paid", "refunded"] } },
                        { "payment.method": "cod", "codAccounting.collectedAtDelivery": true },
                        { "payment.method": "cod", "payment.status": "paid" },
                    ],
                },
            },
            {
                $group: {
                    _id: "$user",
                    totalSpent: {
                        $sum: {
                            $subtract: [
                                { $ifNull: ["$payment.amountPaid", "$pricing.total"] },
                                { $ifNull: ["$payment.refundedAmount", 0] },
                            ],
                        },
                    },
                    orderCount: { $sum: 1 },
                },
            },
        ]),
    ]);

    let activeCount = 0;
    let vipCount = 0;
    let totalCollectedRevenue = 0;

    for (const stat of globalOrderStats) {
        if (stat.orderCount > 0) activeCount++;
        const spent = Math.max(0, stat.totalSpent || 0);
        if (spent >= 10000) vipCount++;
        totalCollectedRevenue += spent;
    }

    res.status(200).json({
        success: true,
        customers,
        summary: {
            total: totalCustomersGlobal,
            active: activeCount,
            vip: vipCount,
            totalRevenue: Math.round(totalCollectedRevenue * 100) / 100,
        },
        pagination: {
            page,
            limit,
            totalCount: totalMatchingUsers,
            totalPages: Math.max(1, Math.ceil(totalMatchingUsers / limit)),
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
