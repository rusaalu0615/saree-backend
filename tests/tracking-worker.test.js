import test from "node:test";
import assert from "node:assert/strict";
import Order from "../models/orderModal.js";
import shiprocket from "../services/shiprocket.js";
import {
    runTrackingSweep,
    buildCanonicalTrackingFromDetail,
    buildTrackingWorkerQuery,
    isOrderEligibleForTracking,
} from "../services/trackingWorker.js";
import { mapShipmentStatus } from "../services/shiprocketTracking.js";

test("shipmentId-only tracking worker recovery branch preserves canonical metadata", async () => {
    const testOrder = {
        _id: "mongo_test_shipment_only",
        orderId: "ORD-SHIPMENT-ONLY-1",
        status: "confirmed",
        shiprocket: {
            awbCode: null,
            shipmentId: 1712718895,
            orderId: null,
        },
        delivery: {},
        saveCount: 0,
        async save() {
            this.saveCount++;
            return this;
        },
    };

    const mockDetail = {
        shipmentId: 1712718895,
        status: 18,
        statusCode: 18,
        awb: "14112366066388",
        courier: "Xpressbees Surface",
        eventTime: "2026-11-10T10:00:00.000Z",
        etd: "2026-11-12T00:00:00.000Z",
        trackUrl: "https://shiprocket.co/tracking/14112366066388",
    };

    // Track calls to provider methods
    let trackByAWBCalled = 0;
    let getShipmentDetailCalls = [];
    let trackByOrderIdCalled = 0;
    const receivedSyncCalls = [];

    const origFind = Order.find;
    const origTrackByAWB = shiprocket.trackByAWB;
    const origGetShipmentDetail = shiprocket.getShipmentDetail;
    const origTrackByOrderId = shiprocket.trackByShiprocketOrderId;

    try {
        Order.find = () => ({
            sort: () => ({
                limit: async () => [testOrder],
            }),
        });

        shiprocket.trackByAWB = async () => {
            trackByAWBCalled++;
            return null;
        };

        shiprocket.getShipmentDetail = async (id) => {
            getShipmentDetailCalls.push(id);
            return mockDetail;
        };

        shiprocket.trackByShiprocketOrderId = async () => {
            trackByOrderIdCalled++;
            return null;
        };

        const mockSyncOrderFromShipment = async (order, tracking) => {
            receivedSyncCalls.push({ order, tracking });
            return true;
        };

        const sweepResult = await runTrackingSweep(15, {
            syncOrderFromShipment: mockSyncOrderFromShipment,
        });

        // 1. Assert provider method dispatch boundaries
        assert.equal(trackByAWBCalled, 0, "trackByAWB must NOT be called when awbCode is null");
        assert.equal(getShipmentDetailCalls.length, 1, "getShipmentDetail must be called exactly once");
        assert.equal(getShipmentDetailCalls[0], 1712718895, "getShipmentDetail must be called with order shipmentId");
        assert.equal(trackByOrderIdCalled, 0, "trackByShiprocketOrderId must NOT be called when shipmentId was resolved");

        // 2. Assert synced count increments
        assert.equal(sweepResult.synced, 1, "synced count should increment to 1");
        assert.equal(sweepResult.total, 1, "total active orders count should be 1");

        // 3. Assert syncOrderFromShipment boundary received recovered canonical tracking
        assert.equal(receivedSyncCalls.length, 1, "syncOrderFromShipment must be called with tracking payload");
        const payload = receivedSyncCalls[0].tracking;
        assert.equal(payload.__canonical, true);
        assert.equal(payload.shipmentId, 1712718895);
        assert.equal(payload.awb, "14112366066388");
        assert.equal(payload.courierName, "Xpressbees Surface");
        assert.equal(payload.eventTime, "2026-11-10T10:00:00.000Z");
        assert.equal(payload.etd, "2026-11-12T00:00:00.000Z");
        assert.equal(payload.trackUrl, "https://shiprocket.co/tracking/14112366066388");
        assert.equal(payload.mappedStatus, mapShipmentStatus(18, "order"));
        assert.equal(payload.mappedStatus, "in_transit");
    } finally {
        Order.find = origFind;
        shiprocket.trackByAWB = origTrackByAWB;
        shiprocket.getShipmentDetail = origGetShipmentDetail;
        shiprocket.trackByShiprocketOrderId = origTrackByOrderId;
    }
});

