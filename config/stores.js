/**
 * Centralized Store Configuration
 * 
 * Supported Stores:
 * - "handloomer": Handloomer (original production store)
 * - "linen": House of Qalakari (linen sarees store)
 * 
 * Rules:
 * - Shared: Products, Inventory, Categories, Collections, Admin Dashboard, Razorpay, Shiprocket
 * - Isolated: Customer Accounts, Sessions, Orders, Carts, Wishlists, Addresses, OTPs, Reviews
 */

export const STORES = {
  handloomer: {
    id: "handloomer",
    name: "Handloomer",
    brandTitle: "MS HANDLOOM",
    legalName: "MS Handloom Weaving Co.",
    domain: "handloomer.com",
    frontendUrl: process.env.HANDLOOMER_FRONTEND_URL || "https://handloomer.com",
    allowedOrigins: [
      "https://handloomer.com",
      "https://www.handloomer.com",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ],
    supportEmail: "support@handloomer.com",
    supportPhone: "+91 98765 43210",
    orderPrefix: "HL",
    invoiceHeader: "MS HANDLOOM",
    invoiceAddress: "Handloom Weavers Hub, Varanasi, Uttar Pradesh, India",
  },
  linen: {
    id: "linen",
    name: "House of Qalakari",
    brandTitle: "HOUSE OF QALAKARI",
    legalName: "House of Qalakari Handloom Co.",
    domain: "linensaree.in",
    frontendUrl: process.env.LINEN_FRONTEND_URL || "https://linensaree.in",
    allowedOrigins: [
      "https://linensaree.in",
      "https://www.linensaree.in",
      "https://linen-saree.vercel.app",
      "https://sareeghar.com",
      "https://www.sareeghar.com",
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ],
    supportEmail: "support@linensaree.in",
    supportPhone: "+91 98765 43210",
    orderPrefix: "LS",
    invoiceHeader: "HOUSE OF QALAKARI",
    invoiceAddress: "Pure Handloom Linen Center, Bhagalpur, Bihar, India",
  },
};

export const DEFAULT_STORE_ID = "handloomer";

export const VALID_STORE_IDS = Object.keys(STORES);

/**
 * Validates whether a store ID is recognized.
 */
export function isValidStoreId(storeId) {
  if (typeof storeId !== "string") return false;
  return Boolean(STORES[storeId.trim().toLowerCase()]);
}

/**
 * Validates and normalizes a store ID.
 * Returns the store ID if valid, or the specified fallback (defaults to null).
 */
export function toCanonicalStoreId(storeId, fallback = null) {
  if (typeof storeId !== "string") return fallback;
  const key = storeId.trim().toLowerCase();
  if (STORES[key]) return key;
  return fallback;
}

/**
 * Returns the store configuration object for a store ID, falling back to default.
 */
export function getStore(storeId) {
  if (typeof storeId === "string") {
    const key = storeId.trim().toLowerCase();
    if (STORES[key]) return STORES[key];
  }
  return STORES[DEFAULT_STORE_ID];
}

export const getStoreConfig = getStore;

/**
 * Resolves all configured origins for CORS setup.
 */
export function getAllAllowedOrigins() {
  const set = new Set();
  for (const store of Object.values(STORES)) {
    if (store && Array.isArray(store.allowedOrigins)) {
      store.allowedOrigins.forEach((orig) => {
        try {
          set.add(new URL(orig).origin.toLowerCase());
        } catch {
          set.add(orig.toLowerCase());
        }
      });
    }
  }
  return Array.from(set);
}

export default {
  STORES,
  DEFAULT_STORE_ID,
  VALID_STORE_IDS,
  isValidStoreId,
  toCanonicalStoreId,
  getStore,
  getStoreConfig,
  getAllAllowedOrigins,
};
