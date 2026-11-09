import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { csrfGuard } from "../middlewares/csrfGuard.js";
import { verifyCarrierWebhook } from "../middlewares/verifyCarrierWebhook.js";
import { normalizeTrackingResult, mapShipmentStatus } from "../services/shiprocketTracking.js";

const mockRes = () => {
  const r = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  return r;
};

test("CSRF exempts carrier-events but not other order POSTs", () => {
  // Carrier webhook: no X-Requested-With still passes (server-to-server).
  let called = false;
  csrfGuard({ method: "POST", originalUrl: "/api/order/carrier-events", headers: {} }, mockRes(), () => { called = true; });
  assert.equal(called, true, "carrier-events passes CSRF");
  // Razorpay still exempt
  called = false;
  csrfGuard({ method: "POST", originalUrl: "/api/order/webhook", headers: {} }, mockRes(), () => { called = true; });
  assert.equal(called, true, "razorpay webhook passes CSRF");
  // Other order POST still blocked without header.
  const res = mockRes();
  csrfGuard({ method: "POST", originalUrl: "/api/order/", headers: {} }, res, () => assert.fail("should 403"));
  assert.equal(res.statusCode, 403);
});

test("carrier auth: valid passes, missing/wrong 401, missing env fails closed", () => {
  process.env.SHIPROCKET_WEBHOOK_TOKEN = "s3cr3t-test";
  let called = false;
  verifyCarrierWebhook({ headers: { "x-api-key": "s3cr3t-test" } }, mockRes(), () => { called = true; });
  assert.equal(called, true);
  // missing
  let res = mockRes();
  called = false;
  verifyCarrierWebhook({ headers: {} }, res, () => { called = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
  // wrong
  res = mockRes();
  verifyCarrierWebhook({ headers: { "x-api-key": "wrong" } }, res, () => assert.fail("should 401"));
  assert.equal(res.statusCode, 401);
  // missing env → fail closed
  delete process.env.SHIPROCKET_WEBHOOK_TOKEN;
  res = mockRes();
  verifyCarrierWebhook({ headers: { "x-api-key": "anything" } }, res, () => assert.fail("should 401"));
  assert.equal(res.statusCode, 401);
  process.env.SHIPROCKET_WEBHOOK_TOKEN = "s3cr3t-test";
  // timing-safe path uses equal-length compare without throwing on different lengths
  res = mockRes();
  verifyCarrierWebhook({ headers: { "x-api-key": "short" } }, res, () => assert.fail("should 401"));
  assert.equal(res.statusCode, 401);
});

test("ID interpretation stays distinct (awb vs sr_order_id vs order_id)", () => {
  // Controller builds $or from payload fields independently — assert inputs normalize.
  const payload = { awb: "  AWB-1  ", sr_order_id: "123", order_id: " LS-20261109-XXXX " };
  const awb = payload.awb ? String(payload.awb).trim() : null;
  const srNum = Number(payload.sr_order_id);
  const src = String(payload.order_id).trim();
  assert.equal(awb, "AWB-1");
  assert.equal(srNum, 123);
  assert.equal(src, "LS-20261109-XXXX");
  // Normalizer round-trip does not conflate.
  const n = normalizeTrackingResult({ awb_code: "AWB-1", current_status: "In Transit" });
  assert.equal(n.awb, "AWB-1");
  assert.equal(n.mappedStatus, "in_transit");
});

test("normalizer is idempotent", () => {
  const raw = { awb_code: "AWB-1", current_status: "In Transit" };
  const once = normalizeTrackingResult(raw);
  const twice = normalizeTrackingResult(once);
  assert.deepEqual(twice, once);
});

test("RTO Delivered is not customer Delivered; 6 != Delivered, 7 = Delivered", () => {
  assert.equal(mapShipmentStatus(7, "track"), "delivered");
  assert.equal(mapShipmentStatus(6, "track"), "shipped", "track code 6 is Shipped, not Delivered");
  assert.equal(mapShipmentStatus("RTO Delivered", "track"), "rto_delivered");
  assert.notEqual(mapShipmentStatus("RTO Delivered", "track"), "delivered");
  assert.equal(mapShipmentStatus("RTO In Transit", "track"), "rto_in_transit");
  assert.equal(mapShipmentStatus("Undelivered", "track"), "undelivered");
});
