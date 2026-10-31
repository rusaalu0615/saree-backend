import mongoose from "mongoose";
import User from "../models/userModal.js";
import Product from "../models/productModal.js";
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
    let user = await cartProjectionQuery(req.user._id);

    if (!user) throw new AppError("User not found", 404);

    // Identify and clean orphaned lines where the product was deleted from DB
    const deadLineIds = user.cart.filter((item) => !item.productId).map((item) => item._id);
    if (deadLineIds.length > 0) {
        await User.updateOne(
            { _id: req.user._id },
            { $pull: { cart: { _id: { $in: deadLineIds } } } }
        );
        user = await cartProjectionQuery(req.user._id);
    }

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

    // Strict integer quantity validation (reject null, undefined, strings, fractions, out-of-range)
    if (
        quantity === null ||
        quantity === undefined ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > MAX_QTY_PER_LINE
    ) {
        throw new AppError(`Quantity must be a whole number between 1 and ${MAX_QTY_PER_LINE}`, 400);
    }
    const qty = quantity;

    // Validate product existence
    const product = await Product.findById(productId).select("_id stock price");
    if (!product) {
        throw new AppError("Product not found or is no longer available", 404);
    }

    const pObjectId = new mongoose.Types.ObjectId(productId);

    // 1) Line exists and has room for full increment without exceeding max:
    // Uses $elemMatch on array elements (never positional placeholder in filter)
    let updated = await User.updateOne(
        {
            _id: req.user._id,
            cart: {
                $elemMatch: {
                    productId: pObjectId,
                    quantity: { $lte: MAX_QTY_PER_LINE - qty },
                },
            },
        },
        {
            $inc: { "cart.$[line].quantity": qty },
            $set: { "cart.$[line].updatedAt": new Date() },
        },
        { arrayFilters: [{ "line.productId": pObjectId }] }
    );

    // 2) Line exists but adding qty would exceed max:
    // Cap directly at MAX_QTY_PER_LINE in a single atomic update (prevents temporary overshoot)
    if (updated.matchedCount === 0) {
        updated = await User.updateOne(
            {
                _id: req.user._id,
                cart: {
                    $elemMatch: {
                        productId: pObjectId,
                        quantity: { $gt: MAX_QTY_PER_LINE - qty },
                    },
                },
            },
            {
                $set: {
                    "cart.$[line].quantity": MAX_QTY_PER_LINE,
                    "cart.$[line].updatedAt": new Date(),
                },
            },
            { arrayFilters: [{ "line.productId": pObjectId }] }
        );
    }

    // 3) Line absent → push it atomically with duplicate prevention
    if (updated.matchedCount === 0) {
        updated = await User.updateOne(
            { _id: req.user._id, "cart.productId": { $ne: pObjectId } },
            {
                $push: {
                    cart: {
                        productId: pObjectId,
                        quantity: Math.min(qty, MAX_QTY_PER_LINE),
                        updatedAt: new Date(),
                    },
                },
            }
        );
        if (updated.matchedCount === 0) {
            // Raced with another push — update existing line capped
            await User.updateOne(
                {
                    _id: req.user._id,
                    cart: {
                        $elemMatch: {
                            productId: pObjectId,
                            quantity: { $lte: MAX_QTY_PER_LINE - qty },
                        },
                    },
                },
                { $inc: { "cart.$[line].quantity": qty } },
                { arrayFilters: [{ "line.productId": pObjectId }] }
            );
        }
    }

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

    // Strict integer validation (reject null, NaN, strings, fractions)
    if (quantity === undefined || quantity === null || !Number.isInteger(quantity)) {
        throw new AppError("Quantity must be a valid whole number", 400);
    }

    const pObjectId = new mongoose.Types.ObjectId(productId);

    if (quantity <= 0) {
        // Remove item if quantity is 0 or less (preserve zero-means-remove contract)
        await User.updateOne(
            { _id: req.user._id },
            { $pull: { cart: { productId: pObjectId } } }
        );
    } else {
        const qty = Math.min(quantity, MAX_QTY_PER_LINE);
        // Conditional $set on the matching line — no full-doc round trip.
        const updated = await User.updateOne(
            { _id: req.user._id, "cart.productId": pObjectId },
            {
                $set: {
                    "cart.$[line].quantity": qty,
                    "cart.$[line].updatedAt": new Date(),
                },
            },
            { arrayFilters: [{ "line.productId": pObjectId }] }
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
    const rawClean = items
        .filter((i) => i && typeof i.productId === "string" && mongoose.Types.ObjectId.isValid(i.productId))
        .map((i) => ({
            productId: i.productId,
            quantity: Math.min(Math.max(Number.isInteger(i.quantity) ? i.quantity : 1, 1), MAX_QTY_PER_LINE),
        }));

    // Validate that products actually exist before syncing
    const productIds = rawClean.map((i) => i.productId);
    const existingProducts = await Product.find({ _id: { $in: productIds } }).select("_id");
    const existingIdSet = new Set(existingProducts.map((p) => p._id.toString()));

    const clean = rawClean.filter((i) => existingIdSet.has(i.productId));

    for (const guestItem of clean) {
        const pObjectId = new mongoose.Types.ObjectId(guestItem.productId);

        // Existing line with lower quantity → take the higher quantity using $elemMatch
        const bumped = await User.updateOne(
            {
                _id: req.user._id,
                cart: {
                    $elemMatch: {
                        productId: pObjectId,
                        quantity: { $lt: guestItem.quantity },
                    },
                },
            },
            {
                $set: {
                    "cart.$[line].quantity": guestItem.quantity,
                    "cart.$[line].updatedAt": new Date(),
                },
            },
            { arrayFilters: [{ "line.productId": pObjectId }] }
        );

        if (bumped.matchedCount === 0) {
            // Either line exists with >= guestItem.quantity, or doesn't exist yet
            const exists = await User.exists({
                _id: req.user._id,
                "cart.productId": pObjectId,
            });
            if (!exists) {
                await User.updateOne(
                    { _id: req.user._id, "cart.productId": { $ne: pObjectId } },
                    {
                        $push: {
                            cart: {
                                productId: pObjectId,
                                quantity: guestItem.quantity,
                                updatedAt: new Date(),
                            },
                        },
                    }
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
