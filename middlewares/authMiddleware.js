import jwt from 'jsonwebtoken';
import User from '../models/userModal.js';
import { toCanonicalStoreId, DEFAULT_STORE_ID } from '../config/stores.js';

const parseCookies = (cookieHeader) => {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(";").forEach(cookie => {
        const parts = cookie.split("=");
        list[parts.shift().trim()] = decodeURIComponent(parts.join("="));
    });
    return list;
};

const protect = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const cookies = parseCookies(req.headers.cookie);

        let token = null;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.split(" ")[1];
        } else if (cookies.auth_token) {
            token = cookies.auth_token;
        }

        // 1. Check if token exists
        if (!token) {
            return res.status(401).json({ success: false, message: "Not authorized, no token" });
        }

        // 2. Verify token (Synchronous, throws error if invalid)
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

        // 3. Find user and attach to request object
        const user = await User.findById(decoded.id).select("-password +revokedTokens");
        if (!user) {
            return res.status(401).json({ success: false, message: "Not authorized, user not found" });
        }

        // 4. Reject explicitly revoked sessions (logged-out tokens).
        if (decoded.jti && Array.isArray(user.revokedTokens) &&
            user.revokedTokens.some(t => t.jti === decoded.jti)) {
            return res.status(401).json({ success: false, message: "Session expired. Please log in again." });
        }

        // 5. Reject tokens issued before the password was last changed, so a
        //    reset/password change invalidates every previously active session.
        if (user.passwordChangedAt &&
            (Math.floor(user.passwordChangedAt.getTime() / 1000) - 2) > decoded.iat) {
            return res.status(401).json({ success: false, message: "Session expired. Please log in again." });
        }

        // 6. Cross-store boundary check:
        // Admins are centralized and can access any store context.
        // Regular customers are strictly bound to their registering store.
        if (user.role !== "admin" && req.store) {
            const userStore = toCanonicalStoreId(user.storeId, DEFAULT_STORE_ID);
            const requestStore = toCanonicalStoreId(req.store.id, DEFAULT_STORE_ID);
            if (userStore !== requestStore) {
                return res.status(401).json({
                    success: false,
                    message: "Session belongs to another store. Please log in to this store.",
                    code: "CROSS_STORE_SESSION_FORBIDDEN"
                });
            }
        }

        req.user = user;

        // 7. Move to the next middleware/controller
        next();

    } catch (error) {
        console.error(error);
        return res.status(401).json({ success: false, message: "Not authorized, token failed" });
    }
};

const optionalProtect = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const cookies = parseCookies(req.headers.cookie);

        let token = null;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.split(" ")[1];
        } else if (cookies.auth_token) {
            token = cookies.auth_token;
        }

        if (!token) {
            return next(); // No token provided, proceed as guest
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
        const user = await User.findById(decoded.id).select("-password +revokedTokens");

        if (!user) {
            return next(); // Stale token for deleted user, proceed as guest
        }

        // Check if token was explicitly revoked
        const revoked = decoded.jti && Array.isArray(user.revokedTokens) &&
            user.revokedTokens.some(t => t.jti === decoded.jti);
        if (revoked) {
            return next(); // Revoked session, proceed as guest
        }

        // Check if token was issued before password change
        const stale = user.passwordChangedAt &&
            (Math.floor(user.passwordChangedAt.getTime() / 1000) - 2) > decoded.iat;
        if (stale) {
            return next(); // Expired password, proceed as guest
        }

        // Cross-store check:
        // If a customer provides a valid token for Store A while on Store B,
        // REJECT explicitly so they do not unintentionally place a guest order
        // thinking they are authenticated.
        if (user.role !== "admin" && req.store) {
            const userStore = toCanonicalStoreId(user.storeId, DEFAULT_STORE_ID);
            const requestStore = toCanonicalStoreId(req.store.id, DEFAULT_STORE_ID);
            if (userStore !== requestStore) {
                return res.status(401).json({
                    success: false,
                    message: "Session belongs to another store. Please log in to this store.",
                    code: "CROSS_STORE_SESSION_FORBIDDEN"
                });
            }
        }

        req.user = user;
        next();
    } catch (error) {
        // If token verification fails (e.g. malformed or expired), proceed as guest
        next();
    }
};

const adminOnly = (req, res, next) => {
    if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ success: false, message: "Access denied. Administrative privileges required." });
    }
    next();
};

export { protect, optionalProtect, adminOnly };
