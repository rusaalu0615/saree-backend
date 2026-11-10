import test from "node:test";
import assert from "node:assert/strict";
import { parseShiprocketDate, parseTimezoneOffset, normalizeTrackingResult } from "../services/shiprocketTracking.js";
import { parseShiprocketResponseBody, readShiprocketResponse } from "../services/shiprocket.js";
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

test("Timezone offset tests: +05:30 == +0530 and -04:00 == -0400", () => {
    const tCol = parseShiprocketDate("10-11-2026 00:03:37+05:30");
    const tCompact = parseShiprocketDate("10-11-2026 00:03:37+0530");
    assert.ok(tCol instanceof Date);
    assert.ok(tCompact instanceof Date);
    assert.equal(tCol.toISOString(), "2026-11-09T18:33:37.000Z");
    assert.equal(tCompact.toISOString(), "2026-11-09T18:33:37.000Z");
    assert.equal(tCol.getTime(), tCompact.getTime());

    const tNegCol = parseShiprocketDate("10-11-2026 00:03:37-04:00");
    const tNegCompact = parseShiprocketDate("10-11-2026 00:03:37-0400");
    assert.ok(tNegCol instanceof Date);
    assert.ok(tNegCompact instanceof Date);
    assert.equal(tNegCol.toISOString(), tNegCompact.toISOString());
    assert.equal(tNegCol.toISOString(), "2026-11-10T04:03:37.000Z");
});

test("Timezone offset tests: invalid offsets are rejected", () => {
    assert.equal(parseTimezoneOffset("+2560"), null);
    assert.equal(parseTimezoneOffset("+05:99"), null);
    assert.equal(parseTimezoneOffset("+05"), null);
    assert.equal(parseTimezoneOffset("invalid"), null);

    assert.equal(parseShiprocketDate("10-11-2026 00:03:37+2560"), null);
    assert.equal(parseShiprocketDate("10-11-2026 00:03:37+05:99"), null);
});

test("Shiprocket response parsing: valid JSON response", () => {
    const raw = '{"token":"xyz-token-123","status":200}';
    const parsed = parseShiprocketResponseBody(raw, 200, "test_auth");
    assert.deepEqual(parsed.data, { token: "xyz-token-123", status: 200 });
    assert.equal(parsed.raw, raw);
});

test("Shiprocket response parsing: empty Shiprocket response", () => {
    const empty1 = parseShiprocketResponseBody("", 200, "empty_test");
    assert.equal(empty1.data, null);
    assert.equal(empty1.raw, "");

    const empty2 = parseShiprocketResponseBody("   \r\n\t  ", 200, "empty_spaces");
    assert.equal(empty2.data, null);
    assert.equal(empty2.raw, "");
});

test("Shiprocket response parsing: malformed Shiprocket response", () => {
    assert.throws(
        () => parseShiprocketResponseBody("<html>502 Bad Gateway</html>", 502, "gateway_err"),
        (err) => {
            assert.match(err.message, /Shiprocket API error: HTTP 502 with invalid\/empty response/);
            assert.doesNotMatch(err.message, /Unexpected end of JSON input/);
            return true;
        }
    );
});

test("Shiprocket response parsing: non-2xx JSON response preserves error body", () => {
    const raw = '{"message":"Invalid Status for pickup generation"}';
    const parsed = parseShiprocketResponseBody(raw, 400, "pickup_err");
    assert.equal(parsed.data?.message, "Invalid Status for pickup generation");
});

test("Shiprocket response parsing: readShiprocketResponse helper on fetch Response objects", async () => {
    // 1. Valid 200 JSON
    const res200 = new Response('{"token":"abc"}', { status: 200, headers: { "Content-Type": "application/json" } });
    const p1 = await readShiprocketResponse(res200, "auth");
    assert.equal(p1.data?.token, "abc");

    // 2. 200 with empty body
    const resEmpty = new Response("", { status: 200 });
    const p2 = await readShiprocketResponse(resEmpty, "orders");
    assert.equal(p2.data, null);

    // 3. 502 non-JSON error
    const res502 = new Response("<html>Bad Gateway</html>", { status: 502 });
    await assert.rejects(
        () => readShiprocketResponse(res502, "pickup"),
        /Shiprocket API error: HTTP 502 with invalid\/empty response \(pickup\)/
    );

    // 4. 400 JSON error
    const res400 = new Response('{"message":"Invalid status"}', { status: 400 });
    const p4 = await readShiprocketResponse(res400, "pickup");
    assert.equal(p4.data?.message, "Invalid status");
});

test("Production regression: eventTime falls back to newest valid activity date when explicit dates are missing", () => {
    const payload = {
        tracking_data: {
            shipment_status_id: 19,
            current_status: "Out for Pickup",
            shipment_track_activities: [
                {
                    date: "2026-11-09 18:55:00",
                    activity: "NA",
                },
                {
                    date: "2026-11-10 00:01:00",
                    activity: "OUT FOR PICKUP",
                },
            ],
        },
    };

    const normalized = normalizeTrackingResult(payload);
    assert.ok(normalized);
    assert.equal(normalized.mappedStatus, "processing");
    assert.equal(normalized.currentStatus, "Out For Pickup");
    assert.equal(normalized.eventTime, "2026-11-09T18:31:00.000Z");
});

test("eventTime priority: explicit primary timestamp remains authoritative over newer activity", () => {
    const payload = {
        current_timestamp: "10-11-2026 00:03:37",
        tracking_data: {
            shipment_status_id: 19,
            current_status: "Out for Pickup",
            shipment_track_activities: [
                {
                    date: "2026-11-12 10:00:00",
                    activity: "OUT FOR PICKUP",
                },
            ],
        },
    };

    const normalized = normalizeTrackingResult(payload);
    assert.ok(normalized);
    // 10-11-2026 00:03:37 IST -> 2026-11-09T18:33:37.000Z
    assert.equal(normalized.eventTime, "2026-11-09T18:33:37.000Z");
});

test("eventTime invalid activity: all malformed activity dates result in eventTime = null", () => {
    const payload = {
        tracking_data: {
            shipment_status_id: 19,
            current_status: "Out for Pickup",
            shipment_track_activities: [
                {
                    date: "garbage-date",
                    activity: "NA",
                },
                {
                    date: "31-02-2026 12:00:00",
                    activity: "OUT FOR PICKUP",
                },
            ],
        },
    };

    const normalized = normalizeTrackingResult(payload);
    assert.ok(normalized);
    assert.equal(normalized.eventTime, null);
});

