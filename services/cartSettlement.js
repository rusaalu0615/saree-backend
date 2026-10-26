/**
 * CART SETTLEMENT SERVICE — Durable, atomic cart settlement for ecommerce orders.
 *
 * Requirements:
 *  - Cart settlement plus an idempotency marker (cartSettled, cartSettledAt) on Order.
 *  - Atomic transactions: both user.cart mutation and Order.cartSettled commit together.
 *  - When session is supplied, participates in that session.
 *  - When called standalone, manages an internal MongoDB transaction session.
 *  - A transaction failure rolls back both cart and marker atomically.
 *  - Concurrent/repeated settlement becomes a safe no-op after one commit.
 *  - Guests NEVER mutate any registered user account's cart or addresses.
 *  - Historical orders (> 7 days old) are marked settled conservatively without mutating current user cart.
 *  - Quantity-accurate line deduction preserves items added post-purchase.
 */

import mongoose from "mongoose";
import Order from "../models/orderModal.js";
import User from "../models/userModal.js";

const HISTORICAL_ORDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Perform quantity-accurate cart subtraction on a user's cart array.
 * Returns the updated cart array without mutating other lines.
 */
export function calculateRemainingCart(currentCart = [], purchasedItems = []) {
    const need = new Map();
    for (const it of purchasedItems) {
        if (it?.productId) {
            const pid = String(it.productId._id || it.productId);
            const qty = Number(it.quantity) || 1;
            need.set(pid, (need.get(pid) || 0) + qty);
        }
    }

    if (need.size === 0) return currentCart;

    const nextCart = [];
    for (const line of currentCart) {
        const obj = line && line.toObject ? line.toObject({ versionKey: false }) : { ...line };
        const pid = String(obj.productId?._id || obj.productId);
        const remaining = need.get(pid) || 0;

        if (remaining <= 0) {
            nextCart.push(obj);
            continue;
        }

        const qty = Number(obj.quantity) || 1;
        const take = Math.min(remaining, qty);
        need.set(pid, remaining - take);

        const left = qty - take;
        if (left > 0) {
            nextCart.push({ ...obj, quantity: left });
        }
    }

    return nextCart;
}

/**
 * Core transactional settlement logic executed inside a transaction session.
 */
async function executeCartSettlementInSession(orderId, session) {
    // 1. Read fresh order inside transaction
    const currentOrder = await Order.findById(orderId).session(session);
    if (!currentOrder) {
        return { success: false, reason: "order_not_found" };
    }

    // 2. Fast idempotency check
    if (currentOrder.cartSettled) {
        return { success: true, alreadySettled: true, guest: !!currentOrder.isGuest, userSettled: false };
    }

    // 3. Historical order safety check: do not blindly wipe a customer's cart for ancient orders
    const isHistorical = currentOrder.createdAt && (Date.now() - new Date(currentOrder.createdAt).getTime() > HISTORICAL_ORDER_WINDOW_MS);
    if (isHistorical) {
        await Order.updateOne(
            { _id: currentOrder._id, cartSettled: { $ne: true } },
            { $set: { cartSettled: true, cartSettledAt: new Date() } },
            { session }
        );
        return { success: true, alreadySettled: false, guest: !!currentOrder.isGuest, userSettled: false, historical: true };
    }

    // 4. Guest orders: guests NEVER mutate any registered user account
    if (currentOrder.isGuest || !currentOrder.user) {
        await Order.updateOne(
            { _id: currentOrder._id, cartSettled: { $ne: true } },
            { $set: { cartSettled: true, cartSettledAt: new Date() } },
            { session }
        );
        return { success: true, alreadySettled: false, guest: true, userSettled: false };
    }

    // 5. Authenticated user: atomically mutate user cart & set cartSettled in same transaction
    const user = await User.findById(currentOrder.user).session(session);
    if (user && Array.isArray(user.cart)) {
        user.cart = calculateRemainingCart(user.cart, currentOrder.items || []);
        await user.save({ session });
    }

    await Order.updateOne(
        { _id: currentOrder._id, cartSettled: { $ne: true } },
        { $set: { cartSettled: true, cartSettledAt: new Date() } },
        { session }
    );

    return {
        success: true,
        alreadySettled: false,
        guest: false,
        userSettled: true,
    };
}

/**
 * Non-transactional fallback for environments where MongoDB replica set transactions
 * are not available (e.g. basic local development standalone mongod).
 */
