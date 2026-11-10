import test from "node:test";
import assert from "node:assert/strict";
import { parseShiprocketDate, normalizeTrackingResult } from "../services/shiprocketTracking.js";
import { syncOrderFromShipment } from "../controllers/orderController.js";

test("Case 1: DD-MM-YYYY HH:mm:ss parsed as November 10, 2026 in IST -> 2026-11-09T18:33:37.000Z", () => {
    const input = "10-11-2026 00:03:37";
    const parsed = parseShiprocketDate(input);
    assert.ok(parsed instanceof Date);
    assert.equal(parsed.toISOString(), "2026-11-09T18:33:37.000Z");

    // When converted to IST (UTC+05:30), the calendar date is 10 November 2026
    const istMs = parsed.getTime() + (5 * 60 + 30) * 60 * 1000;
    const istDate = new Date(istMs);
    assert.equal(istDate.getUTCFullYear(), 2026);
    assert.equal(istDate.getUTCMonth(), 10); // 0-indexed: 10 = November
    assert.equal(istDate.getUTCDate(), 10);
    assert.equal(istDate.getUTCHours(), 0);
    assert.equal(istDate.getUTCMinutes(), 3);
    assert.equal(istDate.getUTCSeconds(), 37);
});

test("Case 2: 11-10-2026 00:03:37 is parsed as 11 October 2026 (day/month not swapped)", () => {
    const input = "11-10-2026 00:03:37";
    const parsed = parseShiprocketDate(input);
    assert.ok(parsed instanceof Date);
    assert.equal(parsed.toISOString(), "2026-10-10T18:33:37.000Z");

    const istMs = parsed.getTime() + (5 * 60 + 30) * 60 * 1000;
    const istDate = new Date(istMs);
    assert.equal(istDate.getUTCFullYear(), 2026);
    assert.equal(istDate.getUTCMonth(), 9); // 0-indexed: 9 = October
    assert.equal(istDate.getUTCDate(), 11);
});

test("Case 3: ISO input 2026-11-10T05:00:00.000Z remains the same instant", () => {
    const input = "2026-11-10T05:00:00.000Z";
    const parsed = parseShiprocketDate(input);
    assert.ok(parsed instanceof Date);
    assert.equal(parsed.toISOString(), "2026-11-10T05:00:00.000Z");
});

test("Case 4: Malformed input 'garbage' does not produce a valid date", () => {
    assert.equal(parseShiprocketDate("garbage"), null);
    assert.equal(parseShiprocketDate(""), null);
    assert.equal(parseShiprocketDate(null), null);
    assert.equal(parseShiprocketDate(undefined), null);
    assert.equal(parseShiprocketDate("31-02-2026 10:00:00"), null, "Feb 31 is invalid");
    assert.equal(parseShiprocketDate("10-13-2026"), null, "Month 13 is invalid");
    assert.equal(parseShiprocketDate(new Date(NaN)), null, "Invalid Date object is rejected");
});

test("Case 5: Tracking payload with DD-MM-YYYY current_timestamp normalizes to correct November timestamp", () => {
    const payload = {
        current_timestamp: "10-11-2026 00:03:37",
        etd: "15-11-2026",
        current_status: "Out For Pickup",
        shipment_status_id: 19,
    };
    const normalized = normalizeTrackingResult(payload);
    assert.ok(normalized);
    assert.equal(normalized.eventTime, "2026-11-09T18:33:37.000Z");
    assert.equal(normalized.etd, "2026-11-14T18:30:00.000Z");
    assert.notEqual(normalized.eventTime, "2026-10-11T00:03:37.000Z", "Must NOT be October 11");
});

test("Case 6: Chronology regression: rejects older events and advances newer November events", async () => {
    // Existing order has lastEventAt = 10 November 2026, 00:03:37 IST
    const nov10T0003 = new Date("2026-11-09T18:33:37.000Z");
    const mockOrder = {
        orderId: "LS-TEST-CHRONO-NOV",
        status: "processing",
        cancellation: { status: "none" },
        delivery: {
            status: "processing",
            lastEventAt: new Date(nov10T0003),
            rawStatus: "Out For Pickup",
            rawStatusCode: "19",
        },
        shiprocket: {
            status: "Out For Pickup",
            awbCode: "AWB-1234",
        },
        saveCount: 0,
        async save() {
            this.saveCount++;
            return this;
        },
    };

    // 6a: Older event (e.g. from 9 November 2026, 12:00:00 IST -> 2026-11-09T06:30:00.000Z)
    // Must NOT move lastEventAt backward
    const olderTracking = {
        __canonical: true,
        currentStatus: "Out For Pickup",
        shipmentStatus: "Out For Pickup",
        rawStatus: 19,
        mappedStatus: "processing",
        eventTime: "2026-11-09T06:30:00.000Z",
    };
    await syncOrderFromShipment(mockOrder, olderTracking);
    assert.equal(
        mockOrder.delivery.lastEventAt.toISOString(),
        nov10T0003.toISOString(),
        "Older event must not regress lastEventAt"
    );

    // 6b: Newer event (e.g. 10 November 2026, 06:00:00 IST -> 2026-11-10T00:30:00.000Z)
    // Must advance lastEventAt
    const newerTracking = {
        __canonical: true,
        currentStatus: "Out For Pickup",
        shipmentStatus: "Out For Pickup",
        rawStatus: 19,
        mappedStatus: "processing",
        eventTime: "2026-11-10T00:30:00.000Z",
    };
    await syncOrderFromShipment(mockOrder, newerTracking);
    assert.equal(
        mockOrder.delivery.lastEventAt.toISOString(),
        "2026-11-10T00:30:00.000Z",
        "Newer event must advance lastEventAt"
    );
});

