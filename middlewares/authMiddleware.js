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
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // 3. Find user and attach to request object
        const user = await User.findById(decoded.id).select("-password");
        if (!user) {
            return res.status(401).json({ message: "Not authorized, user not found" });
        }
        req.user = user;

        // 4. Move to the next middleware/controller
        next();

    } catch (error) {
        console.error(error);
        return res.status(401).json({ message: "Not authorized, token failed" });
    }
};

export { protect };
