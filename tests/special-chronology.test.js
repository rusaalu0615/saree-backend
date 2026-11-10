import test from "node:test";
import assert from "node:assert/strict";
import { syncOrderFromShipment } from "../controllers/orderController.js";

const makeMockOrder = (initial = {}) => ({
    orderId: initial.orderId || "TEST-ORD-CHRONO-1",
    status: initial.status || "shipped",
    cancellation: initial.cancellation || { status: "none" },
    delivery: {
        status: initial.deliveryStatus || null,
        lastEventAt: initial.lastEventAt ? new Date(initial.lastEventAt) : null,
        rawStatus: initial.rawStatus || null,
        rawStatusCode: initial.rawStatusCode || null,
        expectedDeliveryAt: initial.expectedDeliveryAt || null,
        lastSyncedAt: null,
    },
    shiprocket: {
        awbCode: initial.awbCode || "AWB-INITIAL",
        courierName: initial.courierName || "Bluedart",
        trackingUrl: initial.trackingUrl || null,
    },
    saveCount: 0,
    async save() {
        this.saveCount++;
        return this;
    },
});

test("Test A: Older RTO stage ignored (rto_out_for_delivery at T2, incoming rto_in_transit at T1)", async () => {
    const t1 = "2026-11-10T10:00:00.000Z";
    const t2 = "2026-11-10T14:00:00.000Z";

    const order = makeMockOrder({
        deliveryStatus: "rto_out_for_delivery",
        lastEventAt: t2,
        rawStatus: "RTO Out For Delivery",
        rawStatusCode: "19",
    });

    const olderPayload = {
        __canonical: true,
        mappedStatus: "rto_in_transit",
        currentStatus: "RTO In Transit",
        eventTime: t1,
        rawStatus: 18,
    };

    await syncOrderFromShipment(order, olderPayload);

    // Status and lastEventAt must remain at newer stage (T2)
    assert.equal(order.delivery.status, "rto_out_for_delivery");
    assert.equal(order.delivery.lastEventAt.toISOString(), t2);
    assert.equal(order.delivery.rawStatus, "RTO Out For Delivery");
    assert.ok(order.delivery.lastSyncedAt instanceof Date);
    assert.ok(order.saveCount >= 1, "Order save should be called to update lastSyncedAt");
});

test("Test B: Older exceptional event ignored (rto_delivered at T2, incoming damaged at T1, safe metadata refreshes)", async () => {
    const t1 = "2026-11-10T08:00:00.000Z";
    const t2 = "2026-11-10T16:00:00.000Z";
    const etdDate = "2026-11-20T00:00:00.000Z";

    const order = makeMockOrder({
        deliveryStatus: "rto_delivered",
        lastEventAt: t2,
        rawStatus: "RTO Delivered",
        rawStatusCode: "20",
        awbCode: "AWB-OLD",
    });

    const olderDamagedPayload = {
        __canonical: true,
        mappedStatus: "damaged",
        currentStatus: "Damaged",
        eventTime: t1,
        rawStatus: 38,
        awb: "AWB-REFRESHED",
        courierName: "Delhivery",
        etd: etdDate,
        trackUrl: "https://track.example.com/refreshed",
    };

    await syncOrderFromShipment(order, olderDamagedPayload);

    // Delivery status must NOT regress to damaged
    assert.equal(order.delivery.status, "rto_delivered");
    assert.equal(order.delivery.lastEventAt.toISOString(), t2);
    // Safe metadata must be refreshed
    assert.equal(order.shiprocket.awbCode, "AWB-REFRESHED");
    assert.equal(order.shiprocket.courierName, "Delhivery");
    assert.equal(order.shiprocket.trackingUrl, "https://track.example.com/refreshed");
    assert.equal(order.delivery.expectedDeliveryAt.toISOString(), etdDate);
    assert.ok(order.delivery.lastSyncedAt instanceof Date);
    assert.ok(order.saveCount >= 1);
});

test("Test C: Newer legitimate exceptional event applied (in_transit at T1, incoming damaged at T2)", async () => {
    const t1 = "2026-11-10T10:00:00.000Z";
    const t2 = "2026-11-10T14:00:00.000Z";

    const order = makeMockOrder({
        deliveryStatus: "in_transit",
        lastEventAt: t1,
        rawStatus: "In Transit",
        rawStatusCode: "17",
    });

    const newerDamagedPayload = {
        __canonical: true,
        mappedStatus: "damaged",
        currentStatus: "Damaged",
        eventTime: t2,
        rawStatus: 38,
    };

    await syncOrderFromShipment(order, newerDamagedPayload);

    // Delivery status must update to damaged at T2
    assert.equal(order.delivery.status, "damaged");
    assert.equal(order.delivery.lastEventAt.toISOString(), t2);
    assert.equal(order.delivery.rawStatus, "Damaged");
    assert.equal(order.delivery.rawStatusCode, "38");
    assert.ok(order.saveCount >= 1);
});

test("Test D: Duplicate same state refreshes safe metadata without duplicate side effects", async () => {
    const t1 = "2026-11-10T10:00:00.000Z";

    const order = makeMockOrder({
        deliveryStatus: "rto_initiated",
        lastEventAt: t1,
        rawStatus: "RTO Initiated",
        rawStatusCode: "17",
        courierName: "Old Courier",
    });

    const duplicatePayload = {
        __canonical: true,
        mappedStatus: "rto_initiated",
        currentStatus: "RTO Initiated",
        eventTime: t1,
        rawStatus: 17,
        courierName: "New Courier",
        trackUrl: "https://track.example.com/duplicate",
    };

    await syncOrderFromShipment(order, duplicatePayload);

    // State remains rto_initiated and customer status is not corrupted
    assert.equal(order.delivery.status, "rto_initiated");
    assert.equal(order.delivery.lastEventAt.toISOString(), t1);
    assert.equal(order.shiprocket.courierName, "New Courier");
    assert.equal(order.shiprocket.trackingUrl, "https://track.example.com/duplicate");
    assert.equal(order.status, "shipped");
    assert.ok(order.delivery.lastSyncedAt instanceof Date);
    assert.ok(order.saveCount >= 1);
});

