/**
 * Shiprocket API Service
 * Handles authentication, order creation, courier assignment, and tracking.
 *
 * Required env vars:
 *   SHIPROCKET_EMAIL
 *   SHIPROCKET_PASSWORD
 *   SHIPROCKET_PICKUP_LOCATION  (default: "Primary")
 */

let cachedToken = null;
let tokenExpiry = null;

const SHIPROCKET_BASE = "https://apiv2.shiprocket.in/v1/external";

/**
 * Authenticate with Shiprocket and cache the bearer token (valid ~10 days).
 * We refresh every 24 hours to be safe.
 */
async function getToken() {
    // Return cached token if still valid
    if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
        return cachedToken;
    }

    const email = process.env.SHIPROCKET_EMAIL;
    const password = process.env.SHIPROCKET_PASSWORD;

    if (!email || !password) {
        throw new Error("Shiprocket credentials not configured. Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD in .env");
    }

    const res = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok || !data.token) {
        throw new Error(`Shiprocket auth failed: ${data.message || res.statusText}`);
    }

    cachedToken = data.token;
    tokenExpiry = Date.now() + 24 * 60 * 60 * 1000; // Refresh every 24h

    return cachedToken;
}

/**
 * Make an authenticated request to Shiprocket API
 */
async function shiprocketFetch(endpoint, options = {}) {
    const token = await getToken();

    const res = await fetch(`${SHIPROCKET_BASE}${endpoint}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...options.headers,
        },
    });

    const data = await res.json();

    if (!res.ok) {
        const errorMsg = data.message || data.errors || res.statusText;
        console.error(`Shiprocket API error [${endpoint}]:`, errorMsg);
        throw new Error(`Shiprocket API error: ${JSON.stringify(errorMsg)}`);
    }

    return data;
}

/**
 * Map Indian state abbreviations to full names (Shiprocket requires full names)
 */
const STATE_MAP = {
    AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam", BR: "Bihar",
    CG: "Chhattisgarh", GA: "Goa", GJ: "Gujarat", HR: "Haryana",
    HP: "Himachal Pradesh", JH: "Jharkhand", KA: "Karnataka", KL: "Kerala",
    MP: "Madhya Pradesh", MH: "Maharashtra", MN: "Manipur", ML: "Meghalaya",
    MZ: "Mizoram", NL: "Nagaland", OD: "Odisha", PB: "Punjab",
    RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu", TS: "Telangana",
    TR: "Tripura", UP: "Uttar Pradesh", UK: "Uttarakhand", WB: "West Bengal",
    AN: "Andaman and Nicobar Islands", CH: "Chandigarh",
    DN: "Dadra and Nagar Haveli and Daman and Diu", DL: "Delhi",
    JK: "Jammu and Kashmir", LA: "Ladakh", LD: "Lakshadweep", PY: "Puducherry",
};

/**
 * Create an order in Shiprocket
 * @param {Object} order - Our database Order document
 */
async function createShiprocketOrder(order) {
    const pickupLocation = process.env.SHIPROCKET_PICKUP_LOCATION || "Primary";

    // Resolve state abbreviation to full name
    const stateCode = order.shippingAddress.state;
    const stateName = STATE_MAP[stateCode] || stateCode;

    const payload = {
        order_id: order.orderId,
        order_date: new Date().toISOString().slice(0, 19).replace("T", " "),
        pickup_location: pickupLocation,
        billing_customer_name: order.shippingAddress.firstName,
        billing_last_name: order.shippingAddress.lastName,
        billing_address: order.shippingAddress.address,
        billing_address_2: order.shippingAddress.landmark || "",
        billing_city: order.shippingAddress.city,
        billing_pincode: order.shippingAddress.pincode,
        billing_state: stateName,
        billing_country: "India",
        billing_email: order.shippingAddress.email,
        billing_phone: order.shippingAddress.phone,
        shipping_is_billing: true,
        order_items: order.items.map((item) => ({
            name: item.name,
            sku: item.sku || `SKU-${item.productId}`,
            units: item.quantity,
            selling_price: item.price,
            discount: 0,
            tax: 0,
        })),
        payment_method: order.payment.method === "cod" ? "COD" : "Prepaid",
        sub_total: order.pricing.total,
        length: 30,
        breadth: 25,
        height: 5,
        weight: 0.5,
    };

    console.log(`[Shiprocket] Creating order ${order.orderId} →`, JSON.stringify(payload, null, 2));

    const result = await shiprocketFetch("/orders/create/adhoc", {
        method: "POST",
        body: JSON.stringify(payload),
    });

    console.log(`[Shiprocket] Order ${order.orderId} created →`, JSON.stringify(result));
    return result;
}

/**
 * Request courier assignment for a shipment
 * @param {Number} shipmentId - Shiprocket shipment ID
 * @param {Object} orderDetails - { pickupPincode, deliveryPincode, weight, isCOD }
 */
async function assignCourier(shipmentId, orderDetails = {}) {
    try {
        const {
            pickupPincode = "",
            deliveryPincode = "",
            weight = 0.5,
            isCOD = true,
        } = orderDetails;

        // Courier serviceability requires these params
        const params = new URLSearchParams({
            pickup_postcode: pickupPincode,
            delivery_postcode: deliveryPincode,
            weight: String(weight),
            cod: isCOD ? "1" : "0",
        });

        const couriers = await shiprocketFetch(
            `/courier/serviceability/?${params.toString()}`
        );

        if (
            couriers.data &&
            couriers.data.available_courier_companies &&
            couriers.data.available_courier_companies.length > 0
        ) {
            // Pick the cheapest courier
            const cheapest = couriers.data.available_courier_companies.sort(
                (a, b) => a.rate - b.rate
            )[0];

            // Assign the courier
            const assignment = await shiprocketFetch("/courier/assign/awb", {
                method: "POST",
                body: JSON.stringify({
                    shipment_id: shipmentId,
                    courier_id: cheapest.courier_company_id,
                }),
            });

            return {
                courierName: cheapest.courier_name,
                courierCompanyId: cheapest.courier_company_id,
                awbCode: assignment.response?.data?.awb_code || null,
            };
        }

        console.log("[Shiprocket] No couriers available for this route");
        return null;
    } catch (err) {
        console.error("Courier assignment failed:", err.message);
        return null;
    }
}

/**
 * Track shipment by AWB code
 */
async function trackByAWB(awbCode) {
    return await shiprocketFetch(`/courier/track/awb/${awbCode}`);
}

/**
 * Track shipment by Shiprocket order ID
 */
async function trackByShiprocketOrderId(shiprocketOrderId) {
    return await shiprocketFetch(
        `/courier/track?order_id=${shiprocketOrderId}`
    );
}

/**
 * Cancel a Shiprocket order
 */
async function cancelShiprocketOrder(shiprocketOrderIds) {
    return await shiprocketFetch("/orders/cancel", {
        method: "POST",
        body: JSON.stringify({ ids: [shiprocketOrderIds] }),
    });
}

/**
 * Generate a pickup request
 */
async function generatePickup(shipmentId) {
    return await shiprocketFetch("/courier/generate/pickup", {
        method: "POST",
        body: JSON.stringify({ shipment_id: [shipmentId] }),
    });
}

export default {
    getToken,
    createShiprocketOrder,
    assignCourier,
    trackByAWB,
    trackByShiprocketOrderId,
    cancelShiprocketOrder,
    generatePickup,
};
