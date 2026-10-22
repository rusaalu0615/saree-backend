import jwt from "jsonwebtoken";
import User from "../models/userModal.js";

const parseCookies = (cookieHeader) => {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(";").forEach(cookie => {
        const parts = cookie.split("=");
        list[parts.shift().trim()] = decodeURIComponent(parts.join("="));
    });
    return list;
};

/**
 * Middleware to restrict route access strictly to authenticated Admins
 */
const adminProtect = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const cookies = parseCookies(req.headers.cookie);

        let token = null;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.split(" ")[1];
        } else if (cookies.auth_token) {
            token = cookies.auth_token;
        }

        // 1. Assert token exists
        if (!token) {
            return res.status(401).json({ message: "Access denied. No session token provided." });
        }

        // 2. Verify token
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (error) {
            return res.status(401).json({ message: "Session expired or invalid. Please log in again." });
        }

        // 3. Locate the user
        const user = await User.findById(decoded.id).select("-password");
        if (!user) {
            return res.status(401).json({ message: "Administrative account not found." });
        }

        // 4. Assert user role is strictly admin — verified against the DB only.
        // The ADMIN_EMAILS whitelist is NOT consulted here: otherwise any existing
        // user's 1-day JWT would instantly escalate to admin if their email was
        // later whitelisted. Whitelisting only takes effect at OTP login time
        // (verifyAdminOTP provisions/upgrades the role in the DB).
        if (user.role !== "admin") {
            return res.status(403).json({ message: "Access denied. Administrative privileges required." });
        }

        // 5. Attach user to request
        req.user = user;
        next();

    } catch (error) {
        console.error("[Admin Middleware Error]:", error);
        return res.status(500).json({ message: "Internal server error during authorization check." });
    }
};

export { adminProtect };
