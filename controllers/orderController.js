import mongoose from "mongoose";
import crypto from "crypto";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import User from "../models/userModal.js";
import Coupon from "../models/couponModal.js";
import shiprocket from "../services/shiprocket.js";
import emailService from "../services/emailService.js";
import invoiceService from "../services/invoiceService.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import razorpayInstance from "../config/razorpay.js";

// ============================================================
// CUSTOMER ENDPOINTS
// ============================================================

/**
 * POST /api/order — Place a new order
 * Body: { items, shippingAddress, paymentMethod, couponCode, discount }
 */
const createOrder = asyncHandler(async (req, res) => {
    const { items, shippingAddress, paymentMethod, couponCode, discount: discountAmount } = req.body;
    console.log("[createOrder] Received req.body.paymentMethod:", paymentMethod);

    if (!items || items.length === 0) {
        throw new AppError("Order must contain at least one item", 400);
    }
    if (!shippingAddress) {
        throw new AppError("Shipping address is required", 400);
    }

    // Prepare a bulk write operation for checking and deducting stock
    const bulkOptions = items.map((item) => ({
        updateOne: {
            filter: { _id: item.productId || item.id, stock: { $gte: item.quantity } },
            update: { $inc: { stock: -item.quantity } }
        }
    }));

    const session = await mongoose.startSession();
    session.startTransaction();

    let order;

    try {
        // Attempt to deduct stock atomically for all items
        const bulkResult = await Product.bulkWrite(bulkOptions, { session });

        // If not all items were updated, some didn't have enough stock
        if (bulkResult.modifiedCount !== items.length) {
            throw new AppError("One or more items in your cart are out of stock. Please review your cart.", 400);
        }

        // Calculate pricing
        const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const shipping = subtotal >= 999 ? 0 : 199;
        const discount = discountAmount || 0;
        const total = subtotal + shipping - discount;

        // Determine User ID (Shadow Registration for Guests)
        let orderUserId;
        if (req.user) {
            orderUserId = req.user._id;
        } else {
            // Guest Checkout
            const guestEmail = shippingAddress.email.toLowerCase();
            let guestUser = await User.findOne({ email: guestEmail });
            
            if (!guestUser) {
                // Create new shadow user
                guestUser = new User({
                    name: `${shippingAddress.firstName} ${shippingAddress.lastName}`.trim(),
                    email: guestEmail,
                    phone: shippingAddress.phone,
                    password: crypto.randomBytes(8).toString('hex')
                });
                // DO NOT pass { session } here. Implicitly creating a collection inside a transaction throws InvalidNamespace.
                await guestUser.save();
            }
            orderUserId = guestUser._id;
        }

        // Create the order
        order = new Order({
            user: orderUserId,
            items: items.map((item) => ({
                productId: item.productId || item.id,
                name: item.name,
                slug: item.slug || item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, ''),
                price: item.price,
                quantity: item.quantity,
                image: item.image || "",
                sku: item.sku || "",
            })),
            shippingAddress: {
                firstName: shippingAddress.firstName,
                lastName: shippingAddress.lastName,
                email: shippingAddress.email,
                phone: shippingAddress.phone,
                address: shippingAddress.address,
                landmark: shippingAddress.landmark || "",
                city: shippingAddress.city,
                state: shippingAddress.state,
                pincode: shippingAddress.pincode,
            },
            payment: {
                method: paymentMethod || "cod",
                status: paymentMethod === "cod" ? "pending" : "pending",
            },
            pricing: {
                subtotal,
                shipping,
                discount,
                couponCode: couponCode || "",
                total,
            },
            status: "placed",
            timeline: [{ status: "Order Placed", description: "Your order has been placed successfully" }],
        });

        // Do not pass { session } here if the collection doesn't exist yet, it throws InvalidNamespace
        await order.save();

        // Commit the transaction since everything succeeded
        await session.commitTransaction();
        session.endSession();

        // Mark coupon as used if one was applied
        if (couponCode) {
            try {
                await Coupon.findOneAndUpdate(
                    { code: couponCode.toUpperCase() },
                    {
                        $inc: { usedCount: 1 },
                        $push: { usedBy: orderUserId }
                    }
                );
            } catch (couponErr) {
                console.error("Failed to update coupon usage:", couponErr);
            }
        }

        // Update user: Clear cart and save new address if not already present
        try {
            const user = await User.findById(orderUserId);
            if (user) {
                // 1. Clear cart
                user.cart = [];

                // 2. Extract and check address
                const newAddr = {
                    fullName: `${shippingAddress.firstName} ${shippingAddress.lastName}`.trim(),
                    mobile: shippingAddress.phone,
                    pincode: shippingAddress.pincode,
                    state: shippingAddress.state,
                    city: shippingAddress.city,
                    address: shippingAddress.address,
                    landmark: shippingAddress.landmark || "",
                };

                // Simple duplicate check (pincode + address + city)
                const isDuplicate = user.address.some(addr => 
                    addr.pincode === newAddr.pincode && 
                    addr.address.toLowerCase() === newAddr.address.toLowerCase() &&
                    addr.city.toLowerCase() === newAddr.city.toLowerCase()
                );

                if (!isDuplicate) {
                    user.address.push(newAddr);
                }

                await user.save();
            }
        } catch (updateErr) {
            console.error("Failed to update user profile after order:", updateErr);
        }

    } catch (error) {
        // Abort the transaction if anything fails (like stock deduction)
        await session.abortTransaction();
        session.endSession();
        throw error;
    }

    if (order.payment.method !== "cod") {
        if (!razorpayInstance) {
            throw new AppError("Payment gateway is not configured.", 500);
        }

        try {
            const options = {
                amount: Math.round(order.pricing.total * 100), // amount in smallest currency unit (paise)
                currency: "INR",
                receipt: order.orderId,
            };
            const rzpOrder = await razorpayInstance.orders.create(options);

            order.payment.razorpayOrderId = rzpOrder.id;
            await order.save();

            res.status(201).json({
                success: true,
                order: {
                    orderId: order.orderId,
                    _id: order._id,
                    status: order.status,
                    total: order.pricing.total,
                    razorpayOrderId: rzpOrder.id,
                    currency: rzpOrder.currency,
                    amount: rzpOrder.amount,
                    key: process.env.RAZORPAY_KEY_ID, // Send key back so frontend knows it (or frontend uses env)
                },
            });
            return;
        } catch (rzpErr) {
            console.error("Razorpay order creation failed:", rzpErr);
            throw new AppError("Failed to initiate payment. Please try again.", 500);
        }
    }

    // COD Flow: Push to Shiprocket (async — don't block the response)
    pushToShiprocket(order).catch((err) =>
        console.error(`Shiprocket push failed for order ${order.orderId}:`, err.message)
    );

    // Send order confirmation email with PDF invoice (async)
    console.log(`[Checkout] Starting email generation for order ${order.orderId}`);
    invoiceService.generateInvoicePDF(order)
        .then((pdfBuffer) => {
            console.log(`[Checkout] Invoice PDF generated for ${order.orderId}, passing to email service`);
            return emailService.sendOrderConfirmationEmail(order, pdfBuffer);
        })
        .then(() => console.log(`[Checkout] Confirmation email process completed for ${order.orderId}`))
        .catch((err) => {
            console.error(`[Checkout Error] Email confirmation sequence failed for ${order.orderId}:`);
            console.dir(err);
        });

    res.status(201).json({
        success: true,
        order: {
            orderId: order.orderId,
            _id: order._id,
            status: order.status,
            total: order.pricing.total,
        },
    });
});

