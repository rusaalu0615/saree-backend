import axios from "axios";

const SHIPROCKET_API_BASE = "https://apiv2.shiprocket.in/v1/payload";

/**
 * Authenticate with Shiprocket and return a valid Bearer token.
 */
export const getShiprocketToken = async () => {
    try {
        const response = await axios.post(`${SHIPROCKET_API_BASE}/login`, {
            email: process.env.SHIPROCKET_EMAIL,
            password: process.env.SHIPROCKET_PASSWORD,
        });

        if (response.data && response.data.token) {
            return response.data.token;
        }
        throw new Error("Invalid credentials or Shiprocket token missing.");
    } catch (error) {
        console.error("Shiprocket Auth Error:", error.response?.data || error.message);
        throw new Error("Failed to authenticate with Shiprocket");
    }
};

/**
 * Push a new order to Shiprocket for fulfillment.
 * @param {Object} orderData Formatted order object required by Shiprocket
 */
export const createShiprocketOrder = async (orderData) => {
    try {
        const token = await getShiprocketToken();

        const response = await axios.post(`${SHIPROCKET_API_BASE}/orders/create/adhoc`, orderData, {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
        });

        return response.data;
    } catch (error) {
        console.error("Shiprocket Create Order Error:", error.response?.data || error.message);
        throw new Error("Failed to create order on Shiprocket");
    }
};

/**
 * Get tracking details using Shiprocket AWB
 * @param {String} awb AWB Tracking Code
 */
export const trackShiprocketOrder = async (awb) => {
    try {
        const token = await getShiprocketToken();

        const response = await axios.get(`${SHIPROCKET_API_BASE}/tracking/awb/${awb}`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        return response.data;
    } catch (error) {
        console.error("Shiprocket Tracking Error:", error.response?.data || error.message);
        throw new Error("Failed to track Shiprocket order");
    }
};
