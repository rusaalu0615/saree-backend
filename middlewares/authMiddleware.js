import jwt from 'jsonwebtoken';
import User from '../modal/userModal.js'; // Adjust path if needed

const protect = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        // 1. Check if token exists
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ message: "Not authorized, no token" });
        }

        const token = authHeader.split(" ")[1];

        // 2. Verify token (Synchronous, throws error if invalid)
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // 3. Find user and attach to request object
        req.user = await User.findById(decoded.id).select("-password");

        // 4. Move to the next middleware/controller
        next();

    } catch (error) {
        console.error(error);
        return res.status(401).json({ message: "Not authorized, token failed" });
    }
};

export { protect };
