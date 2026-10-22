import jwt from "jsonwebtoken"

const generateToken = (userId) => {
    return jwt.sign({ id: userId },
        process.env.JWT_SECRET,
        // Match the 7-day session cookie lifetime so the token never expires
        // while the cookie still exists (silent mid-session logouts).
        { expiresIn: "7d" }
    )
}

export default generateToken