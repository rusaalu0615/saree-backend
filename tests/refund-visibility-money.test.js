import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    toPaise,
    paiseToRupees,
    toRupees,
    formatPaiseAsINR,
    formatRupeesAsINR,
} from "../utils/security.js";
import { buildCustomerRefundSummary } from "../services/orderCancellation.js";
import {
    sendOrderCancelledEmail,
    setTransporterForTest,
} from "../services/emailService.js";
import {
    buildCheckoutOrderResponse,
    buildCustomerOrderSummary,
} from "../controllers/orderController.js";

describe("Strict Money Conversion Helpers (Paise vs Rupees)", () => {
    test("1 paise formats as ₹0.01", () => {
        assert.equal(paiseToRupees(1), 0.01);
        assert.equal(formatPaiseAsINR(1), "0.01");
    });

    test("50 paise formats as ₹0.50", () => {
        assert.equal(paiseToRupees(50), 0.5);
        assert.equal(formatPaiseAsINR(50), "0.50");
    });

    test("100 paise formats as ₹1 (acceptance test)", () => {
        assert.equal(paiseToRupees(100), 1);
        assert.equal(formatPaiseAsINR(100), "1");
    });

    test("150 paise formats as ₹1.50", () => {
        assert.equal(paiseToRupees(150), 1.5);
        assert.equal(formatPaiseAsINR(150), "1.50");
    });

    test("10000 paise formats as ₹100", () => {
        assert.equal(paiseToRupees(10000), 100);
        assert.equal(formatPaiseAsINR(10000), "100");
    });

    test("249900 paise formats as ₹2,499", () => {
        assert.equal(paiseToRupees(249900), 2499);
        assert.equal(formatPaiseAsINR(249900), "2,499");
    });

    test("formatRupeesAsINR formats whole and fractional rupee values cleanly", () => {
        assert.equal(formatRupeesAsINR(1), "1");
        assert.equal(formatRupeesAsINR(1.5), "1.50");
        assert.equal(formatRupeesAsINR(100), "100");
        assert.equal(formatRupeesAsINR(2499), "2,499");
        assert.equal(formatRupeesAsINR(0), "0");
    });
});