test("canonical adapter unit test: converts shipment detail and preserves all metadata", () => {
    const detail = {
        shipmentId: 1712718895,
        status: 18,
        statusCode: 18,
        awb: "14112366066388",
        courier: "Xpressbees Surface",
        eventTime: "2026-11-10T10:00:00.000Z",
        etd: "2026-11-12T00:00:00.000Z",
        trackUrl: "https://shiprocket.co/tracking/14112366066388",
    };

    const canonical = buildCanonicalTrackingFromDetail(detail, 1712718895);
    assert.deepEqual(canonical, {
        __canonical: true,
        eventTime: "2026-11-10T10:00:00.000Z",
        etd: "2026-11-12T00:00:00.000Z",
        awb: "14112366066388",
        shipmentId: 1712718895,
        courierName: "Xpressbees Surface",
        rawStatus: 18,
        shipmentStatus: 18,
        currentStatus: 18,
        mappedStatus: "in_transit",
        trackUrl: "https://shiprocket.co/tracking/14112366066388",
        activities: [],
    });
});

test("Poison-order fairness: failing old orders back off and allow healthy orders to enter next sweep", async () => {
    const baseTime = new Date("2026-11-10T10:00:00.000Z");

    const orders = [
        {
            _id: "f1",
            orderId: "ORD-FAIL-1",
            status: "processing",
            createdAt: new Date("2026-11-01T00:00:00.000Z"),
            shiprocket: { awbCode: "AWB-FAIL-1" },
            delivery: { status: "pending", trackingAttempts: 0, nextTrackingAt: null },
            saveCount: 0,
            async save() { this.saveCount++; return this; },
        },
        {
            _id: "f2",
            orderId: "ORD-FAIL-2",
            status: "processing",
            createdAt: new Date("2026-11-02T00:00:00.000Z"),
            shiprocket: { awbCode: "AWB-FAIL-2" },
            delivery: { status: "pending", trackingAttempts: 0, nextTrackingAt: null },
            saveCount: 0,
            async save() { this.saveCount++; return this; },
        },
        {
            _id: "f3",
            orderId: "ORD-FAIL-3",
            status: "processing",
            createdAt: new Date("2026-11-03T00:00:00.000Z"),
            shiprocket: { awbCode: "AWB-FAIL-3" },
            delivery: { status: "pending", trackingAttempts: 0, nextTrackingAt: null },
            saveCount: 0,
            async save() { this.saveCount++; return this; },
        },
        {
            _id: "healthy",
            orderId: "LS-20261109-PKVM",
            status: "processing",
            createdAt: new Date("2026-11-09T00:00:00.000Z"),
            shiprocket: { awbCode: "14112366066388" },
            delivery: { status: "pending", trackingAttempts: 0, nextTrackingAt: null },
            saveCount: 0,
            async save() { this.saveCount++; return this; },
        },
    ];

    const origFind = Order.find;
    const origTrackByAWB = shiprocket.trackByAWB;

    try {
        Order.find = (query) => {
            return {
                sort: () => ({
                    limit: async (limit) => {
                        const targetDate = query.$and?.[1]?.$or?.[2]?.["delivery.nextTrackingAt"]?.$lte || new Date();
                        const eligible = orders.filter((o) => {
                            const nt = o.delivery?.nextTrackingAt;
                            if (nt == null) return true;
                            return new Date(nt).getTime() <= new Date(targetDate).getTime();
                        });
                        eligible.sort((a, b) => {
                            const ntA = a.delivery?.nextTrackingAt ? new Date(a.delivery.nextTrackingAt).getTime() : 0;
                            const ntB = b.delivery?.nextTrackingAt ? new Date(b.delivery.nextTrackingAt).getTime() : 0;
                            if (ntA !== ntB) return ntA - ntB;
                            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
                        });
                        return eligible.slice(0, limit);
                    },
                }),
            };
        };

        shiprocket.trackByAWB = async (awb) => {
            if (awb.startsWith("AWB-FAIL")) {
                throw new Error("Shiprocket API timeout / 500 error");
            }
            return {
                tracking_data: {
                    shipment_track: [{
                        awb_code: awb,
                        current_status: "Out For Pickup",
                        status_code: 19,
                    }],
                },
            };
        };

        const syncedOrders = [];
        const mockSync = async (order) => {
            syncedOrders.push(order.orderId);
            return true;
        };

        // Sweep 1 with batchLimit = 2 at baseTime
        const sweep1 = await runTrackingSweep(2, {
            now: baseTime,
            syncOrderFromShipment: mockSync,
        });

        assert.equal(sweep1.total, 2, "Sweep 1 must select batch of 2");
        assert.equal(sweep1.synced, 0, "Sweep 1 has 0 synced because both were poison orders");
        assert.equal(orders[0].delivery.trackingAttempts, 1);
        assert.ok(orders[0].delivery.nextTrackingAt > baseTime, "f1 nextTrackingAt scheduled in future");
        assert.equal(orders[1].delivery.trackingAttempts, 1);
        assert.ok(orders[1].delivery.nextTrackingAt > baseTime, "f2 nextTrackingAt scheduled in future");

        // Sweep 2 immediately following Sweep 1 (at baseTime + 5s)
        const sweep2Time = new Date(baseTime.getTime() + 5000);
        const sweep2 = await runTrackingSweep(2, {
            now: sweep2Time,
            syncOrderFromShipment: mockSync,
        });

        // In sweep 2, f1 and f2 are ineligible due to future nextTrackingAt!
        // Selected are f3 and healthy!
        assert.equal(sweep2.total, 2, "Sweep 2 selects f3 and healthy");
        assert.equal(sweep2.synced, 1, "Healthy order syncs successfully");
        assert.ok(syncedOrders.includes("LS-20261109-PKVM"), "Healthy PKVM order was processed and synced");
        assert.equal(orders[3].delivery.trackingAttempts, 0, "Healthy order trackingAttempts reset to 0");
        assert.ok(orders[3].delivery.nextTrackingAt > sweep2Time, "Healthy order nextTrackingAt scheduled at normal polling interval");
    } finally {
        Order.find = origFind;
        shiprocket.trackByAWB = origTrackByAWB;
    }
});

