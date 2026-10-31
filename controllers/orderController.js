import mongoose from "mongoose";
import crypto from "crypto";
import Order from "../models/orderModal.js";
import Product from "../models/productModal.js";
import User from "../models/userModal.js";
import Coupon from "../models/couponModal.js";
import WebhookEvent from "../models/webhookEventModel.js";
import EmailJob from "../models/emailJobModel.js";
import shiprocket from "../services/shiprocket.js";
import emailService from "../services/emailService.js";
import invoiceService from "../services/invoiceService.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import razorpayInstance from "../config/razorpay.js";
import { safeCompare, hashToken, toPaise, toRupees, escapeRegex } from "../utils/security.js";
import { ensureGatewayOrder } from "../services/gatewayOrder.js";
import { settleCartAfterPayment, applyCodCartAndAddress } from "../services/cartSettlement.js";
import { executeOrderTransition } from "../services/orderTransitions.js";
import { ensureDatabaseReady } from "../config/indexReadiness.js";
import {
    reconcileOrderPayments,
    findPaymentRefunds,
    refundOutcome,
    RZP_OUTCOME,
    REFUND_LIST_OUTCOME,
} from "../services/razorpayProvider.js";
import {
    confirmPaymentCaptured,
    expirePendingPayment,
    releaseReservation,
    markDispatched,
    confirmPhysicalReturn,
    requestCancellation,
    recordCourierOutcome,
    completeCancellation,
    claimRefundIntent,
    recordRefundInitiation,
    finalizeRefundState,
    adoptGatewayRefund,
    enqueueShippingEmail,
    enqueueEmails,
    scheduleFulfillment,
} from "../services/orderLifecycle.js";
import { runFulfillmentForOrder } from "../services/fulfillmentWorker.js";
import {
    evaluateCancellationEligibility,
    buildCustomerCancellationSummary,
    buildCustomerRefundSummary,
    processOrderCancellation,
    calculateCancellationRefund,
} from "../services/orderCancellation.js";
import {
    mapShipmentStatus,
    normalizeTrackingResult,
    sanitizeTrackingForPublic,
    resolveTracking,
    STATUS_RANK,
} from "../services/shiprocketTracking.js";
import { z } from "zod";

const MAX_QTY_PER_LINE = 10;

// Window in which a prepaid order may still be paid before the sweeper
// reconciles it against Razorpay and (if genuinely unpaid) releases its hold.
const RESERVATION_WINDOW_MS =
    1000 * 60 * Number(process.env.PAYMENT_RESERVATION_WINDOW_MIN || 30);

const isPlainString = (v) => typeof v === "string" && v.length > 0 && v.length < 500;

// ---------------------------------------------------------------------------
// Collection and critical unique index readiness
// ---------------------------------------------------------------------------
const CHECKOUT_COLLECTION_MODELS = [Order, Product, Coupon, User, WebhookEvent, EmailJob];

async function prepareCollection(model) {
    try {
        await model.createCollection();
    } catch (err) {
        if (err.code !== 48 && err.codeName !== "NamespaceExists") throw err;
    }
    try {
        await model.createIndexes();
    } catch (err) {
        console.warn(
            `[checkout] Index build skipped for "${model.modelName}" ` +
                `(${err.codeName || err.code || "error"}: ${err.message}).`
        );
    }
}

let collectionsReady = null;
function ensureCheckoutCollections() {
    if (!collectionsReady) {
        collectionsReady = ensureDatabaseReady().then((res) => {
            if (!res.isReady) {
                collectionsReady = null;
                throw new AppError(
                    "The store is briefly unavailable while database indexes are being prepared. Please try again.",
                    503
                );
            }
            return res;
        }).catch((err) => {
            collectionsReady = null;
            console.error("[checkout] Collection readiness failed:", err.message);
            throw new AppError(
                "The store is briefly unavailable while it prepares the database. Please try again in a moment.",
                503
            );
        });
    }
    return collectionsReady;
}

// Order payload schema — validated FIRST in createOrder so malformed input is
// rejected before any DB lookup, stock deduction or payment work.
const shippingAddressSchema = z.object({
    firstName: z.string({ error: "First name is required" }).trim().min(1, "First name is required"),
    lastName: z.string().trim().default(""),
    email: z
        .string({ error: "Email is required" })
        .trim()
        .toLowerCase()
        .min(1, "Email is required")
        .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Please enter a valid email address"),
    phone: z
        .string({ error: "Phone number is required" })
        .trim()
        .min(1, "Phone number is required")
        .regex(/^[6-9]\d{9}$/, "Please enter a valid 10-digit mobile number"),
    address: z.string({ error: "Address is required" }).trim().min(1, "Address is required"),
    landmark: z.string().trim().optional(),
    city: z.string({ error: "City is required" }).trim().min(1, "City is required"),
    state: z.string({ error: "State is required" }).trim().min(1, "State is required"),
    pincode: z
        .string({ error: "PIN code is required" })
        .trim()
        .min(1, "PIN code is required")
        .regex(/^\d{6}$/, "Please enter a valid 6-digit PIN code"),
});

const createOrderSchema = z.object({
    items: z
        .array(
            z.object({
                productId: z.string({ error: "Invalid product in your cart" }).min(1, "Invalid product in your cart"),
                quantity: z
                    .number({ error: "Invalid item quantity" })
                    .int("Quantity must be a whole number")
                    .min(1, "Quantity must be at least 1")
                    .max(MAX_QTY_PER_LINE, `Maximum ${MAX_QTY_PER_LINE} quantity allowed per item`),
            })
        )
        .min(1, "Order must contain at least one item"),
    shippingAddress: shippingAddressSchema,
    paymentMethod: z.enum(["card", "upi", "cod", "prepaid"]).optional().default("cod"),
    couponCode: z.string().trim().optional(),
    // Client-generated retry key for this checkout attempt (uuid-like). Same
    // key + same payload replays the original order instead of creating a
    // second one; same key + different payload is rejected.
    checkoutKey: z.string().trim().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
    // Guest recovery secret — generated + persisted by the CLIENT before the
    // first request. Its hash is stored as the checkout capability token, so a
    // guest can verify EVEN IF the first HTTP response was lost (the raw value
    // never needs to come back from the server). Bound into the payload hash so
    // it is tied to this specific attempt and cannot be replayed for another.
    checkoutRecoverySecret: z.string().trim().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
});

const checkoutPayloadHash = (normalized) =>
    crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");

