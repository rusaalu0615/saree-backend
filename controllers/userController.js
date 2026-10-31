import User from "../models/userModal.js"
import generateToken from "../utils/generateToken.js"
import bcrypt from "bcryptjs"
import asyncHandler from "../utils/asyncHandler.js"
import OTP from "../models/otpModel.js"
import emailService from "../services/emailService.js"
import crypto from "crypto"
import jwt from "jsonwebtoken"

const MIN_PASSWORD_LENGTH = 8;
const MAX_OTP_ATTEMPTS = 3;

// Constant-time compare of two equal-length hex strings (sha256 digests).
const safeHexCompare = (a, b) => {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
};

const hashOtp = (otp) => crypto.createHash("sha256").update(otp).digest("hex");

// Verify a 6-digit reset OTP the same way the admin flow does: latest record
// per email, hashed comparison, and a hard attempt cap. Non-destructive on
// success so resetPassword can re-check it and then delete every OTP for the
// email. Guards against brute-forcing the code (the IP limiter alone allowed
// ~15 guesses) and against plaintext OTP leaking on a DB read breach.
const OTP_RESET_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const checkResetOtp = async (sanitizedEmail, otp) => {
    const now = new Date();
    // Atomically increment attempts on an unexpired, purpose-bound record
    const record = await OTP.findOneAndUpdate(
        {
            email: sanitizedEmail,
            purpose: "password_reset",
            expiresAt: { $gt: now },
            attempts: { $lt: MAX_OTP_ATTEMPTS },
        },
        { $inc: { attempts: 1 } },
        { returnDocument: "after" }
    );

    if (!record) {
        // Record missing, expired, or attempts exceeded
        await OTP.deleteMany({ email: sanitizedEmail, purpose: "password_reset" });
        return { ok: false, reason: "expired_or_locked" };
    }

    if (!safeHexCompare(record.otp, hashOtp(otp))) {
        if (record.attempts >= MAX_OTP_ATTEMPTS) {
            await OTP.deleteMany({ email: sanitizedEmail, purpose: "password_reset" });
            return { ok: false, reason: "locked" };
        }
        return { ok: false, reason: "invalid", remaining: MAX_OTP_ATTEMPTS - record.attempts };
    }
    return { ok: true, record };
};

// Extract the auth token from the Authorization header or the auth_token
// cookie (same precedence as the auth middlewares).
const readToken = (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) return authHeader.split(" ")[1];
    const cookie = req.headers.cookie;
    if (cookie) {
        const match = cookie.split(";").map(c => c.trim()).find(c => c.startsWith("auth_token="));
        if (match) return decodeURIComponent(match.split("=").slice(1).join("="));
    }
    return null;
};

const registerUser = asyncHandler(async (req, res) => {
    const { name, email, phone, password } = req.body;

    if (!email) {
        return res.status(400).json({ message: "Email is required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    const userExists = await User.findOne({ email: sanitizedEmail });
    if (userExists) {
        return res.status(400).json({ message: "User already exists" });
    }

    if (!password || typeof password !== "string") {
        return res.status(400).json({ message: "Password is required" });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
        name,
        email: sanitizedEmail,
        phone,
        password: hashedPassword,
    });

    const token = generateToken(user._id);

    // Set secure, HttpOnly cookie for XSS protection
    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
    })
});

const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // Type guards: also blocks NoSQL-operator payloads ({"$ne": ...} has no .trim)
    if (!email || typeof email !== "string") {
        return res.status(400).json({ message: "Email is required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    // Find the user WITHOUT projecting the password hash out of the response path
    const user = await User.findOne({ email: sanitizedEmail }).select("+password -__v");
    if (!user) {
        // Generic message: must be identical to the wrong-password case below,
        // otherwise the endpoint becomes a free account-enumeration oracle.
        return res.status(400).json({ message: "Invalid email or password" })
    }

    if (!password || typeof password !== "string" || !user.password) {
        return res.status(400).json({ message: "Invalid email or password" })
    }

    const matchPassword = await bcrypt.compare(password, user.password);
    if (!matchPassword) {
        return res.status(400).json({ message: "Invalid email or password" })
    }

    const token = generateToken(user._id);

    // Set secure, HttpOnly cookie for XSS protection
    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(200).json({
        // Return a trimmed object — `user` was fetched with .select("+password"),
        // so spreading it directly would leak the password hash. The auth token
        // rides the HttpOnly cookie only; never echo it in the body.
        user: {
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
        },
        message: "Login successful",
    })
});

const forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: "Email is required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: sanitizedEmail });

    // Never reveal whether the email exists (enumeration oracle). Respond the
    // same way either way; only send the OTP when there is a real account.
    if (user) {
        // Generate 6-digit OTP (cryptographically secure)
        const otpCode = crypto.randomInt(100000, 1000000).toString();

        // Delete any existing OTP for this email
        await OTP.deleteMany({ email: sanitizedEmail });

        // Save new purpose-bound OTP with explicit expiration date
        await OTP.create({
            email: sanitizedEmail,
            otp: hashOtp(otpCode),
            purpose: "password_reset",
            attempts: 0,
            expiresAt: new Date(Date.now() + OTP_RESET_WINDOW_MS),
        });

        // Send email
        await emailService.sendPasswordResetOTPEmail(sanitizedEmail, otpCode);
    }

    res.status(200).json({ message: "If an account exists for this email, a reset code has been sent" });
});