test("Failure safety: timeout/malformed provider response increments attempts, schedules backoff, and preserves delivery status/timestamps", async () => {
    const fixedEventDate = new Date("2026-11-09T08:00:00.000Z");
    const fixedSyncDate = new Date("2026-11-09T08:30:00.000Z");
    const testOrder = {
        _id: "order_timeout_safety",
        orderId: "LS-FAIL-SAFETY-1",
        status: "processing",
        shiprocket: {
            awbCode: "AWB-SAFETY-1",
        },
        delivery: {
            status: "in_transit",
            lastEventAt: fixedEventDate,
            lastSyncedAt: fixedSyncDate,
            trackingAttempts: 1,
            nextTrackingAt: null,
            lastTrackingError: null,
        },
        async save() { return this; },
    };

    const origFind = Order.find;
    const origTrackByAWB = shiprocket.trackByAWB;

    try {
        Order.find = () => ({
            sort: () => ({
                limit: async () => [testOrder],
            }),
        });

        shiprocket.trackByAWB = async () => {
            throw new Error("ETIMEDOUT connection to Shiprocket failed");
        };

        const now = new Date("2026-11-10T10:00:00.000Z");
        const res = await runTrackingSweep(1, { now });

        assert.equal(res.synced, 0);
        assert.equal(res.total, 1);
        assert.equal(testOrder.delivery.trackingAttempts, 2, "trackingAttempts incremented from 1 to 2");
        assert.match(testOrder.delivery.lastTrackingError, /ETIMEDOUT/, "lastTrackingError recorded sanitized error");
        assert.ok(testOrder.delivery.nextTrackingAt instanceof Date, "nextTrackingAt scheduled");
        assert.ok(testOrder.delivery.nextTrackingAt > now, "nextTrackingAt is in future");
        assert.equal(testOrder.delivery.status, "in_transit", "delivery.status must remain UNCHANGED on failure");
        assert.equal(testOrder.delivery.lastEventAt.toISOString(), fixedEventDate.toISOString(), "lastEventAt must remain UNCHANGED");
        assert.equal(testOrder.delivery.lastSyncedAt.toISOString(), fixedSyncDate.toISOString(), "lastSyncedAt must remain UNCHANGED");
    } finally {
        Order.find = origFind;
        shiprocket.trackByAWB = origTrackByAWB;
    }
});

