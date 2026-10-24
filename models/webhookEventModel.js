import mongoose from "mongoose";

/**
 * Durable Razorpay webhook event log.
 *
 * The webhook handler persists each event BEFORE acknowledging it, so:
 *  - a crash during processing loses nothing (the sweeper replays processed:false)
 *  - duplicate deliveries are detected by the unique gateway event id
 *  - we never return 200 for an event we failed to durably accept
 */
const webhookEventSchema = new mongoose.Schema({
    // Razorpay's unique event id — dedupe key. Falls back to a content hash.
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    // Related razorpay order id (indexed for replay lookups)
    razorpayOrderId: String,
    payload: { type: mongoose.Schema.Types.Mixed },
    processed: { type: Boolean, default: false },
    retries: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 20 },
    lastError: String,
    processedAt: Date,
    // A payment event whose local order mapping is not visible YET must stay
    // retryable (UNMATCHED), never be burned as permanently processed.
    state: { type: String, enum: ["pending", "in_flight", "processed", "unmatched", "manual_review"], default: "pending", index: true },
    // Cross-instance claim so two app instances never process one event twice.
    leaseOwner: String,
    leaseExpiresAt: Date,
    nextAttemptAt: { type: Date, default: Date.now },
}, { timestamps: true });

webhookEventSchema.index({ processed: 1, createdAt: 1 });
webhookEventSchema.index({ state: 1, nextAttemptAt: 1 });

export default mongoose.model("WebhookEvent", webhookEventSchema);
