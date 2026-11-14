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

const checkResetOtp = async (sanitizedEmail, otp, storeId = "handloomer") => {
    const now = new Date();
    // Atomically increment attempts on an unexpired, purpose-bound record for this store
    const record = await OTP.findOneAndUpdate(
        {
            storeId,
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
        await OTP.deleteMany({ storeId, email: sanitizedEmail, purpose: "password_reset" });
        return { ok: false, reason: "expired_or_locked" };
    }

    if (!safeHexCompare(record.otp, hashOtp(otp))) {
        if (record.attempts >= MAX_OTP_ATTEMPTS) {
            await OTP.deleteMany({ storeId, email: sanitizedEmail, purpose: "password_reset" });
            return { ok: false, reason: "locked" };
        }
        return { ok: false, reason: "invalid", remaining: MAX_OTP_ATTEMPTS - record.attempts };
    }
    return { ok: true, record };
};

const isRequestSecure = (req) => {
    return Boolean(
        process.env.NODE_ENV === "production" ||
        req.secure ||
        req.headers["x-forwarded-proto"] === "https"
    );
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
    const storeId = req.store?.id || "handloomer";

    if (!email) {
        return res.status(400).json({ message: "Email is required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    // Check if user already exists within THIS store
    const userExists = await User.findOne({ storeId, email: sanitizedEmail });
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
        storeId,
    });

    const token = generateToken(user._id, storeId);

    // Set secure, HttpOnly cookie for XSS protection
    const secure = isRequestSecure(req);
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure,
        sameSite: secure ? "none" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        storeId: user.storeId,
        token,
    });
});