/**
 * POST /api/order/verify-payment — Verify Razorpay Payment
 */
const verifyPayment = asyncHandler(async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    const order = await Order.findOne({ orderId });
    if (!order) throw new AppError("Order not found", 404);

    const generatedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest("hex");

    if (generatedSignature !== razorpay_signature) {
        order.payment.status = "failed";
        await order.save();
        throw new AppError("Payment verification failed", 400);
    }

    order.payment.status = "paid";
    order.payment.razorpayPaymentId = razorpay_payment_id;
    order.payment.razorpaySignature = razorpay_signature;
    order.timeline.push({
        status: "Payment Successful",
        description: `Payment verified via Razorpay`,
    });
    
    await order.save();

    // Now push to shiprocket and send email
    pushToShiprocket(order).catch((err) =>
        console.error(`Shiprocket push failed for order ${order.orderId}:`, err.message)
    );

    invoiceService.generateInvoicePDF(order)
        .then((pdfBuffer) => emailService.sendOrderConfirmationEmail(order, pdfBuffer))
        .catch((err) => console.error(`[Checkout Error] Email confirmation sequence failed for ${order.orderId}:`, err));

    res.status(200).json({ success: true, message: "Payment verified successfully" });
});

/**
 * Push order to Shiprocket and update DB with tracking info
 */