const createOrder = asyncHandler(async (req, res) => {
    // Validate the entire payload with Zod FIRST — object shape, required
    // contact/address fields, formats and quantity bounds.
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join(". ");
        throw new AppError(message || "Please check your details and try again", 400);
    }

    const { shippingAddress, paymentMethod, couponCode, checkoutKey, checkoutRecoverySecret } = parsed.data;
    console.log("[createOrder] Received paymentMethod:", paymentMethod);

    // Gateway readiness is validated BEFORE any reservation is committed, so a
    // misconfigured gateway can never strand orders holding stock.
    if (paymentMethod !== "cod" && !razorpayInstance) {
        throw new AppError("Payment gateway is not configured. Please use Cash on Delivery or contact the store.", 503);
    }

    // Backend-owned delivery & COD serviceability check before commitment
    const pinCheck = await shiprocket.checkPincodeServiceability(shippingAddress.pincode, {
        weight: 0.5,
    });
    if (pinCheck.serviceable === false) {
        throw new AppError(`Delivery is currently not available for PIN code ${shippingAddress.pincode}.`, 400);
    }
    if (paymentMethod === "cod" && pinCheck.codAvailable === false) {
        throw new AppError(`Cash on Delivery is not available for PIN code ${shippingAddress.pincode}. Please select an online payment method.`, 400);
    }

    // Canonical payload used for idempotent-retry comparison. The recovery
    // secret is bound here so a given checkoutKey is locked to ONE attempt's
    // contents AND one ownership secret — a retry of the same attempt carries
    // both unchanged, while a changed cart/address/secret is a NEW attempt.
    const canonical = {
        items: parsed.data.items
            .map((i) => ({ productId: i.productId, quantity: i.quantity }))
            .sort((a, b) => (a.productId < b.productId ? -1 : 1)),
        shippingAddress,
        paymentMethod,
        couponCode: (couponCode || "").toUpperCase(),
        recoverySecret: checkoutRecoverySecret || null,
    };
    const payloadHash = checkoutPayloadHash(canonical);

    // ---- Retry idempotency: same checkoutKey = same attempt --------------
    if (checkoutKey) {
        const existing = await Order.findOne({ checkoutKey });
        if (existing) {
            if (existing.checkoutPayloadHash !== payloadHash) {
                // A genuine conflicting reuse of the key — the client must start a
                // fresh attempt. Structured code so the frontend only regenerates
                // the key here, NOT on every 409.
                return res.status(409).json({
                    success: false,
                    code: "CHECKOUT_CONFLICT",
                    message: "This checkout attempt was already used with different contents. Start a fresh checkout.",
                });
            }
            // Replay the AUTHORITATIVE outcome of the completed attempt — never a
            // generic error and never a second order. A paid attempt returns the
            // paid order so the frontend can finalize (spec §5).
            if (existing.payment.status === "paid" || existing.payment.status === "refunded") {
                return res.status(201).json({
                    success: true,
                    replayed: true,
                    order: buildCheckoutOrderResponse(existing),
                });
            }
            // A failed/expired attempt must NOT silently create a shadow order for
            // the same key — the frontend starts a fresh checkoutKey instead.
            if (existing.payment.status === "failed") {
                return res.status(409).json({
                    success: false,
                    code: "CHECKOUT_ATTEMPT_FAILED",
                    message: "This checkout attempt was not completed. Please start a fresh checkout.",
                });
            }
            // The DB row is authoritative; the previous attempt's response
            // could have been lost, so re-create the Razorpay order for it if
            // missing — but never a second local order. A captured-but-unlinked
            // payment is reconciled by verify/webhook, never by re-charging.
            if (existing.payment.method !== "cod" && !existing.payment.razorpayOrderId && toPaise(existing.pricing.total) > 0) {
                const gwResult = await ensureGatewayOrder(razorpayInstance, existing);
                if (gwResult.kind === "rejected") {
                    return res.status(409).json({
                        success: false,
                        code: "CHECKOUT_ATTEMPT_FAILED",
                        message: gwResult.message || "Payment gateway rejected the order initialization.",
                    });
                }
                return res.status(201).json({
                    success: true,
                    replayed: true,
                    order: buildCheckoutOrderResponse(gwResult.order),
                });
            }
            return res.status(201).json({
                success: true,
                replayed: true,
                order: buildCheckoutOrderResponse(existing),
            });
        }
    }

    // Aggregate repeated product ids BEFORE stock validation so split lines of
    // the same product cannot bypass the per-product quantity/stock bounds.
    const qtyByProduct = new Map();
    const extraByProduct = new Map(); // keep client image/sku hints per product
    for (const item of req.body.items) {
        const pid = String(item.productId || item.id || "");
        qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + item.quantity);
        if (!extraByProduct.has(pid)) extraByProduct.set(pid, item);
    }
    for (const [pid, qty] of qtyByProduct) {
        if (qty > MAX_QTY_PER_LINE) {
            throw new AppError(`Maximum ${MAX_QTY_PER_LINE} quantity allowed per item`, 400);
        }
    }
    const productIds = [...qtyByProduct.keys()];

    // Fetch products from DB — source of truth for price/name/sku (never trust client prices)
    const dbProducts = await Product.find({ _id: { $in: productIds } });
    const priceMap = new Map(dbProducts.map((p) => [p._id.toString(), p]));
    for (const pid of productIds) {
        if (!priceMap.has(pid)) {
            throw new AppError("One or more items in your cart are no longer available. Please review your cart.", 400);
        }
    }

    // Stock check + deduction as an atomic conditional bulk update
    const bulkOptions = productIds.map((pid) => ({
        updateOne: {
            filter: { _id: pid, stock: { $gte: qtyByProduct.get(pid) } },
            update: { $inc: { stock: -qtyByProduct.get(pid) } },
        },
    }));

    await ensureCheckoutCollections();

    const session = await mongoose.startSession();
    session.startTransaction();

    let order;
    let orderUserId;
    let checkoutToken;

    try {
        const bulkResult = await Product.bulkWrite(bulkOptions, { session });
        if (bulkResult.modifiedCount !== productIds.length) {
            throw new AppError("One or more items in your cart are out of stock. Please review your cart.", 400);
        }

        // ---- Pricing entirely from DB prices, in INTEGER PAISE ----
        const subtotalPaise = productIds.reduce(
            (sum, pid) => sum + toPaise(priceMap.get(pid).price) * qtyByProduct.get(pid),
            0
        );
        const shippingPaise = subtotalPaise >= toPaise(999) ? 0 : toPaise(199);

        // Determine User ID — Guests NEVER adopt registered accounts.
        const isGuest = !req.user;
        if (!isGuest) {
            orderUserId = req.user._id;
        } else {
            orderUserId = undefined;
        }

        // ---- Claim the coupon ATOMICALLY inside this transaction ----
        let discountPaise = 0;
        let appliedCouponCode = "";
        if (couponCode) {
            if (isGuest) {
                throw new AppError("Please log in to apply discount coupons.", 400);
            }
            const cleanCode = couponCode.trim().toUpperCase();

            const coupon = await Coupon.findOne({ code: cleanCode }).session(session);
            if (!coupon || !coupon.isValid()) {
                throw new AppError("Coupon is invalid or has expired.", 400);
            }
            const minPurchasePaise = toPaise(coupon.minPurchase);
            if (subtotalPaise < minPurchasePaise) {
                throw new AppError(`Minimum purchase of ₹${coupon.minPurchase} required for this coupon.`, 400);
            }
            const usedByUser = coupon.usedBy.filter(
                (uid) => uid.toString() === orderUserId.toString()
            ).length;
            if (usedByUser >= coupon.usageLimitPerUser) {
                throw new AppError("You have already used this coupon.", 400);
            }

            const usageLimitBefore = coupon.usageLimit;
            const perUserLimitBefore = coupon.usageLimitPerUser;

            // Atomic claim: only succeeds while global slots remain.
            const claimed = await Coupon.findOneAndUpdate(
                { code: cleanCode, isActive: true, usedCount: { $lt: usageLimitBefore } },
                { $inc: { usedCount: 1 }, $push: { usedBy: orderUserId } },
                { session, new: true }
            );
            if (!claimed) {
                throw new AppError("Coupon is invalid or has expired.", 400);
            }

            // Post-claim checks against the AUTHORITATIVE claimed doc.
            // (Global: the limit could have been lowered between read and claim.
            //  Per-user: concurrent claims each passed the pre-read above, so
            //  count THIS user's entries in usedBy — never usedBy.length, which
            //  counts every customer and would reject legitimate new users.)
            const userCountAfter = claimed.usedBy.filter(
                (uid) => uid.toString() === orderUserId.toString()
            ).length;
            if (userCountAfter > perUserLimitBefore) {
                throw new AppError("You have already used this coupon.", 400);
            }
            if (claimed.usedCount > claimed.usageLimit) {
                throw new AppError("Coupon is invalid or has expired.", 400);
            }

            discountPaise = toPaise(claimed.calculateDiscount(toRupees(subtotalPaise)));
            appliedCouponCode = cleanCode;
        }

        const totalPaise = Math.max(subtotalPaise + shippingPaise - discountPaise, 0);

        // Guest checkout capability token. When the client supplied a recovery
        // secret we store ONLY its hash and never return the raw value — the
        // client already holds it, so a lost first response is fully recoverable.
        // (Legacy/no-secret callers fall back to a server-generated token that is
        // returned once, exactly as before.)
        const clientProvidedSecret = !!checkoutRecoverySecret;
        const tokenRaw = checkoutRecoverySecret || crypto.randomBytes(24).toString("hex");
        checkoutToken = clientProvidedSecret ? undefined : tokenRaw;

        const cod = paymentMethod === "cod";
        order = new Order({
            user: isGuest ? undefined : orderUserId,
            isGuest: isGuest,
            checkoutKey: checkoutKey || undefined,
            checkoutPayloadHash: payloadHash,
            items: productIds.map((pid) => {
                const dbProduct = priceMap.get(pid);
                const extra = extraByProduct.get(pid) || {};
                return {
                    productId: dbProduct._id,
                    name: dbProduct.name,
                    slug: dbProduct.slug || extra.slug || dbProduct.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)+/g, ""),
                    price: dbProduct.price,
                    quantity: qtyByProduct.get(pid),
                    image: extra.image || dbProduct.image || "",
                    sku: dbProduct.sku || extra.sku || "",
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
                // A zero-payable prepaid order (100% coupon) is settled at once —
                // the gateway can never be called with amount 0.
                status: totalPaise === 0 && !cod ? "paid" : cod ? "pending" : "pending",
                checkoutTokenHash: hashToken(tokenRaw),
                amountPaid: totalPaise === 0 && !cod ? 0 : undefined,
                expiresAt: !cod && totalPaise > 0 ? new Date(Date.now() + RESERVATION_WINDOW_MS) : undefined,
            },
            pricing: {
                subtotal: toRupees(subtotalPaise),
                shipping: toRupees(shippingPaise),
                discount: toRupees(discountPaise),
                couponCode: appliedCouponCode,
                total: toRupees(totalPaise),
            },
            codAccounting: cod ? {
                amountDuePaise: totalPaise,
                collectedAtDelivery: false,
                remittanceStatus: "none",
            } : undefined,
            status: "placed",
            timeline: [{ status: "Order Placed", description: "Your order has been placed successfully" }],
        });

        if (totalPaise === 0 && !cod) {
            order.timeline.push({
                status: "Payment Successful",
                description: "Zero-payable order (fully covered by coupon) — no gateway charge required",
            });
        }

        // Order save is PART of the transaction now (collections are pre-ensured).
        await order.save({ session });

        // COD or zero-payable: enqueue confirmation & admin emails inside session
        if (cod || totalPaise === 0) {
            await enqueueEmails(order, session);
        }

        // COD or zero-payable: settle cart and update address book for authenticated users;
        // for guests, mark cartSettled: true on the order without touching any user account.
        if (cod || totalPaise === 0) {
            await applyCodCartAndAddress(order, shippingAddress, {
                session,
                isAuthenticated: !isGuest && Boolean(req.user),
            });
        }

        await session.commitTransaction();
        session.endSession();
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        throw error;
    }

    // ---- Post-commit ----

    if (order.payment.method !== "cod" && toPaise(order.pricing.total) > 0) {
        const gwResult = await ensureGatewayOrder(razorpayInstance, order);

        if (gwResult.kind === "rejected") {
            // Rejection was already recorded and resources released in gatewayOrder.js
            throw new AppError(gwResult.error?.message || gwResult.message || "Failed to initiate payment. Please try again.", 400);
        }

        if (gwResult.kind === "terminal") {
            return res.status(409).json({
                success: false,
                code: "CHECKOUT_ATTEMPT_FAILED",
                message: gwResult.message || "Order is in a terminal state",
                order: buildCheckoutOrderResponse(gwResult.order, checkoutToken),
            });
        }

        return res.status(201).json({
            success: true,
            order: buildCheckoutOrderResponse(gwResult.order, checkoutToken),
        });
    }

    // Zero-payable prepaid order (100% coupon): already settled at creation with
    // no gateway charge. Schedule the durable fulfillment stage + emails (the
    // worker/outbox own the rest), then respond — the FRONTEND must treat this
    // as a completed paid order and NOT try to open Razorpay (see response).
    if (order.payment.status === "paid") {
        await scheduleFulfillment(order._id);
        fulfillPaidOrder(order);
        return res.status(201).json({ success: true, order: buildCheckoutOrderResponse(order, checkoutToken) });
    }

    // COD Flow: schedule the durable pipeline + emails, then kick a low-latency
    // run. Neither blocks the response and both survive a crash via the worker.
    await scheduleFulfillment(order._id);
    fulfillPaidOrder(order);

    res.status(201).json({
        success: true,
        order: buildCheckoutOrderResponse(order, checkoutToken),
    });
});