async function executeCartSettlementStandalone(orderId) {
    const currentOrder = await Order.findById(orderId);
    if (!currentOrder) {
        return { success: false, reason: "order_not_found" };
    }

    if (currentOrder.cartSettled) {
        return { success: true, alreadySettled: true, guest: !!currentOrder.isGuest, userSettled: false };
    }

    if (currentOrder.isGuest || !currentOrder.user) {
        await Order.updateOne(
            { _id: currentOrder._id, cartSettled: { $ne: true } },
            { $set: { cartSettled: true, cartSettledAt: new Date() } }
        );
        return { success: true, alreadySettled: false, guest: true, userSettled: false };
    }

    const user = await User.findById(currentOrder.user);
    if (user && Array.isArray(user.cart)) {
        user.cart = calculateRemainingCart(user.cart, currentOrder.items || []);
        // Save user first — if this throws, cartSettled is NEVER committed!
        await user.save();
    }

    await Order.updateOne(
        { _id: currentOrder._id, cartSettled: { $ne: true } },
        { $set: { cartSettled: true, cartSettledAt: new Date() } }
    );

    return {
        success: true,
        alreadySettled: false,
        guest: false,
        userSettled: true,
    };
}

/**
 * Idempotently settle cart for an order.
 * Commits user cart mutation and cartSettled marker together atomically.
 *
 * @param {Object} order - Order document or plain object with _id, items, user, isGuest, cartSettled
 * @param {Object} options - { session, caller }
 * @returns {Promise<{ success: boolean, alreadySettled: boolean, guest: boolean, userSettled: boolean, error?: string }>}
 */
export async function settleCartAfterPayment(order, { session = null, caller = "system" } = {}) {
    if (!order || !order._id) {
        return { success: false, reason: "invalid_order" };
    }

    // 1. Fast idempotency check
    if (order.cartSettled) {
        return { success: true, alreadySettled: true, guest: !!order.isGuest, userSettled: false };
    }

    // 2. If caller provided an active session, participate in it directly
    if (session) {
        return executeCartSettlementInSession(order._id, session);
    }

    // 3. Standalone invocation: manage an internal transaction session
    let ownedSession = null;
    try {
        ownedSession = await mongoose.startSession();
        let result;
        await ownedSession.withTransaction(async () => {
            result = await executeCartSettlementInSession(order._id, ownedSession);
        });
        return result;
    } catch (txErr) {
        console.error(`[CartSettlement] Transaction failed for order ${order._id}:`, txErr?.message);
        throw txErr;
    } finally {
        if (ownedSession) {
            await ownedSession.endSession().catch(() => {});
        }
    }
}

/**
 * Apply COD / zero-payable cart settlement and saved address update.
 * Strictly enforces that ONLY verified authenticated requests (req.user)
 * can modify account cart/addresses. Guest orders are completely isolated.
 */
export async function applyCodCartAndAddress(order, shippingAddress, { session = null, isAuthenticated = false } = {}) {
    if (!order || !order._id) return { success: false, reason: "invalid_order" };

    // 1. If guest or unauthenticated, mark order settled and do not touch any user account
    if (order.isGuest || !isAuthenticated || !order.user) {
        await Order.updateOne(
            { _id: order._id, cartSettled: { $ne: true } },
            { $set: { cartSettled: true, cartSettledAt: new Date() } },
            { session: session || null }
        ).catch(() => {});
        return { success: true, settled: true, guest: true, skipped: true, reason: "guest-checkout" };
    }

    // 2. Authenticated user: settle cart and update address book in session
    const userQuery = User.findById(order.user);
    if (session) userQuery.session(session);
    const user = await userQuery;

    if (!user) {
        await Order.updateOne(
            { _id: order._id, cartSettled: { $ne: true } },
            { $set: { cartSettled: true, cartSettledAt: new Date() } },
            { session: session || null }
        ).catch(() => {});
        return { success: true, settled: true, guest: false, userSettled: false, reason: "user_not_found" };
    }

    user.cart = calculateRemainingCart(user.cart, order.items || []);

    if (shippingAddress) {
        const newAddr = {
            fullName: `${shippingAddress.firstName || ""} ${shippingAddress.lastName || ""}`.trim(),
            mobile: shippingAddress.phone,
            pincode: shippingAddress.pincode,
            state: shippingAddress.state,
            city: shippingAddress.city,
            address: shippingAddress.address,
            landmark: shippingAddress.landmark || "",
        };

        const isDuplicate = (user.address || []).some(
            (addr) =>
                addr.pincode === newAddr.pincode &&
                String(addr.address).toLowerCase() === newAddr.address.toLowerCase() &&
                String(addr.city).toLowerCase() === newAddr.city.toLowerCase()
        );

        if (!isDuplicate) {
            user.address = user.address || [];
            user.address.push(newAddr);
        }
    }

    if (session) {
        await user.save({ session });
    } else {
        await user.save();
    }

    await Order.updateOne(
        { _id: order._id, cartSettled: { $ne: true } },
        { $set: { cartSettled: true, cartSettledAt: new Date() } },
        { session: session || null }
    );
    return { success: true, settled: true, guest: false, userSettled: true };
}

export default {
    calculateRemainingCart,
    settleCartAfterPayment,
    applyCodCartAndAddress,
};