async function pushToShiprocket(order) {
    try {
        // Create order in Shiprocket
        const srResult = await shiprocket.createShiprocketOrder(order);

        if (srResult.order_id && srResult.shipment_id) {
            order.shiprocket.orderId = srResult.order_id;
            order.shiprocket.shipmentId = srResult.shipment_id;
            order.shiprocket.status = srResult.status;
            order.status = "confirmed";
            order.timeline.push({
                status: "Order Confirmed",
                description: "Order confirmed and sent to shipping partner",
            });

            // Try to auto-assign courier
            const courierResult = await shiprocket.assignCourier(srResult.shipment_id, {
                pickupPincode: process.env.SHIPROCKET_PICKUP_PINCODE || "",
                deliveryPincode: order.shippingAddress.pincode,
                weight: 0.5,
                isCOD: order.payment.method === "cod",
            });

            if (courierResult) {
                order.shiprocket.courierName = courierResult.courierName;
                order.shiprocket.courierCompanyId = courierResult.courierCompanyId;
                if (courierResult.awbCode) {
                    order.shiprocket.awbCode = courierResult.awbCode;
                    order.shiprocket.trackingUrl = `https://shiprocket.co/tracking/${courierResult.awbCode}`;
                }
            }

            // Generate pickup
            try {
                await shiprocket.generatePickup(srResult.shipment_id);
            } catch (pickupErr) {
                console.error("Pickup generation failed:", pickupErr.message);
            }

            await order.save();
        }
    } catch (err) {
        console.error("Shiprocket integration error:", err.message);
        // Order stays as "placed" — admin can manually push later
    }
}

/**
 * GET /api/order/my-orders — Get authenticated user's orders
 */
const getUserOrders = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
        Order.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select("-__v"),
        Order.countDocuments({ user: req.user._id }),
    ]);

    res.status(200).json({
        success: true,
        orders,
        pagination: {
            page,
            limit,
            totalCount: total,
            totalPages: Math.ceil(total / limit),
        },
    });
});

/**
 * GET /api/order/:id — Get single order details
 */
const getOrderById = asyncHandler(async (req, res) => {
    const order = await Order.findOne({
        _id: req.params.id,
        user: req.user._id,
    }).populate("items.productId", "name mainImage");

    if (!order) throw new AppError("Order not found", 404);

    res.status(200).json({ success: true, order });
});

/**
 * GET /api/order/:id/track — Get live tracking from Shiprocket
 */
