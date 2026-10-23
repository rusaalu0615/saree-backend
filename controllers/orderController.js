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
    const { items, shippingAddress, paymentMethod, couponCode } = req.body;
    console.log("[createOrder] Received req.body.paymentMethod:", paymentMethod);

    if (!items || items.length === 0) {
        throw new AppError("Order must contain at least one item", 400);
    }
    if (!shippingAddress) {
        throw new AppError("Shipping address is required", 400);
    }

    // Fetch products from DB — source of truth for price/name/sku (never trust client prices)
    const productIds = items.map(item => item.productId || item.id);
    const dbProducts = await Product.find({ _id: { $in: productIds } });
    const priceMap = new Map(dbProducts.map(p => [p._id.toString(), p]));

    for (const item of items) {
        const pid = (item.productId || item.id || "").toString();
        if (!priceMap.has(pid)) {
            throw new AppError("One or more items in your cart are no longer available. Please review your cart.", 400);
        }
        if (!Number.isInteger(item.quantity) || item.quantity < 1) {
            throw new AppError("Invalid item quantity", 400);
        }
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

        // Calculate pricing entirely from DB prices
        const subtotal = items.reduce((sum, item) => {
            const dbProduct = priceMap.get((item.productId || item.id).toString());
            return sum + dbProduct.price * item.quantity;
        }, 0);
        const shipping = subtotal >= 999 ? 0 : 199;

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

        // Validate coupon server-side — discount is NEVER taken from the client
        let discount = 0;
        let appliedCouponCode = "";
        if (couponCode) {
            const coupon = await Coupon.findOne({ code: couponCode.toUpperCase() });
            if (!coupon || !coupon.isValid()) {
                throw new AppError("Coupon is invalid or has expired.", 400);
            }
            if (subtotal < coupon.minPurchase) {
                throw new AppError(`Minimum purchase of \u20b9${coupon.minPurchase} required for this coupon.`, 400);
            }
            const usedByUser = coupon.usedBy.filter(
                uid => uid.toString() === orderUserId.toString()
            ).length;
            if (usedByUser >= coupon.usageLimitPerUser) {
                throw new AppError("You have already used this coupon.", 400);
            }
            discount = coupon.calculateDiscount(subtotal);
            appliedCouponCode = coupon.code;
        }

        const total = Math.max(subtotal + shipping - discount, 0);

        // Create the order
        order = new Order({
            user: orderUserId,
            items: items.map((item) => {
                const dbProduct = priceMap.get((item.productId || item.id).toString());
                return {
                    productId: dbProduct._id,
                    name: dbProduct.name,
                    slug: dbProduct.slug || item.slug || dbProduct.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, ''),
                    price: dbProduct.price,
                    quantity: item.quantity,
                    image: item.image || dbProduct.image || "",
                    sku: dbProduct.sku || item.sku || "",
                };
            }),
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
                couponCode: appliedCouponCode,
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
        .then(() => {
            console.log(`[Checkout] Confirmation email process completed for ${order.orderId}`);
            return emailService.sendAdminOrderNotificationEmail(order);
        })
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
 * Timing-safe HMAC comparison that tolerates different-length inputs
 * (returns false instead of throwing like crypto.timingSafeEqual does).
 */
const safeCompare = (a, b) => {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        // Still burn a constant comparison so length isn't a timing signal
        crypto.timingSafeEqual(bufA, crypto.createHash("sha256").update("").digest());
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * POST /api/order/verify-payment — Verify Razorpay Payment
 */
const verifyPayment = asyncHandler(async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    const isPlainString = v => typeof v === "string" && v.length > 0 && v.length < 500;

    // Client-reported payment FAILURE (orderId only, no Razorpay triple): marks a
    // still-pending order as failed so it doesn't hang forever. Can never grant a
    // paid status, and an already-paid order is left completely untouched.
    if (isPlainString(orderId) && !razorpay_order_id && !razorpay_payment_id && !razorpay_signature) {
        const pendingOrder = await Order.findOne({ orderId });
        if (pendingOrder && pendingOrder.payment.status !== "paid") {
            pendingOrder.payment.status = "failed";
            pendingOrder.timeline.push({
                status: "Payment Failed",
                description: "Payment was not completed",
            });
            await pendingOrder.save();
        }
        throw new AppError("Payment verification failed", 400);
    }

    // 1. Every field must be a plain string — blocks NoSQL-operator payloads
    // and the undefined-cast HMAC footgun.
    if (![razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId].every(isPlainString)) {
        throw new AppError("Invalid payment verification payload", 400);
    }

    const order = await Order.findOne({ orderId });
    if (!order) throw new AppError("Order not found", 404);

    // 2. Idempotency: an already-verified order must not be re-processed
    // (double emails, double Shiprocket pushes, signature replay).
    if (order.payment.status === "paid") {
        return res.status(200).json({ success: true, message: "Payment already verified" });
    }

    // 3. THE LINK CHECK: the Razorpay order in the request MUST be the one this
    // DB order was created with. Without this, a valid signature for ANY cheap
    // paid order could be replayed to mark OTHER (unpaid) orders as paid.
    if (!order.payment.razorpayOrderId || order.payment.razorpayOrderId !== razorpay_order_id) {
        order.payment.status = "failed";
        await order.save();
        throw new AppError("Payment verification failed: order mismatch", 400);
    }

    if (!process.env.RAZORPAY_KEY_SECRET) {
        throw new AppError("Payment gateway is not configured.", 500);
    }

    const generatedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest("hex");

    // 4. Timing-safe comparison instead of plain !==
    if (!safeCompare(generatedSignature, razorpay_signature)) {
        order.payment.status = "failed";
        order.payment.razorpayPaymentId = razorpay_payment_id;
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

    await fulfillPaidOrder(order);

    res.status(200).json({ success: true, message: "Payment verified successfully" });
});

/**
 * Shared fulfillment for a confirmed-paid order: Shiprocket push + customer
 * invoice email + admin notification. Fire-and-forget inside so the payment
 * confirmation response is never blocked on shipping/email latency.
 */
async function fulfillPaidOrder(order) {
    pushToShiprocket(order).catch((err) =>
        console.error(`Shiprocket push failed for order ${order.orderId}:`, err.message)
    );

    invoiceService.generateInvoicePDF(order)
        .then((pdfBuffer) => emailService.sendOrderConfirmationEmail(order, pdfBuffer))
        .then(() => emailService.sendAdminOrderNotificationEmail(order))
        .catch((err) => console.error(`[Checkout Error] Email confirmation sequence failed for ${order.orderId}:`, err));
}

/**
 * POST /api/order/webhook — Razorpay server-to-server payment events.
 * This is the safety net: money captured at Razorpay is confirmed even if the
 * customer's browser dies before /verify-payment ever lands.
 */
const handleRazorpayWebhook = asyncHandler(async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
        console.error("[Webhook] RAZORPAY_WEBHOOK_SECRET is not configured — rejecting");
        return res.status(500).json({ message: "Webhook not configured" });
    }

    // 1. Authenticity: the body bytes must match Razorpay's HMAC signature
    const signature = req.headers["x-razorpay-signature"];
    const raw = req.rawBody;
    if (!signature || typeof signature !== "string" || !raw) {
        return res.status(400).json({ message: "Missing webhook signature" });
    }
    const expected = crypto.createHmac("sha256", webhookSecret).update(raw).digest("hex");
    if (!safeCompare(expected, signature)) {
        console.warn("[Webhook] Rejected event with invalid signature from", req.ip);
        return res.status(400).json({ message: "Invalid signature" });
    }

    const event = req.body || {};
    const payload = event.payload || {};
    const entity = (payload.payment || payload.order) || null;
    const rzpOrderId = entity && entity.order_id;

    try {
        if (event.event === "payment.captured" || event.event === "order.paid") {
            if (rzpOrderId) {
                const order = await Order.findOne({ "payment.razorpayOrderId": rzpOrderId });
                if (order && order.payment.status !== "paid") {
                    order.payment.status = "paid";
                    if (entity.id) order.payment.razorpayPaymentId = entity.id;
                    order.timeline.push({
                        status: "Payment Successful",
                        description: "Payment confirmed via Razorpay webhook",
                    });
                    await order.save();
                    console.log(`[Webhook] Order ${order.orderId} confirmed PAID via webhook`);
                    await fulfillPaidOrder(order);
                }
            }
        } else if (event.event === "payment.failed") {
            if (rzpOrderId) {
                const order = await Order.findOne({ "payment.razorpayOrderId": rzpOrderId });
                // Never downgrade a paid order — some failure events (e.g. card
                // declined) carry the order id without capturing money.
                if (order && order.payment.status !== "paid") {
                    order.payment.status = "failed";
                    order.timeline.push({
                        status: "Payment Failed",
                        description: "Razorpay reported the payment as failed",
                    });
                    await order.save();
                    console.log(`[Webhook] Order ${order.orderId} marked FAILED via webhook`);
                }
            }
        }
    } catch (procErr) {
        // Log but still ACK — throwing makes Razorpay mark the webhook failing
        // and eventually stop retrying, which would defeat the whole purpose.
        console.error("[Webhook] Processing error:", procErr);
    }

    // Always ACK unknown/duplicate events with 200 — idempotent by design
    res.status(200).json({ success: true });
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

            // Generate pickup (COMMENTED OUT FOR SAFE TESTING)
            // try {
            //     await shiprocket.generatePickup(srResult.shipment_id);
            // } catch (pickupErr) {
            //     console.error("Pickup generation failed:", pickupErr.message);
            // }

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
 * POST /api/order/track-public — Pure Shiprocket & Order tracking (AWB or Order ID)
 */
const trackOrderPublic = asyncHandler(async (req, res) => {
    const { orderId, email, awb } = req.body;

    // Case 1: Direct AWB Tracking
    if (awb && typeof awb === "string" && awb.trim()) {
        const cleanAwb = awb.trim();
        let tracking = null;
        let trackingError = null;

        try {
            tracking = await shiprocket.trackByAWB(cleanAwb);
        } catch (err) {
            console.error("Direct AWB tracking error:", err.message);
            trackingError = err.message;
        }

        // Try to find the associated order in our DB if it exists
        const matchedOrder = await Order.findOne({ "shiprocket.awbCode": cleanAwb }).lean();

        if (!tracking && !matchedOrder) {
            throw new AppError("No shipment found for the provided AWB / Tracking number.", 404);
        }

        return res.status(200).json({
            success: true,
            trackType: "awb",
            awb: cleanAwb,
            order: matchedOrder ? {
                orderId: matchedOrder.orderId,
                status: matchedOrder.status,
                items: matchedOrder.items,
                pricing: matchedOrder.pricing,
                shippingAddress: {
                    city: matchedOrder.shippingAddress?.city,
                    state: matchedOrder.shippingAddress?.state,
                    pincode: matchedOrder.shippingAddress?.pincode,
                },
                shiprocket: matchedOrder.shiprocket,
                timeline: matchedOrder.timeline,
                createdAt: matchedOrder.createdAt,
            } : null,
            tracking,
            trackingError,
        });
    }

    // Case 2: Order ID + Email Tracking (email is MANDATORY — Order IDs alone
    // are guessable, so ID-only lookups were a customer PII enumeration hole)
    if (!orderId || typeof orderId !== "string") {
        throw new AppError("Please provide an Order ID or AWB Tracking Number.", 400);
    }
    if (!email || typeof email !== "string" || !email.trim()) {
        throw new AppError("Please provide the email address used on this order.", 400);
    }

    const cleanOrderId = orderId.trim();
    // Exact string match with case-insensitivity — never build RegExp from user input
    const query = {
        $or: [
            { orderId: { $eq: cleanOrderId, $options: "i" } },
            { "shiprocket.awbCode": { $eq: cleanOrderId, $options: "i" } },
        ]
    };

    // Email always required and matched literally against the shipping address
    query["shippingAddress.email"] = { $eq: email.trim(), $options: "i" };

    const order = await Order.findOne(query).lean();

    if (!order) {
        // If not found in DB, check if cleanOrderId itself is an AWB in Shiprocket
        try {
            const tracking = await shiprocket.trackByAWB(cleanOrderId);
            if (tracking) {
                return res.status(200).json({
                    success: true,
                    trackType: "awb",
                    awb: cleanOrderId,
                    order: null,
                    tracking,
                });
            }
        } catch (e) {
            // Ignore fallback error
        }

        throw new AppError("No order found matching this Order ID and Email.", 404);
    }

    let tracking = null;

    if (order.shiprocket?.awbCode) {
        try {
            tracking = await shiprocket.trackByAWB(order.shiprocket.awbCode);
        } catch (err) {
            console.error("Public AWB tracking failed:", err.message);
        }
    } else if (order.shiprocket?.orderId) {
        try {
            tracking = await shiprocket.trackByShiprocketOrderId(order.shiprocket.orderId);
        } catch (err) {
            console.error("Public Shiprocket Order ID tracking failed:", err.message);
        }
    }

    res.status(200).json({
        success: true,
        trackType: "order",
        order: {
            orderId: order.orderId,
            status: order.status,
            items: order.items,
            pricing: order.pricing,
            shippingAddress: {
                city: order.shippingAddress?.city,
                state: order.shippingAddress?.state,
                pincode: order.shippingAddress?.pincode,
            },
            shiprocket: {
                courierName: order.shiprocket?.courierName,
                awbCode: order.shiprocket?.awbCode,
                trackingUrl: order.shiprocket?.trackingUrl || (order.shiprocket?.awbCode ? `https://shiprocket.co/tracking/${order.shiprocket.awbCode}` : null),
                status: order.shiprocket?.status,
            },
            timeline: order.timeline,
            createdAt: order.createdAt,
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
    handleRazorpayWebhook,
};