// Response builder shared by first-run and replayed checkout responses. The
// frontend branches on the EXPLICIT contract fields below rather than inferring
// state from the mere presence of razorpayOrderId (fixes the zero-payable bug
// where a settled paid order had no gateway id and looked like a failure).
export function buildCheckoutOrderResponse(order, checkoutToken) {
    const rawTotal = order.pricing?.total;
    const payablePaise = toPaise(rawTotal !== undefined && rawTotal !== null ? rawTotal : 0);
    const resp = {
        orderId: order.orderId,
        _id: order._id,
        status: order.status,
        paymentStatus: order.payment?.status,
        paymentMethod: order.payment?.method,
        total: order.pricing?.total ?? 0,
        payablePaise,
        key: process.env.RAZORPAY_KEY_ID, // server is the single source of the publishable key
        checkoutToken: checkoutToken || undefined,
    };

    // EXPLICIT outcome — the frontend branches on this single field instead of
    // inferring state from the presence of razorpayOrderId / payment.method
    // (fixes the zero-payable bug and stops "success just because COD").
    const held = order.fulfillmentHold?.active === true;
    const cancelled = order.cancellation?.status === "completed" || order.status === "cancelled";
    const refunded = order.payment?.status === "refunded";
    const paid = order.payment?.status === "paid";
    const cod = order.payment?.method === "cod";
    const zeroPayable = !cod && payablePaise <= 0;
    const needsGateway =
        !cod && order.payment?.status === "pending" && payablePaise > 0 && !!order.payment?.razorpayOrderId;

    let outcome;
    if (held) outcome = "held_for_review";
    else if (refunded || cancelled) outcome = "rejected_terminal";
    else if (paid || zeroPayable) outcome = "paid_settled";
    else if (cod) outcome = "order_placed_cod";
    else if (needsGateway) outcome = "awaiting_payment";
    else outcome = "pending_recovery"; // prepaid, pending, gateway id not yet linked

    resp.outcome = outcome;
    // ONLY a genuine awaiting_payment order opens the Razorpay popup. A settled
    // paid order (incl. zero-payable) and an accepted COD order never reopen it;
    // a held/rejected/pending_recovery order must NOT be paid again blindly.
    resp.requiresPayment = outcome === "awaiting_payment";
    resp.settled = outcome === "paid_settled" || outcome === "order_placed_cod";

    if (order.payment.razorpayOrderId) {
        resp.razorpayOrderId = order.payment.razorpayOrderId;
        resp.amount = payablePaise;
        resp.currency = "INR";
    }
    return resp;
}



// ---------------------------------------------------------------------------
// Payment lifecycle helpers (also used by the reservation sweeper)
// ---------------------------------------------------------------------------

/**
 * Find the order a verification/webhook request refers to and prove the
 * requester owns it. Authenticated users must own the order; guests must
 * present the checkout capability token issued at order creation. An order ID
 * or email alone is NOT sufficient proof.
 */
async function resolveOwnedOrder(orderIdRaw, req, order = null) {
    const found = order || (await Order.findOne({ orderId: String(orderIdRaw).trim().toUpperCase() }));
    if (!found) throw new AppError("Order not found", 404);

    if (req.user && String(req.user._id) === String(found.user)) return found;

    const token = req.body && req.body.checkoutToken;
    if (
        isPlainString(token) &&
        found.payment.checkoutTokenHash &&
        safeCompare(hashToken(token.trim()), found.payment.checkoutTokenHash)
    ) {
        return found;
    }
    throw new AppError("Forbidden: you are not authorized to act on this order.", 403);
}

/**
 * Release held inventory + coupon for an order. Delegates to the shared
 * lifecycle transition, which decides eligibility by reservation.state (NOT an
 * order.status allowlist), commits marker+stock+coupon atomically, and keeps
 * durable retryable work if the transaction fails. Pre-dispatch cancels release;
 * dispatched parcels wait for a verified physical return. Kept as a thin wrapper
 * so existing callers (createOrder cleanup, sweeper) keep the same signature.
 * @returns {Promise<boolean>} true only if THIS call released the reservation.
 */
async function releaseOrderResources(order, { reason = "order-failed" } = {}) {
    const id = order && order._id ? order._id : order;
    const res = await releaseReservation(id, { reason });
    return !!(res && res.released);
}

/**
 * Refund lifecycle — a CLAIMED + RECONCILED workflow (spec §9).
 *   1. claimRefundIntent  → atomic DB claim of the still-refundable captured
 *      amount + a lease, persisted BEFORE any external call.
 *   2. razorpay.payments.refund  → the single external initiation.
 *   3. recordRefundInitiation → persist gateway id + pending/processed/failed.
 *   4. finalizeRefundState → advance totals ONLY from a gateway-VERIFIED state,
 *      at most once (refund.finalized).
 * A provider ERROR is never treated as proof that no refund happened, and an
 * uncertain initiation is left durably `requested` for reconciliation rather
 * than blindly re-issued.
 */
const REFUNDABLE_STATUSES = ["requested", "pending", "processed"];

async function refundPaidOrder(order, reason = "Refund issued by store") {
    if (order.payment.status !== "paid" || !order.payment.razorpayPaymentId) {
        throw new AppError("Only a successfully paid order can be refunded.", 400);
    }
    if (!razorpayInstance) {
        throw new AppError("Payment gateway is not configured.", 500);
    }

    // Already-refunded / refund-in-flight: reconcile from the gateway first.
    if (order.refund?.razorpayRefundId && REFUNDABLE_STATUSES.includes(order.refund.status)) {
        await reconcileRefund(order);
        const s = order.refund?.status;
        if (s === "processed") throw new AppError("This order has already been refunded.", 400);
        if (s === "pending" || s === "requested") throw new AppError("A refund is already in progress for this order.", 400);
    }

    // ATOMIC intent claim BEFORE the external call (serializes concurrent
    // admin/cancel/reconcile actions; a live lease is not double-issued).
    const claim = await claimRefundIntent(order._id, {});
    if (!claim) {
        throw new AppError("No refundable captured amount remains (or a refund is already in flight).", 400);
    }
    const { refundablePaise } = claim;
    const leaseOwner = claim.order.refund.leaseOwner;

    let refund;
    try {
        refund = await razorpayInstance.payments.refund(order.payment.razorpayPaymentId, { amount: refundablePaise });
    } catch (err) {
        // Initiation UNCERTAIN: keep the durable `requested` intent so the
        // reconciliation sweeper can recover an orphan refund; never re-issue.
        console.error(`[Refund] Initiation uncertain for ${order.orderId}:`, err.message);
        throw new AppError("Refund initiation is being confirmed. Do not repeat this action — it will reconcile automatically.", 502);
    }

    const gw = refundOutcome(refund); // processed | pending | failed | unknown
    await recordRefundInitiation(order._id, {
        refundId: refund.id,
        gatewayStatus: gw,
        amountPaise: refund.amount || refundablePaise,
        leaseOwner,
    });
    if (gw === "processed") {
        await finalizeRefundState(order._id, { providerStatus: "processed", leaseOwner });
    }

    const fresh = await Order.findById(order._id);
    if (fresh) { order.refund = fresh.refund; order.payment = fresh.payment; }
    console.log(`[Refund] Order ${order.orderId} refund ${refund.id} → ${gw}`);
    return refund;
}

/** Pull the authoritative state of a stored in-flight refund and finalize once. */
async function reconcileRefund(order) {
    if (!razorpayInstance || !order.refund?.razorpayRefundId) return;
    if (order.refund.finalized) return;
    try {
        const fresh = await razorpayInstance.refunds.fetch(order.refund.razorpayRefundId);
        const gw = refundOutcome(fresh);
        if (gw === "processed" || gw === "failed") {
            await finalizeRefundState(order._id, {
                providerStatus: gw,
                leaseOwner: order.refund.leaseOwner || undefined,
            });
            const reloaded = await Order.findById(order._id);
            if (reloaded) { order.refund = reloaded.refund; order.payment = reloaded.payment; }
        }
    } catch (err) {
        console.error(`[Refund] Reconcile fetch failed for ${order.orderId}:`, err.message);
    }
}

/**
 * Recover a refund the gateway created but we lost locally (uncertain
 * initiation). Reads the payment's refunds via the PROVIDER ADAPTER (items[]
 * shape) and adopts the newest unknown one — an error/absence is NEVER assumed.
 */
async function adoptOrphanRefund(order) {
    const res = await findPaymentRefunds(razorpayInstance, order.payment.razorpayPaymentId);
    if (res.outcome !== REFUND_LIST_OUTCOME.FOUND) return null; // NONE or UNKNOWN
    const known = order.refund?.razorpayRefundId;
    const orphan = res.refunds
        .filter((r) => r.id !== known && ["processed", "pending", "written_out"].includes(r.status))
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
    if (!orphan) return null;
    await adoptGatewayRefund(order._id, {
        refundId: orphan.id,
        amountPaise: orphan.amount,
        gatewayStatus: refundOutcome(orphan),
        createdAt: orphan.created_at,
    });
    const fresh = await Order.findById(order._id);
    if (fresh) { order.refund = fresh.refund; order.payment = fresh.payment; }
    return fresh?.refund || null;
}

// ---------------------------------------------------------------------------
// Shared fulfillment trigger. Emails are ENQUEUED durably by the payment
// transition (outbox) and the Shiprocket pipeline is a durable staged worker
// claim, so this only kicks a low-latency run. Nothing depends on SMTP or the
// browser inline; the sweeper guarantees completion.
// ---------------------------------------------------------------------------
async function fulfillPaidOrder(order) {
    const id = order && order._id ? order._id : order;
    runFulfillmentForOrder(id).catch((err) =>
        console.error(`[Fulfillment] kick failed for ${id}:`, err.message)
    );
}

