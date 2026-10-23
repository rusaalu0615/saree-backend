/**
 * CSRF guard for a cookie-authenticated API.
 *
 * Auth runs in an HttpOnly cookie with SameSite=None (required because the
 * frontend origin differs from the API origin). Browsers happily attach such
 * cookies to cross-origin HTML <form> POSTs, which are "simple" requests sent
 * WITHOUT a CORS preflight — so a malicious site could otherwise force actions
 * (cancel orders, place orders, mutate content) on a logged-in user's session.
 *
 * Defense: every state-changing request must carry the custom X-Requested-With
 * header. A plain HTML form CANNOT set custom headers; our fetch client always
 * does (see linen-saree/lib/api.ts). Requests without it are rejected.
 */

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Endpoints that third parties (payment gateways) POST to directly. They cannot
// carry our header, so they are authenticated by HMAC signature instead.
const EXEMPT_SUFFIXES = ["/api/order/webhook"];

export const csrfGuard = (req, res, next) => {
    if (!STATE_CHANGING.has(req.method)) return next();

    const path = (req.originalUrl || req.url || "").split("?")[0];
    if (EXEMPT_SUFFIXES.some((p) => path === p || path.endsWith(p))) {
        return next();
    }

    if (req.headers["x-requested-with"] !== "XMLHttpRequest") {
        return res.status(403).json({
            success: false,
            message: "Forbidden: request blocked (missing X-Requested-With header).",
        });
    }

    next();
};

export default csrfGuard;