describe("ISSUE 1: Customer Refund Summary Visibility & Boundary Rules", () => {
    test("Normal paid prepaid order with NO cancellation and NO refund record MUST return null", () => {
        const order = {
            orderId: "HL-PAID-001",
            status: "placed",
            payment: {
                method: "upi",
                status: "paid",
                amountPaid: 249900,
            },
            pricing: { total: 2499 },
            cancellation: null,
            refund: null,
        };

        const summary = buildCustomerRefundSummary(order);
        assert.equal(summary, null, "Normal paid order must NEVER generate a refundSummary");
    });

    test("Normal COD order MUST return null", () => {
        const order = {
            orderId: "HL-COD-001",
            status: "placed",
            payment: {
                method: "cod",
                status: "pending",
            },
            pricing: { total: 2499 },
            cancellation: null,
            refund: null,
        };

        const summary = buildCustomerRefundSummary(order);
        assert.equal(summary, null, "COD order must never return refundSummary");
    });

    test("Cancelled COD order MUST return null (no money collected, no refund)", () => {
        const order = {
            orderId: "HL-COD-CANCEL-001",
            status: "cancelled",
            payment: {
                method: "cod",
                status: "cancelled",
            },
            pricing: { total: 2499 },
            cancellation: { status: "completed" },
            refund: null,
        };

        const summary = buildCustomerRefundSummary(order);
        assert.equal(summary, null, "Cancelled COD must never return refundSummary");
    });

    test("Cancelled unpaid prepaid order MUST return null", () => {
        const order = {
            orderId: "HL-UNPAID-CANCEL-001",
            status: "cancelled",
            payment: {
                method: "card",
                status: "pending",
                amountPaid: 0,
            },
            pricing: { total: 2499 },
            cancellation: { status: "completed" },
            refund: null,
        };

        const summary = buildCustomerRefundSummary(order);
        assert.equal(summary, null, "Cancelled unpaid order must never return refundSummary");
    });

    test("Cancelled paid prepaid order with pending refund returns pending refund summary", () => {
        const order = {
            orderId: "HL-PAID-CANCEL-001",
            status: "cancelled",
            payment: {
                method: "upi",
                status: "paid",
                amountPaid: 249900,
            },
            pricing: { total: 2499 },
            cancellation: { status: "completed" },
            refund: { status: "pending", requestedAmountPaise: 249900 },
        };

        const summary = buildCustomerRefundSummary(order);
        assert.ok(summary);
        assert.equal(summary.status, "pending");
        assert.equal(summary.amountPaise, 249900);
        assert.equal(summary.amountRupees, 2499);
        assert.equal(summary.formattedRupees, "2,499");
    });

    test("Order with ₹1 refund (100 paise) returns amountRupees: 1 and formattedRupees: '1'", () => {
        const order = {
            orderId: "HL-1RUPEE-001",
            status: "cancelled",
            payment: {
                method: "upi",
                status: "paid",
                amountPaid: 100,
            },
            pricing: { total: 1 },
            cancellation: { status: "completed" },
            refund: { status: "processed", amountPaise: 100 },
        };

        const summary = buildCustomerRefundSummary(order);
        assert.ok(summary);
        assert.equal(summary.status, "processed");
        assert.equal(summary.amountPaise, 100);
        assert.equal(summary.amountRupees, 1);
        assert.equal(summary.formattedRupees, "1");
    });

    test("Partial refund: returns partial refund amount without falling back to full order total", () => {
        const order = {
            orderId: "HL-PARTIAL-001",
            status: "placed",
            payment: {
                method: "card",
                status: "paid",
                amountPaid: 249900,
                refundedAmount: 50000,
            },
            pricing: { total: 2499 },
            refund: { status: "processed", amountPaise: 50000 },
        };

        const summary = buildCustomerRefundSummary(order);
        assert.ok(summary);
        assert.equal(summary.status, "processed");
        assert.equal(summary.amountPaise, 50000);
        assert.equal(summary.amountRupees, 500);
        assert.equal(summary.formattedRupees, "500");
    });

    test("Failed refund returns status: 'failed'", () => {
        const order = {
            orderId: "HL-FAILED-REFUND-001",
            status: "cancelled",
            payment: {
                method: "upi",
                status: "paid",
                amountPaid: 150000,
            },
            pricing: { total: 1500 },
            cancellation: { status: "completed" },
            refund: { status: "failed", requestedAmountPaise: 150000 },
        };

        const summary = buildCustomerRefundSummary(order);
        assert.ok(summary);
        assert.equal(summary.status, "failed");
        assert.equal(summary.amountRupees, 1500);
    });
});

