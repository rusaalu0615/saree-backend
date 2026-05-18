import Coupon from "../models/couponModal.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";

/**
 * POST /api/coupon/apply — User applies a coupon to cart
 * Body: { code: "SUMMER50", subtotal: 1500 }
 */
const applyCoupon = asyncHandler(async (req, res) => {
    const { code, subtotal } = req.body;

    if (!code || !subtotal) {
        throw new AppError("Coupon code and subtotal are required", 400);
    }

    const coupon = await Coupon.findOne({ code: code.toUpperCase() });
    if (!coupon) {
        throw new AppError("Invalid coupon code", 404);
    }

    if (!coupon.isValid()) {
        throw new AppError("This coupon is expired, inactive, or its usage limit has been reached", 400);
    }

    if (coupon.minPurchase > subtotal) {
        throw new AppError(`This coupon requires a minimum purchase of Rs. ${coupon.minPurchase}`, 400);
    }

    const userUsageCount = coupon.usedBy.filter(id => id.toString() === req.user._id.toString()).length;
    if (userUsageCount >= coupon.usageLimitPerUser) {
        throw new AppError(`You have reached the limit of ${coupon.usageLimitPerUser} use(s) for this coupon`, 400);
    }

    const discountAmount = coupon.calculateDiscount(subtotal);

    res.status(200).json({
        success: true,
        message: "Coupon applied successfully",
        coupon: {
            code: coupon.code,
            discountAmount,
        },
    });
});

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

/**
 * GET /api/coupon — List all coupons (Admin)
 */
const getCoupons = asyncHandler(async (req, res) => {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, coupons });
});

/**
 * POST /api/coupon — Create a new coupon (Admin)
 */
const createCoupon = asyncHandler(async (req, res) => {
    const {
        code,
        discountType,
        discountValue,
        minPurchase,
        usageLimit,
        usageLimitPerUser,
        expiryDate,
        isActive
    } = req.body;

    if (!code || !discountValue || !expiryDate) {
        throw new AppError("Code, discount value, and expiry date are required", 400);
    }

    const normalizedCode = code.toUpperCase().trim();

    const existing = await Coupon.findOne({ code: normalizedCode });
    if (existing) {
        throw new AppError("A coupon with this code already exists", 400);
    }

    const coupon = await Coupon.create({
        code: normalizedCode,
        discountType: discountType || "percentage",
        discountValue: parseFloat(discountValue),
        minPurchase: minPurchase ? parseFloat(minPurchase) : 0,
        usageLimit: usageLimit ? parseInt(usageLimit) : 100,
        usageLimitPerUser: usageLimitPerUser ? parseInt(usageLimitPerUser) : 1,
        expiryDate: new Date(expiryDate).toISOString(),
        isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json({ success: true, coupon });
});

/**
 * PUT /api/coupon/:id — Update a coupon (Admin)
 */
const updateCoupon = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
    });

    if (!coupon) throw new AppError("Coupon not found", 404);

    res.status(200).json({ success: true, coupon });
});

/**
 * DELETE /api/coupon/:id — Delete a coupon (Admin)
 */
const deleteCoupon = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) throw new AppError("Coupon not found", 404);

    res.status(200).json({ success: true, message: "Coupon deleted successfully" });
});

export default {
    applyCoupon,
    getCoupons,
    createCoupon,
    updateCoupon,
    deleteCoupon,
};