const trackOrder = asyncHandler(async (req, res) => {
    const order = await Order.findOne({
        _id: req.params.id,
        user: req.user._id,
    });

    if (!order) throw new AppError("Order not found", 404);

    let tracking = null;

    // Try AWB tracking first (most accurate)
    if (order.shiprocket.awbCode) {
        try {
            tracking = await shiprocket.trackByAWB(order.shiprocket.awbCode);
        } catch (err) {
            console.error("AWB tracking failed:", err.message);
        }
    }

    // Fallback to Shiprocket order ID tracking
    if (!tracking && order.shiprocket.orderId) {
        try {
            tracking = await shiprocket.trackByShiprocketOrderId(order.shiprocket.orderId);
        } catch (err) {
            console.error("Order ID tracking failed:", err.message);
        }
    }

    res.status(200).json({
        success: true,
        order: {
            orderId: order.orderId,
            status: order.status,
            shiprocket: order.shiprocket,
            timeline: order.timeline,
        },
        tracking,
    });
});

/**
 * POST /api/order/track-public — Track by orderId + email (no auth required)
 */
const trackOrderPublic = asyncHandler(async (req, res) => {
    const { orderId, email } = req.body;

    if (!orderId || !email) {
        throw new AppError("Order ID and email are required", 400);
    }

    const order = await Order.findOne({
        orderId: orderId.toUpperCase(),
        "shippingAddress.email": email.toLowerCase(),
    });

    if (!order) {
        throw new AppError("Order not found. Please check your Order ID and email.", 404);
    }

    let tracking = null;

    if (order.shiprocket.awbCode) {
        try {
            tracking = await shiprocket.trackByAWB(order.shiprocket.awbCode);
        } catch (err) {
            console.error("Public AWB tracking failed:", err.message);
        }
    }

    res.status(200).json({
        success: true,
        order: {
            orderId: order.orderId,
            status: order.status,
            items: order.items,
            pricing: order.pricing,
            shiprocket: {
                courierName: order.shiprocket.courierName,
                awbCode: order.shiprocket.awbCode,
                trackingUrl: order.shiprocket.trackingUrl,
                status: order.shiprocket.status,
            },
            timeline: order.timeline,
            estimatedDelivery: null, // Shiprocket tracking data has this
        },
        tracking,
    });
});

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

/**
 * GET /api/order/admin/all — All orders (admin)
 */
const getAllOrders = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const status = req.query.status;

    const filter = {};
    if (status) filter.status = status;

    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate("user", "name email phone")
            .select("-__v"),
        Order.countDocuments(filter),
    ]);

    res.status(200).json({
        success: true,
        orders,
        pagination: {
            page,
            limit,
            totalCount: total,
            totalPages: Math.ceil(total / limit),
        },
    });
});

/**
 * PUT /api/order/admin/:id/status — Update order status (admin)
 */
const updateOrderStatus = asyncHandler(async (req, res) => {
    const { status, description } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found", 404);

    order.status = status;
    order.timeline.push({
        status: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " "),
        description: description || `Order status updated to ${status}`,
    });

    await order.save();

    // Send shipping update email if applicable (async)
    if (status === "shipped" || status === "in_transit" || status === "out_for_delivery" || status === "delivered") {
        emailService.sendShippingUpdateEmail(order, status).catch((err) =>
            console.error(`Status update email failed for ${order.orderId}:`, err)
        );
    }

    res.status(200).json({ success: true, order });
});

/**
 * POST /api/order/admin/:id/cancel — Cancel order (admin)
 */
const cancelOrder = asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found", 404);

    if (order.shiprocket.orderId) {
        try {
            await shiprocket.cancelShiprocketOrder(order.shiprocket.orderId);
        } catch (err) {
            console.error("Shiprocket cancel failed:", err.message);
        }
    }

    order.status = "cancelled";
    order.timeline.push({
        status: "Cancelled",
        description: req.body.reason || "Order cancelled by admin",
    });

    await order.save();

    res.status(200).json({ success: true, order });
});

export default {
    createOrder,
    getUserOrders,
    getOrderById,
    trackOrder,
    trackOrderPublic,
    getAllOrders,
    updateOrderStatus,
    cancelOrder,
    verifyPayment,
};
