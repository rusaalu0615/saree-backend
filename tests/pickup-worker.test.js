import test from "node:test";
import assert from "node:assert/strict";
import Order from "../models/orderModal.js";
import shiprocket from "../services/shiprocket.js";
import { runFulfillmentForOrder } from "../services/fulfillmentWorker.js";

function setupMock(initialStage = "courier_assigned") {
  let stage = initialStage;
  const mockOrder = {
    _id: "mongo_1",
    orderId: "LS-PICKUP-TEST",
    status: "processing",
    payment: { method: "prepaid", status: "paid" },
    shippingAddress: { pincode: "110001" },
    shiprocket: { orderId: "SR_1", shipmentId: 101, awbCode: "AWB_1", courierName: "Delhivery" },
    fulfillment: { stage, attempts: 1, lockOwner: null, lockExpiresAt: null, lastError: "initial_err", nextAttemptAt: new Date() },
  };

  const origFindOneAndUpdate = Order.findOneAndUpdate;
  const origFindById = Order.findById;
  const origUpdateOne = Order.updateOne;
  const origGeneratePickup = shiprocket.generatePickup;
  const origGetShipmentDetail = shiprocket.getShipmentDetail;

  Order.findOneAndUpdate = async (q, u) => {
    mockOrder.fulfillment.lockOwner = u["$set"]?.["fulfillment.lockOwner"] || "token";
    mockOrder.fulfillment.stage = stage;
    return { ...mockOrder, fulfillment: { ...mockOrder.fulfillment } };
  };

  Order.findById = async () => {
    return { ...mockOrder, fulfillment: { ...mockOrder.fulfillment, stage } };
  };

  Order.updateOne = async (q, u) => {
    const s = u["$set"] || u;
    for (const [k, v] of Object.entries(s)) {
      if (k === "fulfillment.stage") stage = v;
      if (k === "fulfillment.lastError") mockOrder.fulfillment.lastError = v;
      if (k === "fulfillment.nextAttemptAt") mockOrder.fulfillment.nextAttemptAt = v;
    }
    return { modifiedCount: 1 };
  };

  const cleanup = () => {
    Order.findOneAndUpdate = origFindOneAndUpdate;
    Order.findById = origFindById;
    Order.updateOne = origUpdateOne;
    shiprocket.generatePickup = origGeneratePickup;
    shiprocket.getShipmentDetail = origGetShipmentDetail;
  };

  return { getStage: () => stage, getOrder: () => mockOrder, cleanup };
}

test("1. already queued confirmed: advances to complete via reconciliation", async () => {
  const { getStage, cleanup } = setupMock("courier_assigned");
  try {
    shiprocket.generatePickup = async () => {
      throw new Error("Shipment already in pickup queue");
    };
    shiprocket.getShipmentDetail = async () => ({
      confirmed: true,
      pickupGeneratedAt: new Date(),
    });

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(getStage(), "complete");
  } finally {
    cleanup();
  }
});

test("2. already queued unconfirmed: safely sets pickup_pending for retry", async () => {
  const { getStage, cleanup } = setupMock("courier_assigned");
  try {
    shiprocket.generatePickup = async () => {
      throw new Error("Shipment already in pickup queue");
    };
    shiprocket.getShipmentDetail = async () => ({
      confirmed: false,
    });

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(getStage(), "pickup_pending");
  } finally {
    cleanup();
  }
});

test("3. accepted no date confirmed: advances to complete via reconciliation", async () => {
  const { getStage, cleanup } = setupMock("courier_assigned");
  try {
    shiprocket.generatePickup = async () => ({
      data: { pickup_dates: [] },
    });
    shiprocket.getShipmentDetail = async () => ({
      confirmed: true,
      pickupGeneratedAt: new Date(),
    });

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(getStage(), "complete");
  } finally {
    cleanup();
  }
});

test("4. accepted no date unconfirmed: sets pickup_pending for retry", async () => {
  const { getStage, cleanup } = setupMock("courier_assigned");
  try {
    shiprocket.generatePickup = async () => ({
      data: { pickup_dates: [] },
    });
    shiprocket.getShipmentDetail = async () => ({
      confirmed: false,
    });

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(getStage(), "pickup_pending");
  } finally {
    cleanup();
  }
});

test("5. pickup_requested: bypasses generatePickup and completes", async () => {
  const { getStage, cleanup } = setupMock("pickup_requested");
  try {
    let generatePickupCalled = false;
    shiprocket.generatePickup = async () => {
      generatePickupCalled = true;
      return { data: {} };
    };

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(generatePickupCalled, false, "generatePickup must be bypassed when already pickup_requested");
    assert.equal(getStage(), "complete");
  } finally {
    cleanup();
  }
});

test("6. complete: idempotently bypasses pickup generation and stageComplete", async () => {
  const { getStage, cleanup } = setupMock("complete");
  try {
    let generatePickupCalled = false;
    shiprocket.generatePickup = async () => {
      generatePickupCalled = true;
      return { data: {} };
    };

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(generatePickupCalled, false, "generatePickup must not be called when already complete");
    assert.equal(res.completed, false, "stageComplete returns false for already complete orders");
    assert.equal(getStage(), "complete", "Stage remains complete");
  } finally {
    cleanup();
  }
});