const verifyOtp = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ message: "Email and OTP are required" });
    }

    // otp MUST be a plain 6-digit string: passing an object like {"$ne": null}
    // straight into findOne() is a NoSQL-operator auth bypass.
    if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
        return res.status(400).json({ message: "Invalid or expired OTP" });
    }
    if (typeof email !== "string") {
        return res.status(400).json({ message: "Email and OTP are required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    const { ok, reason, record, remaining } = await checkResetOtp(sanitizedEmail, otp);

    if (!ok) {
        return res.status(400).json({
            message: reason === "locked"
                ? "Too many incorrect attempts. Please request a new code."
                : (remaining !== undefined ? `Invalid verification code. ${remaining} attempts remaining.` : "Invalid or expired OTP"),
        });
    }

    // Mark verified on record so resetPassword can complete without re-verifying attempt count
    await OTP.updateOne(
        { _id: record._id },
        { $set: { verified: true, verifiedAt: new Date() } }
    );

    res.status(200).json({ message: "OTP verified successfully" });
});

const resetPassword = asyncHandler(async (req, res) => {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
        return res.status(400).json({ message: "Email, OTP, and new password are required" });
    }

    // Same operator-injection guard as verifyOtp
    if (typeof otp !== "string" || !/^\d{6}$/.test(otp) || typeof email !== "string") {
        return res.status(400).json({ message: "Invalid or expired OTP" });
    }
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    const now = new Date();
    const hashed = hashOtp(otp);

    // Atomically find and consume the verified unexpired OTP single-use
    const consumed = await OTP.findOneAndDelete({
        email: sanitizedEmail,
        purpose: "password_reset",
        expiresAt: { $gt: now },
        $or: [
            { otp: hashed },
            { verified: true }
        ],
    });

    if (!consumed) {
        return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    // password field is select:false now, so request it explicitly
    const user = await User.findOne({ email: sanitizedEmail }).select("+password");
    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    // Invalidate every session issued before this moment (all devices).
    user.passwordChangedAt = new Date();
    await user.save();

    // Delete any remaining OTPs for this email and purpose so codes cannot be replayed.
    await OTP.deleteMany({ email: sanitizedEmail, purpose: "password_reset" });

    res.status(200).json({ message: "Password reset successfully" });
});

const logoutUser = asyncHandler(async (req, res) => {
    // Revoke the current token server-side so clearing the cookie truly kills
    // the session instead of leaving a live 7-day JWT that could be replayed.
    try {
        const token = readToken(req);
        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
            if (decoded.jti) {
                const user = await User.findById(decoded.id).select("+revokedTokens");
                if (user) {
                    const expiresAt = new Date((decoded.exp || Math.floor(Date.now() / 1000) + 7 * 24 * 3600) * 1000);
                    // Drop already-expired entries, add this one, and bound the array.
                    const next = (user.revokedTokens || [])
                        .filter(t => t.expiresAt && t.expiresAt.getTime() > Date.now())
                        .map(t => ({ jti: t.jti, expiresAt: t.expiresAt }))
                        .concat([{ jti: decoded.jti, expiresAt }]);
                    user.revokedTokens = next.length > 50 ? next.slice(-50) : next;
                    await user.save();
                }
            }
        }
    } catch (err) {
        // Invalid/expired token — nothing to revoke; still clear the cookie below.
    }

    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("auth_token", "", {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        expires: new Date(0) // Expire immediately
    });
    res.status(200).json({ message: "Logged out successfully" });
});

// Edit the logged-in user's own profile (name / phone). Always scoped to
// req.user._id — the client can never target another account by id.
const updateProfile = asyncHandler(async (req, res) => {
    const { name, phone } = req.body;

    // Type guards (also reject NoSQL-operator payloads).
    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
        return res.status(400).json({ message: "Name cannot be empty" });
    }
    if (phone !== undefined && (typeof phone !== "string" || !/^\d{10}$/.test(phone.trim()))) {
        return res.status(400).json({ message: "Phone must be a valid 10-digit number" });
    }

    const updates = {};
    if (typeof name === "string" && name.trim()) updates.name = name.trim();
    if (typeof phone === "string" && phone.trim()) updates.phone = phone.trim();

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: "Nothing to update" });
    }

    const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updates },
        { new: true, runValidators: true }
    ).select("-password");

    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        message: "Profile updated successfully",
    });
});

export default { registerUser, loginUser, logoutUser, updateProfile, forgotPassword, verifyOtp, resetPassword }