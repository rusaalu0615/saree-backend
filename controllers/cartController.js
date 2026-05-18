import User from "../models/userModal.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";

// GET /api/cart — Get user's cart with populated product data
const getCart = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id)
        .populate('cart.productId')
        .select('cart');

    if (!user) throw new AppError("User not found", 404);

    res.status(200).json({
        success: true,
        cart: user.cart,
    });
});

// POST /api/cart/add — Add item to cart (or increment quantity)
const addToCart = asyncHandler(async (req, res) => {
    const { productId, quantity = 1 } = req.body;

    if (!productId) throw new AppError("Product ID is required", 400);

    const user = await User.findById(req.user._id);
    if (!user) throw new AppError("User not found", 404);

    const existingIndex = user.cart.findIndex(
        (item) => item.productId.toString() === productId
    );

    if (existingIndex > -1) {
        user.cart[existingIndex].quantity += quantity;
    } else {
        user.cart.push({ productId, quantity });
    }

    await user.save();

    const updatedUser = await User.findById(req.user._id)
        .populate('cart.productId')
        .select('cart');

    res.status(200).json({
        success: true,
        cart: updatedUser.cart,
    });
});

// PUT /api/cart/update — Update item quantity
const updateCartItem = asyncHandler(async (req, res) => {
    const { productId, quantity } = req.body;

    if (!productId) throw new AppError("Product ID is required", 400);
    if (quantity === undefined) throw new AppError("Quantity is required", 400);

    const user = await User.findById(req.user._id);
    if (!user) throw new AppError("User not found", 404);

    if (quantity <= 0) {
        // Remove item if quantity is 0 or less
        user.cart = user.cart.filter(
            (item) => item.productId.toString() !== productId
        );
    } else {
        const item = user.cart.find(
            (item) => item.productId.toString() === productId
        );
        if (item) {
            item.quantity = quantity;
        }
    }

    await user.save();

    const updatedUser = await User.findById(req.user._id)
        .populate('cart.productId')
        .select('cart');

    res.status(200).json({
        success: true,
        cart: updatedUser.cart,
    });
});

// DELETE /api/cart/:productId — Remove item from cart
const removeFromCart = asyncHandler(async (req, res) => {
    const { productId } = req.params;

    const user = await User.findById(req.user._id);
    if (!user) throw new AppError("User not found", 404);

    user.cart = user.cart.filter(
        (item) => item.productId.toString() !== productId
    );

    await user.save();

    const updatedUser = await User.findById(req.user._id)
        .populate('cart.productId')
        .select('cart');

    res.status(200).json({
        success: true,
        cart: updatedUser.cart,
    });
});

// DELETE /api/cart — Clear entire cart
const clearCart = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
    if (!user) throw new AppError("User not found", 404);

    user.cart = [];
    await user.save();

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

    const user = await User.findById(req.user._id);
    if (!user) throw new AppError("User not found", 404);

    // Merge: for each guest item, add to server cart or increase quantity
    for (const guestItem of items) {
        if (!guestItem.productId) continue;

        const existingIndex = user.cart.findIndex(
            (item) => item.productId.toString() === guestItem.productId
        );

        if (existingIndex > -1) {
            // Take the higher quantity (don't lose server data)
            user.cart[existingIndex].quantity = Math.max(
                user.cart[existingIndex].quantity,
                guestItem.quantity || 1
            );
        } else {
            user.cart.push({
                productId: guestItem.productId,
                quantity: guestItem.quantity || 1,
            });
        }
    }

    await user.save();

    const updatedUser = await User.findById(req.user._id)
        .populate('cart.productId')
        .select('cart');

    res.status(200).json({
        success: true,
        cart: updatedUser.cart,
    });
});

export default { getCart, addToCart, updateCartItem, removeFromCart, clearCart, syncCart };
