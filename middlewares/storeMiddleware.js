import { STORES, DEFAULT_STORE_ID, VALID_STORE_IDS, isValidStoreId, getStore, toCanonicalStoreId } from "../config/stores.js";

/**
 * Resolves store context from request headers, origin, or referer.
 * 
 * Order of resolution:
 * 1. Explicit `X-Store-Id` header (must be one of: "handloomer", "linen"; invalid IDs return null)
 * 2. `Origin` or `Referer` matching configured store allowedOrigins or exact/subdomain match
 * 3. Fallback to `DEFAULT_STORE_ID` ("handloomer") for backward compatibility with verified legacy requests
 */
export function resolveStore(req) {
  // 1. Explicit header: Reject invalid store IDs explicitly
  const headerStoreId = req.headers["x-store-id"];
  if (typeof headerStoreId === "string" && headerStoreId.trim()) {
    const cleanId = headerStoreId.trim().toLowerCase();
    if (isValidStoreId(cleanId)) {
      return getStore(cleanId);
    }
    // Invalid store ID supplied explicitly -> do not silently fallback
    return null;
  }

  // 2. Origin or Referer inspection
  const origin = req.headers.origin || req.headers.referer;
  if (typeof origin === "string") {
    try {
      const url = new URL(origin);
      const originHost = url.hostname.toLowerCase();
      const originFull = url.origin.toLowerCase();

      for (const store of Object.values(STORES)) {
        if (!store) continue;

        // Exact origin match
        const hasOriginMatch = store.allowedOrigins.some((ao) => {
          try {
            return new URL(ao).origin.toLowerCase() === originFull;
          } catch {
            return ao.toLowerCase() === originFull;
          }
        });

        // Strict domain and subdomain match (prevents attackerhandloomer.com attacks)
        const hasDomainMatch = originHost === store.domain || originHost.endsWith("." + store.domain);

        if (hasOriginMatch || hasDomainMatch) {
          return store;
        }
      }
    } catch {
      // Invalid URL in referer/origin, proceed to fallback
    }
  }

  // 3. Fallback to default store for legacy clients without explicit store header
  return getStore(DEFAULT_STORE_ID);
}

/**
 * Store Resolution Middleware
 * Attaches `req.store` to every incoming request.
 * Rejects requests with an invalid explicit X-Store-Id header.
 */
export function storeMiddleware(req, res, next) {
  const resolved = resolveStore(req);
  if (!resolved) {
    return res.status(400).json({
      success: false,
      code: "INVALID_STORE_ID",
      message: `Invalid X-Store-Id header. Supported stores are: ${VALID_STORE_IDS.join(", ")}`,
    });
  }

  req.store = resolved;
  if (typeof res.setHeader === "function") {
    res.setHeader("X-Store-Id", req.store.id);
  }
  next();
}

/**
 * Enforces that an authenticated user's account belongs to the current store context.
 * Global admins (role === "admin") are permitted across all stores.
 */
export function enforceStoreContext(req, res, next) {
  if (!req.user) {
    return next();
  }

  // Global admins have access to all stores
  if (req.user.role === "admin") {
    return next();
  }

  const userStore = toCanonicalStoreId(req.user.storeId, DEFAULT_STORE_ID);
  const currentStore = toCanonicalStoreId(req.store ? req.store.id : DEFAULT_STORE_ID, DEFAULT_STORE_ID);

  if (userStore !== currentStore) {
    return res.status(401).json({
      success: false,
      code: "CROSS_STORE_SESSION_FORBIDDEN",
      message: `Access denied. This session belongs to ${STORES[userStore]?.name || userStore} and cannot be used on ${STORES[currentStore]?.name || currentStore}. Please sign in to your ${STORES[currentStore]?.name || currentStore} account.`,
    });
  }

  next();
}

export default {
  resolveStore,
  storeMiddleware,
  enforceStoreContext,
};
