import User from "../models/userModal.js"
import generateToken from "../utils/generateToken.js"
import bcrypt from "bcryptjs"
import asyncHandler from "../utils/asyncHandler.js"

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

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
        name,
        email: sanitizedEmail,
        phone,
        password: hashedPassword,
    });

    const token = generateToken(user._id);

    // Set secure, HttpOnly, SameSite=None cookie for XSS protection
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        token: token,
    })
});

const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email) {
        return res.status(400).json({ message: "Email is required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    const user = await User.findOne({ email: sanitizedEmail });
    if (!user) {
        return res.status(400).json({ message: "User not found" })
    }

    if (!password || !user.password) {
        return res.status(400).json({ message: "Invalid email or password" })
    }

    const matchPassword = await bcrypt.compare(password, user.password);
    if (!matchPassword) {
        return res.status(400).json({ message: "Invalid email or password" })
    }

    const token = generateToken(user._id);

    // Set secure, HttpOnly, SameSite=None cookie for XSS protection
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(200).json({
        user,
        token,
        message: "Login successfull",
    })
});

export default { registerUser, loginUser }