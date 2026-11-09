import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShipmentDetail } from "../services/shiprocket.js";

// Worker-idempotency is enforced by entry stage guard; assert helper semantics.
test("stage guard shape exists for pickup_requested/complete", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("services/fulfillmentWorker.js", "utf8");
  assert.match(src, /courier_assigned.*pickup_pending/);
  assert.match(src, /stageGeneratePickup/);
  assert.match(src, /stageComplete/);
});
test("shipment 42 via status_code confirms", () => {
  const d = normalizeShipmentDetail({ id: 1, status_code: 42 });
  assert.equal(d.confirmed, true);
});
