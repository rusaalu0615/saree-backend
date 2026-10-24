import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema({
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true,
    },
    name: { type: String, required: true },
    slug: { type: String },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    image: String,
    sku: String,
});

const shippingAddressSchema = new mongoose.Schema({
    firstName: { type: String, required: true },
    lastName: { type: String },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
    landmark: String,
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
});

const timelineEntrySchema = new mongoose.Schema({
    status: { type: String, required: true },
    date: { type: Date, default: Date.now },
    location: String,
    description: String,
});

const orderSchema = new mongoose.Schema({
    orderId: {
        type: String,
        unique: true,
        required: true,
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    items: [orderItemSchema],
    shippingAddress: shippingAddressSchema,
    payment: {
        method: {
            type: String,
            enum: ["cod", "prepaid", "upi", "card"],
            default: "cod",
        },
        status: {
            type: String,
            enum: ["pending", "paid", "failed", "refunded"],
            default: "pending",
        },
        transactionId: String,
        razorpayOrderId: String,
        razorpayPaymentId: String,
        razorpaySignature: String,
        razorpayRefundId: String,
        // Actual amount captured by the gateway, in paise (post-coupon total).
        // Stored at payment confirmation so refunds always match real money.
        amountPaid: Number,
        // Cumulative refunded paise — double-refund protection across retries.
        refundedAmount: { type: Number, default: 0 },
        // SHA-256 of the guest checkout capability token handed to the browser
        // at order creation. Proof of "the person verifying owns this order"
        // for guests without an account session (hashed so a DB leak is useless).
        checkoutTokenHash: String,
        // Reservation expiry for unpaid prepaid orders — the sweeper reconciles
        // against Razorpay after this point and releases the hold if unpaid.
        expiresAt: Date,
    },
    // Refund lifecycle — CLAIMED + RECONCILED work, not a fire-and-forget flag.
    // status only advances from gateway-verified state; `requested` is the
    // durable intent row claimed BEFORE any external call, so an initiation
    // timeout stays reconcilable instead of being re-issued blindly.
    refund: {
        razorpayRefundId: String,
        amountPaise: Number,           // gateway-confirmed refund amount
        requestedAmountPaise: Number,  // our durable refund intent
        status: { type: String, enum: [null, "requested", "pending", "processed", "failed", "unknown"], default: null },
        initiatedAt: Date,
        verifiedAt: Date,
        // Serialization of concurrent admin/cancel/reconcile actions:
        finalized: { type: Boolean, default: false }, // totals applied exactly once
        attempts: { type: Number, default: 0 },
        leaseOwner: String,
        leaseExpiresAt: Date,
        nextAttemptAt: Date,
        lastError: String,
    },
    // ---- EXPLICIT LIFECYCLE DIMENSIONS ---------------------------------
    // order.status is a DISPLAY summary only. Business decisions read these.
    // Inventory reservation state. `held` = stock deducted & coupon claimed.
    // Release runs through an atomic claim; failure keeps durable retry work
    // (retryable + nextAttemptAt) instead of excluding the order forever.
    reservation: {
        state: { type: String, enum: ["held", "release_requested", "released", "return_pending", "return_restored"], default: "held" },
        releasedAt: Date,
        releaseReason: String,
        retryable: { type: Boolean, default: false },
        attempts: { type: Number, default: 0 },
        nextAttemptAt: Date,
        lastError: String,
    },
    // Legacy boolean kept ALIVE for backward compatibility (admin UI reads it);
    // always written together with reservation.state by the transition service.
    resourcesReleased: { type: Boolean, default: false },
    resourcesReleasedAt: Date,
    // Cancellation INTENT, kept separate from the courier OUTCOME — wanting to
    // cancel never proves the courier cancelled.
    cancellation: {
        status: { type: String, enum: ["none", "requested", "completed"], default: "none" },
        requestedAt: Date,
        reason: String,
        courierOutcome: { type: String, enum: [null, "not_needed", "confirmed", "uncertain", "failed"], default: null },
        resolvedAt: Date,
    },
    // Physical-return progression. A previously cancelled shipment can have its
    // parcel come back and restore stock WITHOUT re-opening the order status.
    returnInfo: {
        status: { type: String, enum: ["none", "expected", "confirmed"], default: "none" },
        confirmedAt: Date,
        stockRestored: { type: Boolean, default: false }, // exactly-once marker
    },
    // Idempotent checkout: the browser sends the same key for every retry of
    // the same attempt; a matching hash replays the original order instead of
    // creating a second one, a conflicting hash is rejected.
    checkoutKey: String,
    checkoutPayloadHash: String,
    // Durable, resumable Shiprocket pipeline state. pushToShiprocket resumes
    // from the persisted stage instead of redoing or skipping completed work.
    // `create_uncertain` = we asked Shiprocket to create and the outcome is
    // UNKNOWN (timeout/crash) — reconciliation via search is mandatory before
    // any second create attempt.
    fulfillment: {
        stage: {
            type: String,
            enum: [null, "none", "ready", "create_uncertain", "sr_created", "courier_pending", "courier_assigned", "pickup_pending", "pickup_requested", "complete", "needs_reconciliation", "manual_review"],
            default: null,
        },
        attempts: { type: Number, default: 0 },
        lastError: String,
        // Database-backed worker CLAIM with lease + backoff (cross-instance
        // safe — an in-memory flag is not a lock).
        lockOwner: String,
        lockUntil: Date,
        nextAttemptAt: Date,
        stageConfirmedAt: Date,
        updatedAt: Date,
        // When a create attempt became uncertain (send without a trustworthy
        // response) — drives the reconcile-grace gate before any 2nd create.
        uncertainSince: Date,
        // Real pickup date returned by the courier; scheduled pickup is NOT a
        // handover, so dispatch (return_pending) waits for actual tracking.
        pickupScheduledFor: String,
    },
    // Durable hold set when money arrived after resources had already expired
    // and been released — shipment without inventory is blocked until resolved.
    fulfillmentHold: {
        active: { type: Boolean, default: false },
        reason: String,
        reallocationOutcome: { type: String, enum: [null, "success", "unknown", "failed"], default: null },
    },
    pricing: {
        subtotal: { type: Number, required: true },
        shipping: { type: Number, default: 0 },
        discount: { type: Number, default: 0 },
        couponCode: String,
        total: { type: Number, required: true },
    },
    shiprocket: {
        orderId: Number,
        shipmentId: Number,
        awbCode: String,
        courierName: String,
        courierCompanyId: Number,
        status: String,
        trackingUrl: String,
    },
    status: {
        type: String,
        enum: [
            "placed",
            "confirmed",
            "processing",
            "shipped",
            "in_transit",
            "out_for_delivery",
            "delivered",
            "cancelled",
            "returned",
        ],
        default: "placed",
    },
    timeline: [timelineEntrySchema],
    notes: String,
}, { timestamps: true });

// Generate unique order ID
orderSchema.pre("validate", async function () {
    if (!this.orderId) {
        const date = new Date();
        const dateStr = date.toISOString().slice(0, 10).replace(/-/g, "");
        const random = Math.random().toString(36).substring(2, 6).toUpperCase();
        this.orderId = `LS-${dateStr}-${random}`;
    }
});

// Indexes for fast lookups
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ "shiprocket.awbCode": 1 });
orderSchema.index({ "shippingAddress.email": 1 });
// Gateway webhook order lookups must be indexed (unique where meaningful)
orderSchema.index({ "payment.razorpayOrderId": 1 });
orderSchema.index({ "payment.status": 1, "payment.expiresAt": 1 });
// Expired-but-unreleased recovery (payment failed while stock still held).
orderSchema.index({ "payment.status": 1, "reservation.state": 1, "fulfillmentHold.active": 1 });
orderSchema.index({ "refund.status": 1 });
orderSchema.index({ "refund.status": 1, "refund.nextAttemptAt": 1 });
// Retry idempotency: one order per checkout attempt key (sparse = COD/legacy orders exempt)
orderSchema.index({ checkoutKey: 1 }, { unique: true, sparse: true });
// Background recovery scans (all served by compound indexes, bounded batches)
orderSchema.index({ "reservation.state": 1, "reservation.retryable": 1, "reservation.nextAttemptAt": 1 });
orderSchema.index({ "fulfillment.stage": 1, "fulfillment.nextAttemptAt": 1 });
orderSchema.index({ "cancellation.status": 1 });

export default mongoose.model("Order", orderSchema);
