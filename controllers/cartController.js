import mongoose from "mongoose";
import User from "../models/userModal.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";

// Cart mutations are ATOMIC conditional updates against the specific cart
// line — never a read-modify-save of the whole user doc, which lost or
// clobbered concurrent changes between devices/tabs. Every successful
// mutation returns the authoritative populated cart so clients reconcile.

const MAX_QTY_PER_LINE = 10;

function validProductId(productId) {
    if (typeof productId !== "string" || !mongoose.Types.ObjectId.isValid(productId)) {
        throw new AppError("Invalid product in your cart", 400);
    }
}

function cartProjectionQuery(userId) {
    return User.findById(userId).populate("cart.productId").select("cart");
}

// GET /api/cart — Get user's cart with populated product data
const getCart = asyncHandler(async (req, res) => {
    const user = await cartProjectionQuery(req.user._id);

    if (!user) throw new AppError("User not found", 404);

    res.status(200).json({
        success: true,
        cart: user.cart,
    });
});

// POST /api/cart/add — Add item to cart (or increment quantity) ATOMICALLY
const addToCart = asyncHandler(async (req, res) => {
    const { productId, quantity = 1 } = req.body;

    if (!productId) throw new AppError("Product ID is required", 400);
    validProductId(productId);
    const qty = Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QTY_PER_LINE
        ? quantity
        : 1;

    // 1) Atomic $inc on the existing line — concurrent adds can't clobber
    //    each other the way read-modify-save did.
    let updated = await User.updateOne(
        { _id: req.user._id, "cart.productId": productId },
        { $inc: { "cart.$[line].quantity": qty }, $set: { "cart.$[line].updatedAt": new Date() } },
        { arrayFilters: [{ "line.productId": new mongoose.Types.ObjectId(productId) }] }
    );

    // 2) Line absent → push it. Filtered updateOne with a size guard keeps a
    //    concurrent push from creating a duplicate line for the same product.
    if (updated.matchedCount === 0) {
        updated = await User.updateOne(
            { _id: req.user._id, $or: [{ cart: { $size: 0 } }, { "cart.productId": { $ne: productId } }] },
            { $push: { cart: { productId, quantity: qty } } }
        );
        if (updated.matchedCount === 0) {
            // Raced with another push — fall back to the atomic increment.
            await User.updateOne(
                { _id: req.user._id, "cart.productId": productId },
                { $inc: { "cart.$[line].quantity": qty } },
                { arrayFilters: [{ "line.productId": new mongoose.Types.ObjectId(productId) }] }
            );
        }
    }

    // Cap the line atomically at the allowed maximum.
    await User.updateOne(
        { _id: req.user._id, "cart.productId": productId, "cart.$[line].quantity": { $gt: MAX_QTY_PER_LINE } },
        { $set: { "cart.$[line].quantity": MAX_QTY_PER_LINE } },
        { arrayFilters: [{ "line.productId": new mongoose.Types.ObjectId(productId) }] }
    );

    const user = await cartProjectionQuery(req.user._id);
    if (!user) throw new AppError("User not found", 404);

    res.status(200).json({
        success: true,
        cart: user.cart,
    });
});

// PUT /api/cart/update — Set an ABSOLUTE quantity on one line, atomically
const updateCartItem = asyncHandler(async (req, res) => {
    const { productId, quantity } = req.body;

    if (!productId) throw new AppError("Product ID is required", 400);
    validProductId(productId);
    if (quantity === undefined) throw new AppError("Quantity is required", 400);

    if (quantity <= 0) {
        // Remove item if quantity is 0 or less — single atomic pull.
        await User.updateOne(
            { _id: req.user._id },
            { $pull: { cart: { productId: new mongoose.Types.ObjectId(productId) } } }
        );
    } else {
        const qty = Math.min(Number.isInteger(quantity) ? quantity : 1, MAX_QTY_PER_LINE);
        // Conditional $set on the matching line — no full-doc round trip.
        const updated = await User.updateOne(
            { _id: req.user._id, "cart.productId": productId },
            { $set: { "cart.$[line].quantity": qty } },
            { arrayFilters: [{ "line.productId": new mongoose.Types.ObjectId(productId) }] }
        );
        if (updated.matchedCount === 0) {
            throw new AppError("This item is no longer in your cart. Please refresh.", 409);
        }
    }

    const user = await cartProjectionQuery(req.user._id);
    if (!user) throw new AppError("User not found", 404);

    res.status(200).json({
        success: true,
        cart: user.cart,
    });
});

// DELETE /api/cart/:productId — Remove item from cart (atomic pull)
const removeFromCart = asyncHandler(async (req, res) => {
    const { productId } = req.params;
    validProductId(productId);

    await User.updateOne(
        { _id: req.user._id },
        { $pull: { cart: { productId: new mongoose.Types.ObjectId(productId) } } }
    );

    const user = await cartProjectionQuery(req.user._id);
    if (!user) throw new AppError("User not found", 404);

    res.status(200).json({
        success: true,
        cart: user.cart,
    });
});

// DELETE /api/cart — Clear entire cart (single atomic $set)
const clearCart = asyncHandler(async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $set: { cart: [] } });

    res.status(200).json({
        success: true,
        cart: [],
    });
});

// POST /api/cart/sync — Merge guest localStorage cart with server cart on login
// Body: { items: [{ productId: string, quantity: number }] }
const syncCart = asyncHandler(async (req, res) => {
    const { items } = req.body;

    if (!items || !Array.isArray(items)) {
        throw new AppError("Items array is required", 400);
    }

    // Clean the payload; per-line merge stays on the server so a stale client
    // copy can never overwrite the authoritative cart wholesale.
    const clean = items
        .filter((i) => i && typeof i.productId === "string" && mongoose.Types.ObjectId.isValid(i.productId))
        .map((i) => ({
            productId: i.productId,
            quantity: Math.min(Math.max(Number.isInteger(i.quantity) ? i.quantity : 1, 1), MAX_QTY_PER_LINE),
        }));

    for (const guestItem of clean) {
        // Existing line → take the higher quantity (never lose server data).
        const bumped = await User.updateOne(
            { _id: req.user._id, "cart.productId": guestItem.productId, "cart.$[line].quantity": { $lt: guestItem.quantity } },
            { $set: { "cart.$[line].quantity": guestItem.quantity } },
            { arrayFilters: [{ "line.productId": new mongoose.Types.ObjectId(guestItem.productId) }] }
        );
        if (bumped.modifiedCount === 0) {
            // Either the line exists with >= qty, or it doesn't exist yet.
            const exists = await User.exists({ _id: req.user._id, "cart.productId": guestItem.productId });
            if (!exists) {
                await User.updateOne(
                    { _id: req.user._id, "cart.productId": { $ne: guestItem.productId } },
                    { $push: { cart: { productId: guestItem.productId, quantity: guestItem.quantity } } }
                );
            }
        }
    }

    const user = await cartProjectionQuery(req.user._id);
    if (!user) throw new AppError("User not found", 404);

    res.status(200).json({
        success: true,
        cart: user.cart,
    });
});

export default { getCart, addToCart, updateCartItem, removeFromCart, clearCart, syncCart };