const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const storeId = req.store?.id || "handloomer";

    // Type guards: also blocks NoSQL-operator payloads ({"$ne": ...} has no .trim)
    if (!email || typeof email !== "string") {
        return res.status(400).json({ message: "Email is required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    // Find the user within the active store context.
    // If not found in this store, allow centralized admin accounts to authenticate.
    let user = await User.findOne({ storeId, email: sanitizedEmail }).select("+password -__v");
    if (!user) {
        const adminUser = await User.findOne({ email: sanitizedEmail, role: "admin" }).select("+password -__v");
        if (adminUser) {
            user = adminUser;
        }
    }

    if (!user) {
        // Generic message: must be identical to the wrong-password case below,
        // otherwise the endpoint becomes a free account-enumeration oracle.
        return res.status(400).json({ message: "Invalid email or password" });
    }

    if (!password || typeof password !== "string" || !user.password) {
        return res.status(400).json({ message: "Invalid email or password" });
    }

    const matchPassword = await bcrypt.compare(password, user.password);
    if (!matchPassword) {
        return res.status(400).json({ message: "Invalid email or password" });
    }

    const tokenStoreId = user.role === "admin" ? storeId : (user.storeId || storeId);
    const token = generateToken(user._id, tokenStoreId);

    // Set secure, HttpOnly cookie for XSS protection
    const secure = isRequestSecure(req);
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure,
        sameSite: secure ? "none" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(200).json({
        user: {
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
            storeId: user.storeId || storeId,
        },
        token,
        message: "Login successful",
    });
});

const forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;
    const storeId = req.store?.id || "handloomer";

    if (!email || typeof email !== "string") {
        return res.status(400).json({ message: "Email is required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    let user = await User.findOne({
        storeId,
        email: { $regex: new RegExp(`^${sanitizedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
    });

    if (!user) {
        const adminUser = await User.findOne({
            email: { $regex: new RegExp(`^${sanitizedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
            role: "admin",
        });
        if (adminUser) user = adminUser;
    }

    if (!user) {
        return res.status(404).json({
            message: "No account found with this email address. Please check your spelling or sign up.",
        });
    }

    // Generate 6-digit OTP (cryptographically secure)
    const otpCode = crypto.randomInt(100000, 1000000).toString();

    // Delete any existing OTP for this email in this store
    await OTP.deleteMany({ storeId, email: user.email, purpose: "password_reset" });

    // Save new purpose-bound OTP with explicit expiration date
    await OTP.create({
        storeId,
        email: user.email,
        otp: hashOtp(otpCode),
        purpose: "password_reset",
        attempts: 0,
        expiresAt: new Date(Date.now() + OTP_RESET_WINDOW_MS),
    });

    // Send email with defensive error handling
    try {
        await emailService.sendPasswordResetOTPEmail(user.email, otpCode, storeId);
    } catch (emailErr) {
        console.error("[ForgotPassword] Failed to send reset OTP email:", emailErr);
        await OTP.deleteMany({ storeId, email: user.email, purpose: "password_reset" });
        return res.status(500).json({
            message: "Failed to send reset code email. Please try again in a few moments.",
        });
    }

    res.status(200).json({
        success: true,
        message: "A 6-digit reset code has been sent to your email.",
    });
});

const verifyOtp = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;
    const storeId = req.store?.id || "handloomer";

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

    const { ok, reason, record, remaining } = await checkResetOtp(sanitizedEmail, otp, storeId);

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
    const storeId = req.store?.id || "handloomer";

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

    // Atomically find and consume the verified unexpired OTP single-use for this store
    const consumed = await OTP.findOneAndDelete({
        storeId,
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
    let user = await User.findOne({ storeId, email: sanitizedEmail }).select("+password");
    if (!user) {
        const adminUser = await User.findOne({ email: sanitizedEmail, role: "admin" }).select("+password");
        if (adminUser) user = adminUser;
    }

    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    // Invalidate every session issued before this moment (all devices).
    user.passwordChangedAt = new Date(Date.now() - 1000);
    await user.save();

    // Delete any remaining OTPs for this email and purpose so codes cannot be replayed.
    await OTP.deleteMany({ storeId, email: sanitizedEmail, purpose: "password_reset" });

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

    const secure = isRequestSecure(req);
    res.cookie("auth_token", "", {
        httpOnly: true,
        secure,
        sameSite: secure ? "none" : "lax",
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
        { returnDocument: 'after', runValidators: true }
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

// GET /api/user/profile — Fetch current authenticated user's profile and saved addresses
const getProfile = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select("-password -revokedTokens");
    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
        success: true,
        user: {
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
            storeId: user.storeId,
            address: user.address || [],
        },
    });
});

// POST /api/user/address — Add a new shipping address to user's address book
const addAddress = asyncHandler(async (req, res) => {
    const { fullName, mobile, pincode, state, city, address, landmark } = req.body || {};

    if (!fullName || !mobile || !pincode || !state || !city || !address) {
        return res.status(400).json({ message: "Full name, mobile, pincode, state, city, and address are required" });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    user.address = user.address || [];
    user.address.push({
        fullName: String(fullName).trim(),
        mobile: String(mobile).trim(),
        pincode: String(pincode).trim(),
        state: String(state).trim(),
        city: String(city).trim(),
        address: String(address).trim(),
        landmark: landmark ? String(landmark).trim() : "",
    });

    await user.save();

    res.status(201).json({
        success: true,
        message: "Address saved successfully",
        address: user.address,
    });
});

// PUT /api/user/address/:id — Update an existing address
const updateAddress = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { fullName, mobile, pincode, state, city, address, landmark } = req.body || {};

    const user = await User.findById(req.user._id);
    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    const addr = user.address?.id(id);
    if (!addr) {
        return res.status(404).json({ message: "Address not found" });
    }

    if (fullName !== undefined) addr.fullName = String(fullName).trim();
    if (mobile !== undefined) addr.mobile = String(mobile).trim();
    if (pincode !== undefined) addr.pincode = String(pincode).trim();
    if (state !== undefined) addr.state = String(state).trim();
    if (city !== undefined) addr.city = String(city).trim();
    if (address !== undefined) addr.address = String(address).trim();
    if (landmark !== undefined) addr.landmark = String(landmark).trim();

    await user.save();

    res.status(200).json({
        success: true,
        message: "Address updated successfully",
        address: user.address,
    });
});

// DELETE /api/user/address/:id — Remove an address from user's address book
const deleteAddress = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const user = await User.findById(req.user._id);
    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    user.address = (user.address || []).filter((a) => a._id.toString() !== id);
    await user.save();

    res.status(200).json({
        success: true,
        message: "Address removed successfully",
        address: user.address,
    });
});

export default {
    registerUser,
    loginUser,
    logoutUser,
    updateProfile,
    getProfile,
    addAddress,
    updateAddress,
    deleteAddress,
    forgotPassword,
    verifyOtp,
    resetPassword,
};
