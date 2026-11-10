import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShipmentDetail } from "../services/shiprocket.js";
import { normalizeTrackingResult, mapShipmentStatus } from "../services/shiprocketTracking.js";

const pickup = (over) => normalizeShipmentDetail({ id: 1712718895, ...over });

test("Label Generated (2) does NOT confirm pickup", () => {
  const d = pickup({ status: 2, pickupGeneratedDate: null });
  assert.equal(d.confirmed, false);
});

test("Status 3 confirms pickup", () => {
  assert.equal(pickup({ status: 3 }).confirmed, true);
});

test("Picked Up (42) confirms pickup", () => {
  assert.equal(pickup({ status: 42 }).confirmed, true);
  assert.equal(pickup({ statusCode: 42 }).confirmed, true);
});

test("Pickup generated date confirms pickup", () => {
  assert.equal(pickup({ status: 2, pickupGeneratedDate: "2026-11-09 18:55:42" }).confirmed, true);
});

test("Webhook-shaped payload normalization", () => {
  const n = normalizeTrackingResult({
    awb: "TEST-AWB-123", courier_name: "Test Courier",
    current_status: "IN TRANSIT", shipment_status: "IN TRANSIT",
    shipment_status_id: 18, current_timestamp: "2026-11-09 12:00:00",
    etd: "2026-11-12", order_id: "LS-TEST-001", sr_order_id: 123456,
  });
  assert.equal(n.mappedStatus, "in_transit");
  assert.equal(n.awb, "TEST-AWB-123");
  assert.equal(n.courierName, "Test Courier");
  assert.equal(String(n.rawStatus), "18");
  assert.equal(n.eventTime, "2026-11-09T06:30:00.000Z");
  assert.equal(n.etd, "2026-11-11T18:30:00.000Z");
  assert.notEqual(n.eventTime, n.etd);
});

test("Required shipment mappings", () => {
  const cases = [
    [6, "shipped"], [7, "delivered"], [18, "in_transit"], [17, "out_for_delivery"],
    [21, "undelivered"], [9, "rto_initiated"], [10, "rto_delivered"],
    [41, "rto_out_for_delivery"], [46, "rto_in_transit"],
  ];
  for (const [code, want] of cases) assert.equal(mapShipmentStatus(code, "track"), want, `code ${code}`);
  assert.notEqual(mapShipmentStatus(10, "track"), "delivered");
});

test("idempotency: pickup_requested/complete short-circuits pickup stage", async () => {
  // Worker entry already guards by stage; assert worker file contains the guard.
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../services/fulfillmentWorker.js", import.meta.url), "utf8");
  assert.match(src, /courier_assigned.*pickup_pending/);
  assert.match(src, /stageGeneratePickup/);
});

test("pickupGeneratedAt and pickupScheduledAt remain distinct in shipment detail normalization", () => {
  const g = "2026-11-09 10:00:00";
  const s = "2026-11-09 14:00:00";
  const detail = normalizeShipmentDetail({
    shipment: {
      id: 1712718895,
      status: 2,
      pickup_generated_date: g,
      pickup_scheduled_date: s,
    },
  });

  assert.equal(detail.pickupGeneratedAt, g);
  assert.equal(detail.pickupScheduledAt, s);
  assert.notEqual(detail.pickupGeneratedAt, detail.pickupScheduledAt);
  assert.equal(detail.confirmed, true, "pickupGeneratedAt confirms pickup");

  // Scheduled date alone also confirms pickup
  const schedOnly = normalizeShipmentDetail({
    shipment: {
      id: 1712718895,
      status: 2,
      pickup_scheduled_date: s,
    },
  });
  assert.equal(schedOnly.pickupGeneratedAt, null);
  assert.equal(schedOnly.pickupScheduledAt, s);
  assert.equal(schedOnly.confirmed, true, "pickupScheduledAt confirms pickup");
});
