import jwt from 'jsonwebtoken';
import User from '../models/userModal.js'; // Adjust path if needed

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
            return res.status(401).json({ message: "Not authorized, no token" });
        }

        // 2. Verify token (Synchronous, throws error if invalid)
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

        // 3. Find user and attach to request object
        const user = await User.findById(decoded.id).select("-password +revokedTokens");
        if (!user) {
            return res.status(401).json({ message: "Not authorized, user not found" });
        }

        // 4. Reject explicitly revoked sessions (logged-out tokens).
        if (decoded.jti && Array.isArray(user.revokedTokens) &&
            user.revokedTokens.some(t => t.jti === decoded.jti)) {
            return res.status(401).json({ message: "Session expired. Please log in again." });
        }

        // 5. Reject tokens issued before the password was last changed, so a
        //    reset/password change invalidates every previously active session.
        if (user.passwordChangedAt &&
            user.passwordChangedAt.getTime() / 1000 > decoded.iat) {
            return res.status(401).json({ message: "Session expired. Please log in again." });
        }

        req.user = user;

        // 6. Move to the next middleware/controller
        next();

    } catch (error) {
        console.error(error);
        return res.status(401).json({ message: "Not authorized, token failed" });
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
            return next(); // No token, proceed as guest
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
        const user = await User.findById(decoded.id).select("-password +revokedTokens");

        // Treat a revoked or stale session as a guest.
        const revoked = decoded.jti && Array.isArray(user?.revokedTokens) &&
            user.revokedTokens.some(t => t.jti === decoded.jti);
        const stale = user && user.passwordChangedAt &&
            user.passwordChangedAt.getTime() / 1000 > decoded.iat;

        if (user && !revoked && !stale) {
            req.user = user;
        }

        next();
    } catch (error) {
        // If token fails validation, just ignore and treat as guest
        next();
    }
};

export { protect, optionalProtect };
