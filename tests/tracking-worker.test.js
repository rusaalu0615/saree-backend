import test from "node:test";
import assert from "node:assert/strict";
import Order from "../models/orderModal.js";
import shiprocket from "../services/shiprocket.js";
import { runTrackingSweep, buildCanonicalTrackingFromDetail } from "../services/trackingWorker.js";
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