// ---------------------------------------------------------------------------
// POST /api/order/verify-payment — Razorpay verification + safe recovery.
// The browser is NEVER trusted to declare an order failed: dismissal, SDK
// errors, timeouts and network failures only ever delay confirmation. Final
// failure is decided by the reservation sweeper AFTER reconciling with the
// gateway. Every mutation here requires ownership proof (auth or capability
// token) and captured-payment is confirmed AUTHORITATIVELY against Razorpay —
// a valid checkout signature alone is not treated as proof money was captured.
/**
 * Shared reconciliation decision helper for both existing-gateway-ID (step 3)
 * and newly-recovered-gateway (step 4) verification branches.
 *
 * Guarantees:
 * - IN_PROGRESS always returns verification_pending, preserving recovery,
 *   even if local payment window has passed.
 * - UNKNOWN and unexpected outcomes remain unresolved verification_pending.
 * - Only NO_CAPTURED evaluates unpaid eligibility / expiry.
 */
function decidePaymentReconciliationOutcome({
    order,
    rec,
    isExpired,
    payablePaise,
    razorpayOrderId,
}) {
    if (rec.outcome === RZP_OUTCOME.CAPTURED_VALID) {
        return {
            decision: "capture_valid",
            paymentId: rec.payment.id,
            amountPaise: rec.payment.amount,
        };
    }

    if (rec.outcome === RZP_OUTCOME.IN_PROGRESS) {
        return {
            decision: "respond",
            status: "pending",
            outcome: "verification_pending",
            message: "Payment authorized at gateway; capture confirmation pending.",
            orderId: order.orderId,
        };
    }

    if (rec.outcome === RZP_OUTCOME.MISMATCH) {
        return {
            decision: "mismatch_held",
            status: "pending",
            outcome: "held",
            message: "Payment needs manual confirmation — the store has been alerted.",
            reason: `Payment reconciliation mismatch: ${rec.reason}`,
            orderId: order.orderId,
        };
    }

    if (rec.outcome === RZP_OUTCOME.UNKNOWN) {
        return {
            decision: "respond",
            status: "pending",
            outcome: "verification_pending",
            message: "Payment status is being reconciled with the gateway. Please retry in a moment.",
            orderId: order.orderId,
        };
    }

    if (rec.outcome === RZP_OUTCOME.NO_CAPTURED) {
        if (order.status === "cancelled" || order.payment?.status === "failed") {
            return {
                decision: "respond",
                status: order.payment?.status || "failed",
                outcome: "terminal",
                message: "This order has been cancelled or has expired.",
                orderId: order.orderId,
            };
        }
        if (order.fulfillmentHold?.active) {
            return {
                decision: "respond",
                status: order.payment?.status,
                outcome: "held",
                message: `Order is on hold for review: ${order.fulfillmentHold.reason || "Review required"}`,
                orderId: order.orderId,
            };
        }
        if (order.reservation?.state === "released" || order.resourcesReleased) {
            return {
                decision: "respond",
                status: "failed",
                outcome: "terminal",
                message: "Inventory reservation for this order has expired.",
                orderId: order.orderId,
            };
        }
        if (isExpired) {
            return {
                decision: "respond",
                status: "failed",
                outcome: "terminal",
                message: "Payment window for this order has expired.",
                orderId: order.orderId,
            };
        }

        if (payablePaise <= 0) {
            return {
                decision: "respond",
                status: "paid",
                outcome: "paid",
                orderId: order.orderId,
                amount: 0,
                message: "Order is zero-payable and already settled.",
            };
        }

        return {
            decision: "respond",
            status: "pending",
            outcome: "payable",
            razorpayOrderId,
            amount: payablePaise,
            currency: "INR",
            key: process.env.RAZORPAY_KEY_ID,
            orderId: order.orderId,
            message: "Order is eligible for payment.",
        };
    }

    // Default conservative fallback: any unhandled or unrecognized outcome
    // must remain unresolved verification_pending, never terminal or payable!
    return {
        decision: "respond",
        status: "pending",
        outcome: "verification_pending",
        message: "Payment status is pending reconciliation. Please retry in a moment.",
        orderId: order.orderId,
    };
}

const verifyPayment = asyncHandler(async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!isPlainString(req.body.orderId)) {
        throw new AppError("Invalid payment verification payload", 400);
    }

    // 1. Ownership / capability — a lost race can never be verified by a third
    // party using the guessable order id alone.
    const order = await resolveOwnedOrder(req.body.orderId, req);

    if (order.payment.method === "cod") {
        throw new AppError("COD orders do not require payment verification.", 400);
    }

    // 2. Terminal state / idempotent fast path.
    if (order.payment.status === "paid") {
        if (order.fulfillmentHold?.active) {
            return res.status(200).json({
                success: true,
                status: "paid",
                outcome: "held",
                message: `Order is on hold for review: ${order.fulfillmentHold.reason || "Review required"}`,
                orderId: order.orderId,
            });
        }
        return res.status(200).json({
            success: true,
            status: "paid",
            outcome: "paid",
            message: "Payment already verified",
            orderId: order.orderId,
        });
    }
    if (order.payment.status === "refunded") {
        return res.status(200).json({
            success: true,
            status: "refunded",
            outcome: "terminal",
            message: "This order was already refunded.",
            orderId: order.orderId,
        });
    }

    const hasTriple = razorpay_order_id || razorpay_payment_id || razorpay_signature;

    // 3. IF THE ORDER ALREADY HAS A RAZORPAY ORDER ID (or a verification triple):
    // Reconcile with Razorpay FIRST before concluding expiry or failure!
    // A payment captured before local expiry must be confirmed (or held if stock was released).
    if (order.payment.razorpayOrderId) {
        if (hasTriple) {
            if (![razorpay_order_id, razorpay_payment_id, razorpay_signature].every(isPlainString)) {
                throw new AppError("Invalid payment verification payload", 400);
            }
            if (order.payment.razorpayOrderId !== razorpay_order_id) {
                console.warn(`[Verify] Order-mismatch attempt on ${order.orderId} from ${req.ip}`);
                throw new AppError("Payment verification failed: order mismatch", 400);
            }
            if (!process.env.RAZORPAY_KEY_SECRET) {
                throw new AppError("Payment gateway is not configured.", 500);
            }
            const generatedSignature = crypto
                .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
                .update(razorpay_order_id + "|" + razorpay_payment_id)
                .digest("hex");
            if (!safeCompare(generatedSignature, razorpay_signature)) {
                console.warn(`[Verify] Invalid signature attempt on ${order.orderId} from ${req.ip}`);
                throw new AppError("Payment verification failed", 400);
            }
        }

        const rec = await reconcileOrderPayments(razorpayInstance, order.payment.razorpayOrderId, {
            expectedAmountPaise: toPaise(order.pricing.total),
            expectedCurrency: "INR",
            expectedPaymentId: hasTriple ? razorpay_payment_id : undefined,
        });

        const isExpired = order.payment?.expiresAt && new Date(order.payment.expiresAt).getTime() <= Date.now();
        const payablePaise = toPaise(order.pricing?.total ?? 0);
        const dec = decidePaymentReconciliationOutcome({
            order,
            rec,
            isExpired,
            payablePaise,
            razorpayOrderId: order.payment.razorpayOrderId,
        });

        if (dec.decision === "capture_valid") {
            const claimed = await confirmPaymentCaptured(order._id, {
                paymentId: dec.paymentId,
                amountPaise: dec.amountPaise,
                source: hasTriple ? "browser-verify" : "gateway-recovery",
            });
            if (claimed) {
                if (hasTriple) {
                    await Order.updateOne({ _id: order._id }, { $set: { "payment.razorpaySignature": razorpay_signature } });
                }
                fulfillPaidOrder(claimed);
                settleCartAfterPayment(claimed).catch(() => {});
                return res.status(200).json({
                    success: true,
                    status: "paid",
                    outcome: "paid",
                    message: "Payment verified successfully",
                    orderId: order.orderId,
                });
            }

            const cur = await Order.findById(order._id);
            if (cur?.fulfillmentHold?.active) {
                return res.status(200).json({
                    success: true,
                    status: cur.payment?.status || "paid",
                    outcome: "held",
                    message: `Order is on hold for review: ${cur.fulfillmentHold.reason || "Review required"}`,
                    orderId: order.orderId,
                });
            }
            const st = cur?.payment?.status;
            return res.status(200).json({
                success: true,
                status: st === "paid" ? "paid" : "pending",
                outcome: st === "paid" ? "paid" : "verification_pending",
                message: st === "paid" ? "Payment verified successfully" : "Payment is being confirmed. This page can be safely reloaded in a moment.",
                orderId: order.orderId,
            });
        }

        if (dec.decision === "mismatch_held") {
            await Order.updateOne(
                { _id: order._id },
                { $set: { "fulfillmentHold.active": true, "fulfillmentHold.reason": dec.reason } }
            ).catch(() => {});
            return res.status(200).json({
                success: true,
                status: dec.status,
                outcome: dec.outcome,
                message: dec.message,
                orderId: dec.orderId,
            });
        }

        return res.status(200).json({
            success: true,
            status: dec.status,
            outcome: dec.outcome,
            message: dec.message,
            orderId: dec.orderId,
            razorpayOrderId: dec.razorpayOrderId,
            amount: dec.amount,
            currency: dec.currency,
            key: dec.key,
        });
    }

    // 4. ORDER HAS NO GATEWAY ORDER ID (TASK 2 & TASK 4):
    // Check terminal/held conditions first:
    if (order.status === "cancelled" || order.payment.status === "failed") {
        return res.status(200).json({
            success: true,
            status: order.payment.status || "failed",
            outcome: "terminal",
            message: "This order has been cancelled or has expired.",
            orderId: order.orderId,
        });
    }
    if (order.fulfillmentHold?.active) {
        return res.status(200).json({
            success: true,
            status: order.payment.status,
            outcome: "held",
            message: `Order is on hold for review: ${order.fulfillmentHold.reason || "Review required"}`,
            orderId: order.orderId,
        });
    }
    // Only declare terminal due to released reservation if no external call was ever dispatched
    if ((order.reservation?.state === "released" || order.resourcesReleased) && !order.gatewayInit?.sentExternalCall) {
        return res.status(200).json({
            success: true,
            status: "failed",
            outcome: "terminal",
            message: "Inventory reservation for this order has expired.",
            orderId: order.orderId,
        });
    }
    const isExpiredNoGw = order.payment?.expiresAt && new Date(order.payment.expiresAt).getTime() <= Date.now();
    // Only declare terminal due to expiry if no external call was ever dispatched
    if (isExpiredNoGw && !order.gatewayInit?.sentExternalCall) {
        return res.status(200).json({
            success: true,
            status: "failed",
            outcome: "terminal",
            message: "Payment window for this order has expired.",
            orderId: order.orderId,
        });
    }
    if (order.gatewayInit?.status === "manual_review") {
        return res.status(200).json({
            success: true,
            status: "pending",
            outcome: "held",
            message: "Order initialization is held for review.",
            orderId: order.orderId,
        });
    }
    if (order.gatewayInit?.status === "failed" && !order.gatewayInit?.sentExternalCall) {
        return res.status(200).json({
            success: true,
            status: "failed",
            outcome: "terminal",
            message: "Order initialization failed.",
            orderId: order.orderId,
        });
    }

    // ELIGIBLE or NEEDS RECONCILIATION: Reconnect "preparing" to real gateway recovery using shared ensureGatewayOrder!
    const gw = await ensureGatewayOrder(razorpayInstance, order);

    if (gw.kind === "ready" && gw.razorpayOrderId) {
        const orderTotal = gw.order?.pricing?.total ?? order.pricing?.total ?? 0;
        const payablePaise = toPaise(orderTotal);
        if (payablePaise <= 0) {
            return res.status(200).json({
                success: true,
                status: "paid",
                outcome: "paid",
                orderId: order.orderId,
                amount: 0,
                message: "Order is zero-payable.",
            });
        }

        // Reconcile payment status against Razorpay to ensure captured payments are honored
        const rec = await reconcileOrderPayments(razorpayInstance, gw.razorpayOrderId, {
            expectedAmountPaise: payablePaise,
            expectedCurrency: "INR",
        });

        const isNowExpired = isExpiredNoGw || (order.payment?.expiresAt && new Date(order.payment.expiresAt).getTime() <= Date.now());
        const dec = decidePaymentReconciliationOutcome({
            order,
            rec,
            isExpired: isNowExpired,
            payablePaise,
            razorpayOrderId: gw.razorpayOrderId,
        });

        if (dec.decision === "capture_valid") {
            await confirmPaymentCaptured(order._id, {
                paymentId: dec.paymentId,
                amountPaise: dec.amountPaise,
                source: "verify-payment-gateway-recovery",
            });
            await settleCartAfterPayment(order).catch(() => {});
            const fresh = await Order.findById(order._id);
            if (fresh?.fulfillmentHold?.active) {
                return res.status(200).json({
                    success: true,
                    status: "paid",
                    outcome: "held",
                    message: `Payment received, but order is held for review: ${fresh.fulfillmentHold.reason || "Fulfillment hold active"}`,
                    orderId: order.orderId,
                });
            }
            return res.status(200).json({
                success: true,
                status: "paid",
                outcome: "paid",
                orderId: order.orderId,
                message: "Payment successfully verified.",
            });
        }

        if (dec.decision === "mismatch_held") {
            await Order.updateOne(
                { _id: order._id },
                { $set: { "fulfillmentHold.active": true, "fulfillmentHold.reason": dec.reason } }
            );
            return res.status(200).json({
                success: true,
                status: dec.status,
                outcome: dec.outcome,
                message: dec.message,
                orderId: dec.orderId,
            });
        }

        return res.status(200).json({
            success: true,
            status: dec.status,
            outcome: dec.outcome,
            message: dec.message,
            orderId: dec.orderId,
            razorpayOrderId: dec.razorpayOrderId,
            amount: dec.amount,
            currency: dec.currency,
            key: dec.key,
        });
    }

    if (gw.kind === "in_progress") {
        return res.status(200).json({
            success: true,
            status: "pending",
            outcome: "preparing",
            message: "Payment gateway initialization in progress. Please wait a moment.",
            orderId: order.orderId,
        });
    }

    if (gw.kind === "uncertain") {
        return res.status(200).json({
            success: true,
            status: "pending",
            outcome: "verification_pending",
            message: "Payment gateway status is pending confirmation.",
            orderId: order.orderId,
        });
    }

    if (gw.kind === "rejected") {
        if (gw.order?.fulfillmentHold?.active) {
            return res.status(200).json({
                success: true,
                status: "pending",
                outcome: "held",
                message: "Order initialization is held for review.",
                orderId: order.orderId,
            });
        }
        return res.status(200).json({
            success: true,
            status: "failed",
            outcome: "terminal",
            message: gw.error?.message || gw.message || "Order initialization rejected.",
            orderId: order.orderId,
        });
    }

    if (gw.kind === "terminal") {
        return res.status(200).json({
            success: true,
            status: "failed",
            outcome: "terminal",
            message: gw.message || "Order is in a terminal state.",
            orderId: order.orderId,
        });
    }

    return res.status(200).json({
        success: true,
        status: "pending",
        outcome: "preparing",
        message: "Payment gateway initialization in progress. Please wait a moment.",
        orderId: order.orderId,
    });
});



