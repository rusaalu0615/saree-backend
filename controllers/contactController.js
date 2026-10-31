import Contact from "../models/contactModal.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { escapeHtml } from "../utils/security.js";

// In-memory sliding rate limiter: IP -> timestamps[]
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_SUBMISSIONS = 5;

const isRateLimited = (ip) => {
    if (!ip) return false;
    const now = Date.now();
    const timestamps = rateLimitMap.get(ip) || [];
    const validTimestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (validTimestamps.length >= RATE_LIMIT_MAX_SUBMISSIONS) {
        return true;
    }
    validTimestamps.push(now);
    rateLimitMap.set(ip, validTimestamps);
    return false;
};

/**
 * POST /api/contact — Public contact form submission
 */
const submitContactMessage = asyncHandler(async (req, res) => {
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";

    if (isRateLimited(ip)) {
        throw new AppError("Too many contact submissions. Please wait a few minutes before trying again.", 429);
    }

    const { name, email, phone, message } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
        throw new AppError("Name is required", 400);
    }
    if (name.trim().length > 100) {
        throw new AppError("Name must not exceed 100 characters", 400);
    }

    if (!email || typeof email !== "string" || !email.trim()) {
        throw new AppError("Email is required", 400);
    }
    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^\S+@\S+\.\S+$/;
    if (!emailRegex.test(cleanEmail) || cleanEmail.length > 100) {
        throw new AppError("Please provide a valid email address", 400);
    }

    let cleanPhone = "";
    if (phone) {
        if (typeof phone !== "string" || phone.trim().length > 20) {
            throw new AppError("Phone number must not exceed 20 characters", 400);
        }
        cleanPhone = phone.trim();
    }

    if (!message || typeof message !== "string" || !message.trim()) {
        throw new AppError("Message is required", 400);
    }
    const cleanMessage = message.trim();
    if (cleanMessage.length < 5) {
        throw new AppError("Message must be at least 5 characters", 400);
    }
    if (cleanMessage.length > 2000) {
        throw new AppError("Message must not exceed 2000 characters", 400);
    }

    // Persist contact message durably
    const contact = await Contact.create({
        name: escapeHtml(name.trim()),
        email: cleanEmail,
        phone: escapeHtml(cleanPhone),
        message: escapeHtml(cleanMessage),
        ip,
        status: "new",
    });

    // Asynchronously send acknowledgment/notification if SMTP is configured
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        try {
            const { getTransporter } = await import("../services/emailService.js");
            const transporter = getTransporter();
            transporter.sendMail({
                from: `"The Handloomer" <${process.env.EMAIL_USER}>`,
                to: cleanEmail,
                subject: "We received your message — The Handloomer",
                text: `Dear ${name.trim()},\n\nThank you for reaching out to The Handloomer. We have received your inquiry and our artisan support team will get back to you shortly.\n\nWarm regards,\nThe Handloomer Team`,
            }).catch((err) => console.warn("[Email] Contact acknowledgment error:", err.message));
        } catch (e) {
            console.warn("Could not send contact acknowledgment email:", e.message);
        }
    }

    res.status(201).json({
        success: true,
        message: "Thank you for reaching out. We have received your message and our team will respond shortly.",
        contactId: contact._id,
    });
});

/**
 * GET /api/contact/admin — Admin list of contact messages
 */
const getContactMessages = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const status = req.query.status;

    const filter = {};
    if (status && ["new", "in_progress", "resolved", "archived"].includes(status)) {
        filter.status = status;
    }

    const [messages, total] = await Promise.all([
        Contact.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Contact.countDocuments(filter),
    ]);

    res.status(200).json({
        success: true,
        messages,
        pagination: {
            page,
            limit,
            totalCount: total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
        },
    });
});

export default {
    submitContactMessage,
    getContactMessages,
};
