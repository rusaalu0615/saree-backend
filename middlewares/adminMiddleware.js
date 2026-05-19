import jwt from "jsonwebtoken";
import User from "../models/userModal.js";

/**
 * Middleware to restrict route access strictly to authenticated Admins
 */
const adminProtect = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        // 1. Assert authorization header exists and has correct format
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ message: "Access denied. No session token provided." });
        }

        const token = authHeader.split(" ")[1];

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

        // 4. Assert user role is strictly admin
        // We also check whitelist to guarantee high security in case role is manually mutated
        const whitelistedEmails = (process.env.ADMIN_EMAILS || "")
            .split(",")
            .map(e => e.trim().toLowerCase())
            .filter(Boolean);

        const isWhitelisted = whitelistedEmails.includes(user.email.toLowerCase());

        if (user.role !== "admin" && !isWhitelisted) {
            return res.status(403).json({ message: "Access denied. Administrative privileges required." });
        }

        // Upgrade user to admin if whitelisted but not set in DB
        if (user.role !== "admin" && isWhitelisted) {
            user.role = "admin";
            await user.save();
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