// ---------------------------------------------------------------------------
// POST /api/order/webhook — Razorpay server-to-server events.
// Events are PERSISTED before the ACK; processing failures are replayable by
// the sweeper instead of being swallowed behind a fake-success 200.
// ---------------------------------------------------------------------------
const handleRazorpayWebhook = asyncHandler(async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
        console.error("[Webhook] RAZORPAY_WEBHOOK_SECRET is not configured — rejecting");
        return res.status(500).json({ message: "Webhook not configured" });
    }

    // 1. Authenticity over the exact raw bytes.
    const signature = req.headers["x-razorpay-signature"];
    const raw = req.rawBody;
    if (!isPlainString(signature) || !raw) {
        return res.status(400).json({ message: "Missing webhook signature" });
    }
    const expected = crypto.createHmac("sha256", webhookSecret).update(raw).digest("hex");
    if (!safeCompare(expected, signature)) {
        console.warn("[Webhook] Rejected event with invalid signature from", req.ip);
        return res.status(400).json({ message: "Invalid signature" });
    }

    const event = req.body || {};

    // 2. Durable acceptance BEFORE acknowledgment.
    const eventId = isPlainString(event.event_id)
        ? event.event_id
        : "h_" + crypto.createHash("sha256").update(raw).digest("hex");

    let doc;
    try {
        doc = await WebhookEvent.create({
            eventId,
            type: String(event.event || "unknown"),
            razorpayOrderId: extractRzpOrderId(event),
            payload: event,
        });
    } catch (err) {
        if (err && err.code === 11000) {
            // Duplicate delivery — already durably accepted earlier.
            return res.status(200).json({ success: true, duplicate: true });
        }
        console.error("[Webhook] Durable persistence FAILED:", err);
        // Could not durably accept → retryable error so Razorpay redelivers.
        return res.status(502).json({ message: "Event not persisted, retry" });
    }

    // 3. Process (best-effort now — the event is durable and replayable).
    try {
        await processWebhookEventDoc(doc);
    } catch (procErr) {
        console.error("[Webhook] Processing error (event stored for replay):", procErr);
        await WebhookEvent.updateOne(
            { _id: doc._id },
            { $set: { lastError: String(procErr.message || procErr).slice(0, 500) }, $inc: { retries: 1 } }
        ).catch(() => {});
    }

    res.status(200).json({ success: true });
});

function extractRzpOrderId(event) {
    const entity = eventEntity(event);
    // payment entities carry order_id; order entities ARE the order id.
    if (!entity) return null;
    return entity.order_id || entity.id || null;
}

/** Razorpay nests the real object under payload.<type>.entity — read it. */
function eventEntity(event) {
    const payload = event.payload || {};
    return (payload.payment && payload.payment.entity) || (payload.order && payload.order.entity) || null;
}

/**
 * Shared event processor for live webhook deliveries AND sweeper replays.
 * Idempotent; terminal states are never resurrected; out-of-order events
 * (failed-then-captured etc.) settle to the truth via atomic claims.
 */
