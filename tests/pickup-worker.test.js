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
    fulfillment: { stage, attempts: 1, lockOwner: null, lockExpiresAt: null },
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

  return { getStage: () => stage, cleanup };
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
