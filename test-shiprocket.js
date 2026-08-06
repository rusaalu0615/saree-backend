import dotenv from "dotenv";
import shiprocket from "./services/shiprocket.js";

// Load environment variables
dotenv.config();

console.log("=== Shiprocket Diagnostics ===");
console.log("Email:", process.env.SHIPROCKET_EMAIL);
console.log("Pickup Location:", process.env.SHIPROCKET_PICKUP_LOCATION);
console.log("------------------------------");

const dummyOrder = {
    orderId: `TEST-DIAGNOSTIC-${Date.now()}`,
    shippingAddress: {
        firstName: "Rustam",
        lastName: "Test",
        address: "Test Address 123",
        landmark: "Test Landmark",
        city: "Bhagalpur",
        state: "BR", // State code like BR for Bihar
        pincode: "812002",
        phone: "9876543210",
        email: "test@example.com"
    },
    payment: {
        method: "cod"
    },
    items: [
        {
            name: "TEST ORDER - DO NOT SHIP",
            sku: "TEST-SKU-1",
            quantity: 1,
            price: 999,
            productId: "123456789"
        }
    ],
    pricing: {
        total: 999
    }
};

async function runTest() {
    try {
        console.log("1. Authenticating with Shiprocket...");
        const token = await shiprocket.getToken();
        console.log("✅ Authentication successful. Token acquired.");

        console.log("\n2. Attempting to create order in Shiprocket...");
        console.log("Order Payload:", JSON.stringify(dummyOrder, null, 2));
        const result = await shiprocket.createShiprocketOrder(dummyOrder);
        
        console.log("\n✅ Order creation successful!");
        console.log("Shiprocket Order ID:", result.order_id);
        console.log("Shiprocket Shipment ID:", result.shipment_id);
        console.log(result);

    } catch (error) {
        console.log("\n❌ DIAGNOSTIC FAILURE:");
        console.log(error.message);
    }
}

runTest();