async function processWebhookEventDoc(doc) {
    const event = doc.payload || {};
    const entity = eventEntity(event);
    const rzpOrderId = entity && (entity.order_id || (entity.id && /^order_/i.test(entity.id) ? entity.id : null));

    // Durably set the event's lifecycle state. `processed` is kept in sync for
    // backward compatibility, but a RECOVERABLE event (unmatched) is NEVER
    // burned as processed — the sweeper must retry it later.
    const mark = (state, extra = {}) => WebhookEvent.updateOne(
        { _id: doc._id },
        { $set: { state, processed: state === "processed", processedAt: state === "processed" ? new Date() : doc.processedAt, ...extra } }
    );

    if (event.event === "payment.captured" || event.event === "order.paid") {
        if (!rzpOrderId) { await mark("manual_review", { lastError: "no_order_id_in_event" }); return; }
        const order = await Order.findOne({ "payment.razorpayOrderId": rzpOrderId });
        if (!order) {
            // Event arrived BEFORE the local order mapping is visible — keep it
            // recoverable so a later replay (after create commits) can settle it.
            await mark("unmatched", { lastError: "order_not_found_yet", nextAttemptAt: new Date(Date.now() + 30000) });
            return;
        }
        if (["paid", "refunded"].includes(order.payment.status)) { await mark("processed"); return; }

        const expectedPaise = toPaise(order.pricing?.total || 0);
        if (typeof entity.amount === "number" && entity.amount !== expectedPaise) {
            await mark("manual_review", { lastError: `amount_mismatch:${entity.amount}!=${expectedPaise}` }); return;
        }
        if (entity.currency && entity.currency !== "INR") {
            await mark("manual_review", { lastError: `currency_mismatch:${entity.currency}` }); return;
        }
        // SHARED transition — same atomic conditional claim as browser + sweeper.
        const claimed = await confirmPaymentCaptured(order._id, {
            paymentId: entity.id || undefined,
            amountPaise: typeof entity.amount === "number" ? entity.amount : expectedPaise,
            source: "webhook",
        });
        if (claimed) {
            console.log(`[Webhook] Order ${claimed.orderId} confirmed PAID via webhook`);
            fulfillPaidOrder(claimed);
            settleCartAfterPayment(claimed).catch(() => {});
        } else {
            console.log(`[Webhook] Paid-claim skipped for ${order.orderId} (terminal / concurrent / held)`);
        }
        await mark("processed");
        return;
    }

    if (event.event === "payment.failed") {
        if (!rzpOrderId) { await mark("processed"); return; }
        const order = await Order.findOne({ "payment.razorpayOrderId": rzpOrderId });
        if (!order) { await mark("unmatched", { lastError: "order_not_found_yet", nextAttemptAt: new Date(Date.now() + 30000) }); return; }
        // A FAILED ATTEMPT is not the order's final state — record the attempt
        // only (a later success within the window still confirms). The sweeper
        // settles genuine expiry, so we never fail the order from the browser.
        if (order.payment.status === "pending" && entity.id) {
            const already = order.timeline.some(
                (t) => t.status === "Payment Attempt Failed" && t.description?.includes(entity.id || "")
            );
            if (!already) {
                await Order.updateOne(
                    { _id: order._id, "payment.status": "pending" },
                    { $push: { timeline: { status: "Payment Attempt Failed", description: `Razorpay reported attempt ${entity.id} as failed (order still open for retry)`, date: new Date() } } }
                );
            }
        }
        await mark("processed");
        return;
    }

    // Unhandled event type — durably recorded, nothing to do.
    await mark("processed");
}

// ---------------------------------------------------------------------------
// Durable, resumable Shiprocket pipeline
// ---------------------------------------------------------------------------

/**
 * Thin trigger for the admin "push" action and legacy callers. The real durable,
 * resumable pipeline lives in services/fulfillmentWorker.js (DB-backed lease
 * claims, staged reconciliation, backoff). This only kicks a claimed run for low
 * latency; the sweeper drives it to completion regardless. No route/signature
 * change — kept so existing callers keep working.
 */
async function pushToShiprocket(order) {
    const id = order && order._id ? order._id : order;
    return runFulfillmentForOrder(id);
}

// ---------------------------------------------------------------------------
// TRACKING — single provider normalization layer now lives in
// services/shiprocketTracking.js. Re-exported here so existing consumers and
// the node:test suite keep importing from the controller with no route change.
// ---------------------------------------------------------------------------
export { normalizeTrackingResult, sanitizeTrackingForPublic, mapShipmentStatus, STATUS_RANK };

/**
 * Forward-only status sync from a Shiprocket tracking payload. Advances the
 * stored order, records the timeline entry and emails the customer when the
 * courier reports a genuinely newer stage. Never downgrades; never touches
 * cancelled/returned orders; no-op when nothing changed.
 */
export async function syncOrderFromShipment(orderDoc, trackingPayload) {
    try {
        if (!trackingPayload || ["cancelled", "returned"].includes(orderDoc.status) || ["requested", "completed"].includes(orderDoc.cancellation?.status)) return;
        const n = normalizeTrackingResult(trackingPayload);
        const srStatus = n?.currentStatus || n?.shipmentStatus;
        if (!srStatus) return;

        const mapped = mapShipmentStatus(srStatus);
        const curRank = STATUS_RANK[orderDoc.status] ?? -1;
        const newRank = mapped ? (STATUS_RANK[mapped] ?? -1) : -1;
        const effectiveRank = Math.max(curRank, newRank);

        // Gap Fix: Even if tracking status is unchanged, check if a missing dispatch marker needs repair!
        // Authoritative tracking evidence (or current order status) indicates dispatch:
        if (effectiveRank >= STATUS_RANK.shipped && orderDoc.reservation?.state === "held") {
            await markDispatched(orderDoc._id).catch((err) =>
                console.error(`[Sync] markDispatched repair failed for ${orderDoc.orderId}:`, err.message)
            );
            orderDoc.reservation.state = "return_pending";
        }

        // If tracking status has not changed, nothing more to do (dispatch repair already handled above).
        if (orderDoc.shiprocket.status === srStatus) return;

        orderDoc.shiprocket.status = srStatus;

        if (mapped && newRank > curRank) {
            // Check fresh database state conditionally so out-of-order responses never regress newer state or overwrite cancellation
            const fresh = await Order.findById(orderDoc._id).select("status cancellation reservation").lean();
            if (!fresh || ["cancelled", "returned"].includes(fresh.status) || ["requested", "completed"].includes(fresh.cancellation?.status)) {
                return;
            }
            const freshRank = STATUS_RANK[fresh.status] ?? -1;
            if (newRank <= freshRank) {
                // Out-of-order or older tracking update — do not regress
                return;
            }

            orderDoc.status = mapped;
            if (newRank >= STATUS_RANK.shipped && orderDoc.reservation?.state === "held") {
                orderDoc.reservation.state = "return_pending";
            }
            if (mapped === "delivered" && orderDoc.payment?.method === "cod") {
                orderDoc.codAccounting = orderDoc.codAccounting || {};
                orderDoc.codAccounting.collectedAtDelivery = true;
                orderDoc.codAccounting.collectedAmountPaise = Math.round(Number(orderDoc.pricing?.total || 0) * 100);
                orderDoc.codAccounting.collectedAt = new Date();
                if (orderDoc.codAccounting.remittanceStatus === "none" || !orderDoc.codAccounting.remittanceStatus) {
                    orderDoc.codAccounting.remittanceStatus = "pending";
                }
            }
            orderDoc.timeline.push({
                status: mapped.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
                description: `Courier update from ${orderDoc.shiprocket.courierName || "Shiprocket"}: ${srStatus}`,
                date: new Date(),
            });
            await orderDoc.save();

            // Durably enqueue the status email via the outbox — fire-and-forget
            // SMTP here used to silently drop customer notifications on failure.
            await enqueueShippingEmail(orderDoc._id, mapped).catch((err) =>
                console.error(`[Sync] Status email enqueue failed for ${orderDoc.orderId}:`, err)
            );
            console.log(`[Sync] Order ${orderDoc.orderId} advanced to '${mapped}' (courier: ${srStatus})`);
        } else {
            await orderDoc.save();
        }
    } catch (err) {
        // Sync is best-effort — never break the tracking response over it
        console.error(`[Sync] Status sync failed for ${orderDoc.orderId}:`, err.message);
    }
}

// ---------------------------------------------------------------------------
// Customer order reads
// ---------------------------------------------------------------------------

/** GET /api/order/my-orders — authenticated user's orders */
const getUserOrders = asyncHandler(async (req, res) => {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
        Order.find({ user: req.user._id, isGuest: { $ne: true } })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select("-__v -payment.checkoutTokenHash -payment.razorpaySignature"),
        Order.countDocuments({ user: req.user._id, isGuest: { $ne: true } }),
    ]);

    const enrichedOrders = orders.map((order) => {
        const o = order.toObject ? order.toObject() : { ...order };
        const eligibility = evaluateCancellationEligibility(o, { isCustomer: true });
        o.canCancel = eligibility.canCancel;
        o.cannotCancelReason = eligibility.cannotCancelReason;
        o.cancellationSummary = buildCustomerCancellationSummary(o);
        o.refundSummary = buildCustomerRefundSummary(o);
        return o;
    });

    res.status(200).json({
        success: true,
        orders: enrichedOrders,
        pagination: { page, limit, totalCount: total, totalPages: Math.ceil(total / limit) },
    });
});

/** GET /api/order/:id — single order details (own order only) */
const getOrderById = asyncHandler(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id, isGuest: { $ne: true } })
        .populate("items.productId", "name mainImage")
        .select("-payment.checkoutTokenHash -payment.razorpaySignature");

    if (!order) throw new AppError("Order not found", 404);

    const o = order.toObject ? order.toObject() : { ...order };
    const eligibility = evaluateCancellationEligibility(o, { isCustomer: true });
    o.canCancel = eligibility.canCancel;
    o.cannotCancelReason = eligibility.cannotCancelReason;
    o.cancellationSummary = buildCustomerCancellationSummary(o);
    o.refundSummary = buildCustomerRefundSummary(o);

    res.status(200).json({ success: true, order: o });
});

/**
 * POST /api/order/:id/cancel — Customer cancellation endpoint
 */
const cancelUserOrder = asyncHandler(async (req, res) => {
    const { reason, details } = req.body || {};
    if (!reason || typeof reason !== "string" || !reason.trim()) {
        throw new AppError("A cancellation reason is required.", 400);
    }
    const cleanReason = String(reason).trim().slice(0, 200);
    const cleanDetails = details ? String(details).trim().slice(0, 500) : "";
    const fullReason = cleanDetails ? `${cleanReason}: ${cleanDetails}` : cleanReason;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        throw new AppError("Order not found", 404);
    }

    // Resolve order with BOTH order ID AND authenticated owner ID
    const order = await Order.findOne({
        _id: req.params.id,
        user: req.user._id,
        isGuest: { $ne: true },
    });
    if (!order) {
        throw new AppError("Order not found", 404);
    }

    const result = await processOrderCancellation(order._id, {
        reason: fullReason,
        cancelledBy: "customer",
        actorId: req.user._id,
    });

    const eligibility = evaluateCancellationEligibility(result.order, { isCustomer: true });
    const orderSummary = result.order.toObject ? result.order.toObject() : { ...result.order };
    orderSummary.canCancel = eligibility.canCancel;
    orderSummary.cannotCancelReason = eligibility.cannotCancelReason;
    orderSummary.cancellationSummary = buildCustomerCancellationSummary(result.order);
    orderSummary.refundSummary = buildCustomerRefundSummary(result.order);

    res.status(200).json({
        success: true,
        finalized: result.finalized,
        confirmationPending: result.confirmationPending || false,
        alreadyCancelled: result.alreadyCancelled || false,
        courierOutcome: result.courierOutcome,
        refund: orderSummary.refundSummary,
        message: result.message,
        order: orderSummary,
    });
});