describe("ISSUE 2: Cancellation Email Refund Amount Formatting", () => {
    let sentMails = [];

    beforeEach(() => {
        process.env.EMAIL_USER = "test@example.com";
        process.env.EMAIL_PASS = "testpass";
        sentMails = [];
        setTransporterForTest({
            sendMail: async (options) => {
                sentMails.push(options);
                return { messageId: "mock-123" };
            },
        });
    });

    afterEach(() => {
        setTransporterForTest(null);
    });

    test("ACCEPTANCE TEST: ₹1 refund (refund.amountPaise = 100) says 'Refund of ₹1', NOT 'Refund of ₹100'", async () => {
        const order = {
            orderId: "ORD-1RUPEE-TEST",
            shippingAddress: { firstName: "Aarav", email: "aarav@example.com" },
            cancellation: { reason: "Changed mind", status: "completed" },
            payment: { method: "upi", status: "paid", amountPaid: 100 },
            pricing: { total: 1 },
            refund: { amountPaise: 100, status: "pending" },
        };

        await sendOrderCancelledEmail(order);
        assert.equal(sentMails.length, 1);
        const html = sentMails[0].html;

        assert.match(html, /Refund of ₹1\b/);
        assert.doesNotMatch(html, /Refund of ₹100\b/);
    });

    test("50 paise refund says 'Refund of ₹0.50'", async () => {
        const order = {
            orderId: "ORD-50P-TEST",
            shippingAddress: { firstName: "Priya", email: "priya@example.com" },
            cancellation: { reason: "Damaged", status: "completed" },
            payment: { method: "upi", status: "paid", amountPaid: 50 },
            pricing: { total: 0.5 },
            refund: { amountPaise: 50, status: "pending" },
        };

        await sendOrderCancelledEmail(order);
        assert.equal(sentMails.length, 1);
        const html = sentMails[0].html;
        assert.match(html, /Refund of ₹0\.50/);
    });

    test("150 paise refund says 'Refund of ₹1.50'", async () => {
        const order = {
            orderId: "ORD-150P-TEST",
            shippingAddress: { firstName: "Rohan", email: "rohan@example.com" },
            cancellation: { reason: "Wrong item", status: "completed" },
            payment: { method: "card", status: "paid", amountPaid: 150 },
            pricing: { total: 1.5 },
            refund: { amountPaise: 150, status: "pending" },
        };

        await sendOrderCancelledEmail(order);
        assert.equal(sentMails.length, 1);
        const html = sentMails[0].html;
        assert.match(html, /Refund of ₹1\.50/);
    });

    test("Standard ₹2,499 refund (249900 paise) says 'Refund of ₹2,499'", async () => {
        const order = {
            orderId: "ORD-2499-TEST",
            shippingAddress: { firstName: "Ananya", email: "ananya@example.com" },
            cancellation: { reason: "Duplicate order", status: "completed" },
            payment: { method: "upi", status: "paid", amountPaid: 249900 },
            pricing: { total: 2499 },
            refund: { amountPaise: 249900, status: "pending" },
        };

        await sendOrderCancelledEmail(order);
        assert.equal(sentMails.length, 1);
        const html = sentMails[0].html;
        assert.match(html, /Refund of ₹2,499/);
    });

    test("COD cancellation says 'Cash on Delivery (no payment was collected)' without monetary refund note", async () => {
        const order = {
            orderId: "ORD-COD-CANCEL-TEST",
            shippingAddress: { firstName: "Sunil", email: "sunil@example.com" },
            cancellation: { reason: "Mistake", status: "completed" },
            payment: { method: "cod", status: "cancelled" },
            pricing: { total: 2499 },
            refund: null,
        };

        await sendOrderCancelledEmail(order);
        assert.equal(sentMails.length, 1);
        const html = sentMails[0].html;
        assert.match(html, /Cash on Delivery \(no payment was collected\)/);
        assert.doesNotMatch(html, /Refund of ₹/);
    });
});

describe("Customer Order Summaries & Zero-Payable Separation", () => {
    test("Zero-payable 100% coupon order is explicitly marked isZeroPayable: true", () => {
        const order = {
            orderId: "ORD-ZERO-001",
            _id: "mongo-zero-1",
            status: "placed",
            payment: { method: "coupon", status: "paid" },
            pricing: { subtotal: 1000, shipping: 0, discount: 1000, total: 0 },
            shippingAddress: { firstName: "Kavita", email: "kavita@example.com" },
        };

        const summary = buildCustomerOrderSummary(order);
        assert.equal(summary.isZeroPayable, true);
        assert.equal(summary.pricing.total, 0);

        const checkoutResp = buildCheckoutOrderResponse(order);
        assert.equal(checkoutResp.isZeroPayable, true);
        assert.equal(checkoutResp.outcome, "paid_settled");
    });

    test("Standard paid order (₹2,499) is NOT zero-payable", () => {
        const order = {
            orderId: "ORD-STANDARD-001",
            _id: "mongo-std-1",
            status: "placed",
            payment: { method: "upi", status: "paid" },
            pricing: { subtotal: 2499, shipping: 0, discount: 0, total: 2499 },
            shippingAddress: { firstName: "Ramesh", email: "ramesh@example.com" },
        };

        const summary = buildCustomerOrderSummary(order);
        assert.equal(summary.isZeroPayable, false);
        assert.equal(summary.pricing.total, 2499);

        const checkoutResp = buildCheckoutOrderResponse(order);
        assert.equal(checkoutResp.isZeroPayable, false);
        assert.equal(checkoutResp.total, 2499);
    });
});