test("7. local stage = pickup_pending + shipment status 19 Out For Pickup: no retry, leaves pickup_pending and clears errors", async () => {
  const { getStage, getOrder, cleanup } = setupMock("pickup_pending");
  try {
    let generatePickupCalled = false;
    shiprocket.generatePickup = async () => {
      generatePickupCalled = true;
      return { data: {} };
    };
    shiprocket.getShipmentDetail = async () => ({
      status: 19,
      statusCode: 19,
      confirmed: true,
      pickupGeneratedAt: new Date(),
    });

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(generatePickupCalled, false, "generatePickup must not be retried after reconciliation");
    assert.notEqual(getStage(), "pickup_pending");
    assert.equal(getStage(), "complete");
    assert.equal(getOrder().fulfillment.lastError, null);
    assert.equal(getOrder().fulfillment.nextAttemptAt, null);
  } finally {
    cleanup();
  }
});

test("8. generatePickup returns 'Invalid Status for pickup generation' and status 19 reconciles to complete without retry loop", async () => {
  const { getStage, getOrder, cleanup } = setupMock("courier_assigned");
  try {
    shiprocket.generatePickup = async () => {
      throw new Error("Shiprocket API error: \"Invalid Status for pickup generation\"");
    };
    shiprocket.getShipmentDetail = async () => ({
      status: 19,
      statusCode: 19,
      confirmed: true,
    });

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(getStage(), "complete");
    assert.equal(getOrder().fulfillment.lastError, null);
    assert.equal(getOrder().fulfillment.nextAttemptAt, null);
  } finally {
    cleanup();
  }
});

test("9. generatePickup returns 'Invalid Status' but shipment detail is unconfirmed status 2: remains pickup_pending with retry", async () => {
  const { getStage, getOrder, cleanup } = setupMock("courier_assigned");
  try {
    shiprocket.generatePickup = async () => {
      throw new Error("Shiprocket API error: \"Invalid Status for pickup generation\"");
    };
    shiprocket.getShipmentDetail = async () => ({
      status: 2,
      statusCode: 2,
      confirmed: false,
    });

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(getStage(), "pickup_pending");
    assert.match(getOrder().fulfillment.lastError, /Invalid Status for pickup generation/i);
    assert.ok(getOrder().fulfillment.nextAttemptAt instanceof Date);
  } finally {
    cleanup();
  }
});

test("10. statusCode = 42 Picked Up: fulfillment no longer pickup_pending", async () => {
  const { getStage, cleanup } = setupMock("pickup_pending");
  try {
    let generatePickupCalled = false;
    shiprocket.generatePickup = async () => {
      generatePickupCalled = true;
      return { data: {} };
    };
    shiprocket.getShipmentDetail = async () => ({
      status: 42,
      statusCode: 42,
      confirmed: true,
    });

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(generatePickupCalled, false);
    assert.notEqual(getStage(), "pickup_pending");
    assert.equal(getStage(), "complete");
  } finally {
    cleanup();
  }
});

test("11. later forward state statusCode = 18 In Transit with stale pickup_pending self-heals without calling generatePickup", async () => {
  const { getStage, cleanup } = setupMock("pickup_pending");
  try {
    let generatePickupCalled = false;
    shiprocket.generatePickup = async () => {
      generatePickupCalled = true;
      return { data: {} };
    };
    shiprocket.getShipmentDetail = async () => ({
      status: 18,
      statusCode: 18,
      confirmed: true,
    });

    const res = await runFulfillmentForOrder("LS-PICKUP-TEST", "worker-1");
    assert.equal(res.claimed, true);
    assert.equal(generatePickupCalled, false, "generatePickup must not be called when shipment is already in transit");
    assert.equal(getStage(), "complete");
  } finally {
    cleanup();
  }
});

test("12. tracking/webhook event with status 19 Out For Pickup self-heals stale fulfillment stage in syncOrderFromShipment", async () => {
  const { syncOrderFromShipment } = await import("../controllers/orderController.js");
  const mockOrderDoc = {
    orderId: "LS-TRACK-HEAL-1",
    status: "processing",
    delivery: {},
    shiprocket: { status: "OLD" },
    fulfillment: {
      stage: "pickup_pending",
      lastError: "Invalid Status for pickup generation",
      nextAttemptAt: new Date(),
    },
    saveCount: 0,
    async save() {
      this.saveCount++;
      return this;
    },
  };

  await syncOrderFromShipment(mockOrderDoc, {
    __canonical: true,
    rawStatus: 19,
    currentStatus: "Out For Pickup",
    shipmentStatus: "Out For Pickup",
    eventTime: "2026-11-10T05:00:00.000Z",
  });

  assert.equal(mockOrderDoc.fulfillment.stage, "complete");
  assert.equal(mockOrderDoc.fulfillment.lastError, null);
  assert.equal(mockOrderDoc.fulfillment.nextAttemptAt, null);
  assert.equal(mockOrderDoc.status, "processing", "Customer status must NOT falsely advance to delivered or picked_up");
});