/** GET /api/order/:id/track — live tracking (owner) */
const trackOrder = asyncHandler(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id, isGuest: { $ne: true } });
    if (!order) throw new AppError("Order not found", 404);

    // Single normalization layer with short cache + stored-status fallback, so a
    // slow courier API can never block this response (spec §8).
    const tracking = await resolveTracking(
        `awb:${order.shiprocket.awbCode || order.shiprocket.orderId || order._id}`,
        () =>
            order.shiprocket.awbCode
                ? shiprocket.trackByAWB(order.shiprocket.awbCode)
                : shiprocket.trackByShiprocketOrderId(order.shiprocket.orderId),
        order.shiprocket.status ? { current_status: order.shiprocket.status } : null
    );

    if (tracking) await syncOrderFromShipment(order, tracking);

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

/** POST /api/order/track-public — public tracking (AWB, or Order ID + email) */
const trackOrderPublic = asyncHandler(async (req, res) => {
    const { orderId, email, awb } = req.body;

    // Case 1: Direct AWB tracking — shipping status only, no PII.
    if (awb && typeof awb === "string" && awb.trim()) {
        const cleanAwb = awb.trim();
        if (cleanAwb.length > 40 || !/^[\w-]+$/.test(cleanAwb)) {
            throw new AppError("Invalid tracking number.", 400);
        }
        // Resolve the order doc first so its stored courier status can serve as
        // a last-known fallback if the external lookup fails or times out.
        const matchedDoc = await Order.findOne({ "shiprocket.awbCode": cleanAwb });
        const fallbackRaw = matchedDoc?.shiprocket?.status
            ? { current_status: matchedDoc.shiprocket.status }
            : null;
        let trackingError = null;
        const tracking = await resolveTracking(
            `awb:${cleanAwb}`,
            () => shiprocket.trackByAWB(cleanAwb),
            fallbackRaw
        );
        trackingError = tracking?.currentStatus ? null : "Live tracking unavailable — showing last known status";
        // Case 1 still needs the deferred sync below
        if (matchedDoc && tracking) await syncOrderFromShipment(matchedDoc, tracking);

        if (!tracking && !matchedDoc) {
            throw new AppError("No shipment found for the provided AWB / Tracking number.", 404);
        }

        return res.status(200).json({
            success: true,
            trackType: "awb",
            awb: cleanAwb,
            order: matchedDoc ? {
                orderId: matchedDoc.orderId,
                status: matchedDoc.status,
                shiprocket: {
                    courierName: matchedDoc.shiprocket?.courierName,
                    awbCode: matchedDoc.shiprocket?.awbCode,
                    trackingUrl: matchedDoc.shiprocket?.trackingUrl || (matchedDoc.shiprocket?.awbCode ? `https://shiprocket.co/tracking/${matchedDoc.shiprocket.awbCode}` : null),
                    status: matchedDoc.shiprocket?.status,
                },
                timeline: matchedDoc.timeline,
                createdAt: matchedDoc.createdAt,
            } : null,
            tracking: sanitizeTrackingForPublic(tracking),
            trackingError,
        });
    }

    // Case 2: Order ID + Email. Normalized LITERAL equality (order ids are
    // generated uppercase; emails are stored lowercased). The legacy
    // {$eq: v, $options: "i"} form is invalid Mongo and never case-insensitive.
    if (!orderId || typeof orderId !== "string") {
        throw new AppError("Please provide an Order ID or AWB Tracking Number.", 400);
    }
    if (!email || typeof email !== "string" || !email.trim()) {
        throw new AppError("Please provide the email address used on this order.", 400);
    }

    const cleanOrderId = orderId.trim().toUpperCase().slice(0, 40);
    const cleanEmail = email.trim().toLowerCase().slice(0, 200);

    const order = await Order.findOne({
        $or: [{ orderId: cleanOrderId }, { "shiprocket.awbCode": cleanOrderId }],
        "shippingAddress.email": cleanEmail,
    }).lean();

    if (!order) {
        throw new AppError("No order found matching this Order ID and Email.", 404);
    }

    const trackKey = `awb:${order.shiprocket?.awbCode || order.shiprocket?.orderId || order._id}`;
    const trackFallback = order.shiprocket?.status ? { current_status: order.shiprocket.status } : null;
    let tracking = null;
    if (order.shiprocket?.awbCode || order.shiprocket?.orderId) {
        tracking = await resolveTracking(
            trackKey,
            () =>
                order.shiprocket?.awbCode
                    ? shiprocket.trackByAWB(order.shiprocket.awbCode)
                    : shiprocket.trackByShiprocketOrderId(order.shiprocket.orderId),
            trackFallback
        );
    }

    if (tracking) {
        const orderDoc = await Order.findById(order._id);
        if (orderDoc) {
            await syncOrderFromShipment(orderDoc, tracking);
            order.status = orderDoc.status;
            order.timeline = orderDoc.timeline;
            order.shiprocket = { ...(order.shiprocket || {}), status: orderDoc.shiprocket.status };
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
        tracking: sanitizeTrackingForPublic(tracking),
    });
});

// ---------------------------------------------------------------------------
// ADMIN ENDPOINTS
// ---------------------------------------------------------------------------

/** GET /api/order/admin/all — all orders with search, status filter, and pagination */
const getAllOrders = asyncHandler(async (req, res) => {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const status = req.query.status;

    const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim() : (typeof req.query.q === 'string' ? req.query.q.trim() : '');
    const search = escapeRegex(rawSearch);

    const andClauses = [];

    // Status filter
    if (status && status !== 'all') {
        if (status === 'hold') {
            andClauses.push({ 'fulfillmentHold.active': true });
        } else {
            andClauses.push({ status });
        }
    }

    // Search filter across order ID, recipient name/email/phone, gateway ID, and user account
    if (search) {
        const searchRegex = new RegExp(search, 'i');
        let matchingUserIds = [];
        try {
            const matchingUsers = await User.find({
                $or: [
                    { name: searchRegex },
                    { email: searchRegex },
                    { phone: searchRegex },
                ],
            }).select('_id').lean();
            matchingUserIds = matchingUsers.map((u) => u._id);
        } catch (e) {
            matchingUserIds = [];
        }

        const searchOr = [
            { orderId: searchRegex },
            { 'shippingAddress.firstName': searchRegex },
            { 'shippingAddress.lastName': searchRegex },
            { 'shippingAddress.email': searchRegex },
            { 'shippingAddress.phone': searchRegex },
            { 'payment.razorpayPaymentId': searchRegex },
        ];

        if (matchingUserIds.length > 0) {
            searchOr.push({ user: { $in: matchingUserIds } });
        }

        andClauses.push({ $or: searchOr });
    }

    const filter = andClauses.length > 0 ? { $and: andClauses } : {};

    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .populate('user', 'name email phone')
            .select('-__v -payment.checkoutTokenHash -payment.razorpaySignature'),
        Order.countDocuments(filter),
    ]);

    res.status(200).json({
        success: true,
        orders,
        pagination: { page, limit, totalCount: total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
});

/** PUT /api/order/admin/:id/status — update order status */
const updateOrderStatus = asyncHandler(async (req, res) => {
    const { status, description, override, overrideReason } = req.body;

    // Cancellation runs through the dedicated handler (courier cancel, refund, gated stock release)
    if (status === "cancelled") {
        return cancelOrder(req, res);
    }

    const { order, changed } = await executeOrderTransition(req.params.id, status, {
        description,
        adminUser: req.admin,
        isOverride: !!override,
        overrideReason: overrideReason || (override ? description : ""),
    });

    res.status(200).json({ success: true, order, changed });
});

/**
 * POST /api/order/admin/:id/cancel — cancel with EXPLICIT lifecycle steps via shared service
 */
const cancelOrder = asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found", 404);

    const result = await processOrderCancellation(order._id, {
        reason: req.body.reason || "Order cancelled by admin",
        cancelledBy: "admin",
        actorId: req.user?._id || null,
    });

    res.status(200).json({
        success: true,
        order: result.order,
        refund: result.refund,
        courierCancel: result.courierOutcome,
        finalized: result.finalized,
        message: result.message,
    });
});

/** POST /api/order/admin/:id/refund — initiate/refresh a refund */
const adminRefundOrder = asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found", 404);

    // Reconcile an existing in-flight refund first (covers lost-save and
    // repeated admin clicks); adopt orphan refunds created at the gateway.
    if (order.refund?.razorpayRefundId) {
        await reconcileRefund(order);
    } else if (order.payment.razorpayPaymentId) {
        const adopted = await adoptOrphanRefund(order);
        if (adopted) {
            return res.status(200).json({ success: true, refund: adopted, order, message: "Existing gateway refund reconciled" });
        }
    }

    const refund = await refundPaidOrder(order, req.body.reason || "Refund issued by store");

    res.status(200).json({
        success: true,
        refund,
        order,
        message: `Refund ${refund.status} — ${refund.id}`,
    });
});

/** POST /api/order/admin/:id/push-shiprocket — resumable courier push */
const adminPushToShiprocket = asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found", 404);

    if (["cancelled", "returned"].includes(order.status)) {
        throw new AppError("Cannot push a cancelled/returned order.", 400);
    }
    if (order.payment.method !== "cod" && order.payment.status !== "paid") {
        throw new AppError("Cannot push an unpaid order. Payment must be completed first.", 400);
    }
    if (order.fulfillment?.stage === "complete") {
        return res.status(200).json({ success: true, order, message: "Fulfillment pipeline already complete" });
    }

    await pushToShiprocket(order);

    const fresh = await Order.findById(req.params.id);
    res.status(200).json({
        success: true,
        order: fresh,
        message: fresh.fulfillment?.lastError
            ? `Push incomplete — stage: ${fresh.fulfillment.stage || "none"}; error: ${fresh.fulfillment.lastError}`
            : `Push processed — stage: ${fresh.fulfillment?.stage || "none"}`,
    });
});

