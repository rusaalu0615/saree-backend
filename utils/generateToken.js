import jwt from "jsonwebtoken"
import crypto from "crypto"

const generateToken = (userId) => {
    return jwt.sign({ id: userId },
        process.env.JWT_SECRET,
        // Match the 7-day session cookie lifetime so the token never expires
        // while the cookie still exists (silent mid-session logouts).
        // jwtid gives each session a unique id so logout can revoke just this
        // token server-side (see User.revokedTokens).
        { expiresIn: "7d", jwtid: crypto.randomUUID() }
    )
}

export default generateToken