test("Success reset: previously failing order resets attempts and error on successful sync", async () => {
    const testOrder = {
        _id: "order_success_reset",
        orderId: "LS-RESET-1",
        status: "processing",
        shiprocket: {
            awbCode: "AWB-RESET-1",
        },
        delivery: {
            status: "pending",
            trackingAttempts: 4,
            lastTrackingError: "Previous connection failed",
            nextTrackingAt: new Date("2026-11-10T09:00:00.000Z"),
        },
        async save() { return this; },
    };

    const origFind = Order.find;
    const origTrackByAWB = shiprocket.trackByAWB;

    try {
        Order.find = () => ({
            sort: () => ({
                limit: async () => [testOrder],
            }),
        });

        shiprocket.trackByAWB = async () => ({
            tracking_data: {
                shipment_track: [{
                    awb_code: "AWB-RESET-1",
                    current_status: "In Transit",
                    status_code: 18,
                }],
            },
        });

        let syncCalled = false;
        const mockSync = async () => {
            syncCalled = true;
            return true;
        };

        const now = new Date("2026-11-10T10:00:00.000Z");
        const res = await runTrackingSweep(1, {
            now,
            syncOrderFromShipment: mockSync,
            pollIntervalMs: 30 * 60 * 1000,
        });

        assert.equal(res.synced, 1);
        assert.equal(syncCalled, true);
        assert.equal(testOrder.delivery.trackingAttempts, 0, "trackingAttempts reset to 0");
        assert.equal(testOrder.delivery.lastTrackingError, null, "lastTrackingError cleared to null");
        assert.equal(testOrder.delivery.lastTrackingAttemptAt.getTime(), now.getTime(), "lastTrackingAttemptAt set to now");
        assert.equal(testOrder.delivery.nextTrackingAt.getTime(), now.getTime() + 30 * 60 * 1000, "nextTrackingAt scheduled at normal interval");
    } finally {
        Order.find = origFind;
        shiprocket.trackByAWB = origTrackByAWB;
    }
});

test("PKVM-style order: active processing order with AWB is eligible when nextTrackingAt is due and ineligible when in future", () => {
    const now = new Date("2026-11-10T10:00:00.000Z");

    const pkvmOrder = {
        orderId: "LS-20261109-PKVM",
        status: "processing",
        shiprocket: {
            awbCode: "14112366066388",
            shipmentId: 1712718895,
        },
        delivery: {
            status: "pending",
            nextTrackingAt: null,
        },
    };

    // 1. Initial state: nextTrackingAt is null -> eligible
    assert.equal(isOrderEligibleForTracking(pkvmOrder, now), true, "PKVM order with null nextTrackingAt must be eligible");

    // 2. Due state: nextTrackingAt <= now -> eligible
    pkvmOrder.delivery.nextTrackingAt = new Date("2026-11-10T09:59:00.000Z");
    assert.equal(isOrderEligibleForTracking(pkvmOrder, now), true, "PKVM order with past nextTrackingAt must be eligible");

    // 3. Future backoff / normal interval: nextTrackingAt > now -> ineligible
    pkvmOrder.delivery.nextTrackingAt = new Date("2026-11-10T10:05:00.000Z");
    assert.equal(isOrderEligibleForTracking(pkvmOrder, now), false, "PKVM order with future nextTrackingAt must be ineligible");

    // 4. Query structure verifies compound eligibility requirements
    const query = buildTrackingWorkerQuery(now);
    assert.deepEqual(query.status, { $in: ["processing", "shipped", "in_transit", "out_for_delivery", "confirmed"] });
    assert.deepEqual(query["cancellation.status"], { $nin: ["requested", "completed"] });
    assert.deepEqual(query["fulfillmentHold.active"], { $ne: true });
});