/**
 * GET /api/order/check-serviceability?pincode=...&cod=...
 * Public serviceability check endpoint for frontend / customer checkout.
 */
const checkDeliveryServiceability = asyncHandler(async (req, res) => {
    const { pincode, cod } = req.query;
    if (!pincode) {
        throw new AppError("PIN code is required.", 400);
    }
    const isCod = cod === "true" || cod === "1";
    const result = await shiprocket.checkPincodeServiceability(pincode, { isCod });
    res.status(200).json({
        success: true,
        pincode: String(pincode).trim(),
        ...result,
    });
});

/**
 * POST /api/order/admin/:id/cod-reconcile
 * Admin endpoint to explicitly reconcile COD cash collection and courier remittance.
 */
const codReconcileOrder = asyncHandler(async (req, res) => {
    const { action, amount, utr, notes, discrepancyReason } = req.body || {};
    if (!["confirm_remittance", "record_discrepancy", "confirm_collection"].includes(action)) {
        throw new AppError("Valid action ('confirm_remittance', 'record_discrepancy', 'confirm_collection') is required.", 400);
    }

    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found", 404);
    if (order.payment?.method !== "cod") {
        throw new AppError("Only Cash on Delivery (COD) orders can be reconciled through this workflow.", 400);
    }

    const adminEmail = req.admin?.email || req.user?.email || "admin";
    order.codAccounting = order.codAccounting || {
        amountDuePaise: toPaise(order.pricing?.total || 0),
        remittanceStatus: "none",
    };

    if (action === "confirm_collection") {
        order.codAccounting.collectedAtDelivery = true;
        order.codAccounting.collectedAmountPaise = toPaise(amount ?? order.pricing?.total ?? 0);
        order.codAccounting.collectedAt = new Date();
        order.codAccounting.reconciledBy = adminEmail;
        if (notes) order.codAccounting.notes = notes;
        order.timeline.push({
            status: "COD Cash Collection Confirmed",
            description: `Cash collection of ₹${toRupees(order.codAccounting.collectedAmountPaise)} confirmed by ${adminEmail}.${notes ? " Notes: " + notes : ""}`,
            date: new Date(),
        });
    } else if (action === "confirm_remittance") {
        const remittedPaise = amount !== undefined ? toPaise(amount) : (order.codAccounting.amountDuePaise || toPaise(order.pricing?.total || 0));
        order.codAccounting.remittanceStatus = "remitted";
        order.codAccounting.remittedAmountPaise = remittedPaise;
        order.codAccounting.remittedAt = new Date();
        order.codAccounting.utr = utr ? String(utr).trim() : undefined;
        order.codAccounting.reconciledBy = adminEmail;
        if (notes) order.codAccounting.notes = notes;
        // Bank funds are verified received: mark payment paid
        order.payment.status = "paid";
        order.payment.amountPaid = remittedPaise;
        order.timeline.push({
            status: "COD Remittance Confirmed",
            description: `Courier remittance of ₹${toRupees(remittedPaise)} verified in bank by ${adminEmail}.${utr ? " UTR: " + utr : ""}${notes ? " Notes: " + notes : ""}`,
            date: new Date(),
        });
    } else if (action === "record_discrepancy") {
        if (!discrepancyReason) {
            throw new AppError("A reason is required when recording a remittance discrepancy.", 400);
        }
        order.codAccounting.remittanceStatus = "discrepancy";
        order.codAccounting.discrepancyReason = String(discrepancyReason).trim();
        order.codAccounting.reconciledBy = adminEmail;
        if (notes) order.codAccounting.notes = notes;
        order.timeline.push({
            status: "COD Remittance Discrepancy",
            description: `Discrepancy recorded by ${adminEmail}: ${discrepancyReason}`,
            date: new Date(),
        });
    }

    await order.save();
    res.status(200).json({
        success: true,
        message: `COD order reconciled (${action}).`,
        order,
    });
});

/**
 * POST /api/order/admin/:id/confirm-return
 * Explicit audited physical return receipt confirmation.
 * Restores product stock exactly once if restock is true.
 */
const confirmReturnOrder = asyncHandler(async (req, res) => {
    const { restock = true, condition = "intact", notes } = req.body || {};
    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found", 404);

    const adminEmail = req.admin?.email || req.user?.email || "admin";

    if (!restock || condition === "damaged" || condition === "defective") {
        order.returnInfo = order.returnInfo || {};
        order.returnInfo.status = "confirmed";
        order.returnInfo.confirmedAt = new Date();
        order.returnInfo.stockRestored = false;
        order.status = "returned";
        const reasonDesc = `Physical return received by ${adminEmail} (condition: ${condition}, non-restocked).${notes ? " Notes: " + notes : ""}`;
        order.timeline.push({
            status: "Physical Return Confirmed (No Restock)",
            description: reasonDesc,
            date: new Date(),
        });
        await order.save();
        return res.status(200).json({
            success: true,
            stockRestored: false,
            message: "Physical return recorded without restocking.",
            order,
        });
    }

    const result = await confirmPhysicalReturn(order._id, {
        description: `Physical return verified and restocked by ${adminEmail}.${notes ? " Notes: " + notes : ""}`,
    });

    const fresh = await Order.findById(order._id);
    res.status(200).json({
        success: true,
        stockRestored: !result.alreadyRestored,
        alreadyRestored: result.alreadyRestored || false,
        message: result.alreadyRestored
            ? "Physical return was already previously confirmed and restocked."
            : "Physical return confirmed and inventory restored.",
        order: fresh,
    });
});

/**
 * POST /api/order/admin/:id/resolve-hold
 * Explicit administrative review and resolution for fulfillment holds.
 */
const resolveHoldOrder = asyncHandler(async (req, res) => {
    const { action = "clear_hold", notes } = req.body || {};
    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found", 404);

    if (!order.fulfillmentHold?.active) {
        return res.status(200).json({ success: true, message: "No active hold on this order.", order });
    }

    const adminEmail = req.admin?.email || req.user?.email || "admin";

    if (action === "cancel_order") {
        const cancelResult = await processOrderCancellation(order._id, {
            reason: notes || "Cancelled by admin after fulfillment hold review",
            cancelledBy: "admin",
            actorId: req.user?._id || null,
        });
        return res.status(200).json({
            success: true,
            message: "Order cancelled following hold resolution.",
            order: cancelResult.order,
        });
    }

    // Clear hold
    order.fulfillmentHold.active = false;
    order.fulfillmentHold.reallocationOutcome = "success";
    order.timeline.push({
        status: "Fulfillment Hold Resolved",
        description: `Hold cleared by ${adminEmail}.${notes ? " Notes: " + notes : ""}`,
        date: new Date(),
    });
    await order.save();

    res.status(200).json({
        success: true,
        message: "Fulfillment hold cleared successfully.",
        order,
    });
});

/**
 * POST /api/order/shiprocket-webhook
 * Inbound authenticated provider webhook for real-time tracking updates.
 */
const handleShiprocketWebhook = asyncHandler(async (req, res) => {
    const payload = req.body;
    if (!payload) {
        return res.status(400).json({ success: false, message: "Empty webhook payload" });
    }

    const webhookToken = process.env.SHIPROCKET_WEBHOOK_TOKEN;
    if (webhookToken) {
        const incomingToken = req.headers["x-api-key"] || req.query.token;
        if (incomingToken !== webhookToken) {
            return res.status(401).json({ success: false, message: "Unauthorized webhook" });
        }
    }

    const awb = payload.awb || payload.awb_code || payload.tracking_data?.shipment_track?.[0]?.awb_code;
    const srOrderId = payload.order_id || payload.sr_order_id;

    if (!awb && !srOrderId) {
        return res.status(200).json({ success: true, message: "Ignored payload with no tracking identifier" });
    }

    const order = await Order.findOne({
        $or: [
            ...(awb ? [{ "shiprocket.awbCode": awb }] : []),
            ...(srOrderId ? [{ "shiprocket.orderId": srOrderId }] : []),
        ],
    });

    if (!order) {
        return res.status(200).json({ success: true, message: "No matching order found" });
    }

    await syncOrderFromShipment(order, payload);
    res.status(200).json({ success: true, processed: true, orderId: order.orderId });
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
    cancelUserOrder,
    adminRefundOrder,
    adminPushToShiprocket,


    verifyPayment,
    handleRazorpayWebhook,
    checkDeliveryServiceability,
    codReconcileOrder,
    confirmReturnOrder,
    resolveHoldOrder,
    handleShiprocketWebhook,
};

// Shared with the reservation sweeper (internal job, no public HTTP surface).
// Only the webhook-specific entity parser + a couple of thin wrappers live here;
// payment/inventory/fulfillment/refund transitions come from the shared services.
export const __lifecycle = {
    releaseOrderResources,
    processWebhookEventDoc,
    settleCartAfterPayment,
    fulfillPaidOrder,
    pushToShiprocket,
    RESERVATION_WINDOW_MS,
};

// Test-only surface: side-effect-free pure helpers so the node:test suite can
// assert money/tracking/webhook/entity logic without a DB, gateway or network.
// This is a module export, NOT an HTTP route — it adds no public API surface.
export const __test = {
    mapShipmentStatus,
    normalizeTrackingResult,
    sanitizeTrackingForPublic,
    eventEntity,
    STATUS_RANK,
    isPlainString,
    RESERVATION_WINDOW_MS,
    // Checkout pre-flight contract: collection creation is fatal, index building
    // is not. Asserted in tests/core-logic.test.js with fake models (no DB).
    prepareCollection,
    CHECKOUT_COLLECTION_MODELS,
    buildCheckoutOrderResponse,
    decidePaymentReconciliationOutcome,
};
