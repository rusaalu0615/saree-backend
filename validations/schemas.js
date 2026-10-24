import { z } from "zod";

/**
 * Central Zod request schemas for the API.
 *
 * Guideline: each schema mirrors (never exceeds) the validation the matching
 * controller already performs, so wiring these in as gate-only middleware can
 * only improve error clarity — it cannot reject a request that used to succeed.
 * Numeric fields arriving via multipart/form-data use z.coerce so stringified
 * values ("1200") validate correctly.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP6_RE = /^\d{6}$/;
const PHONE10_RE = /^\d{10}$/;

// A required, well-formed email (used where the controller already enforces format).
const emailField = () =>
    z
        .string({ error: "Email is required" })
        .trim()
        .min(1, "Email is required")
        .regex(EMAIL_RE, "Please enter a valid email address");

// A required email that we only check for presence (login/forgot), so we never
// lock out an account whose stored email predates strict formatting.
const emailPresent = () =>
    z.string({ error: "Email is required" }).trim().min(1, "Email is required");

// ── User auth / profile ──────────────────────────────────────────────
export const registerSchema = z.object({
    name: z.string().trim().optional(),
    email: emailField(),
    phone: z.string().trim().optional(),
    password: z
        .string({ error: "Password is required" })
        .min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
    email: emailPresent(),
    password: z.string({ error: "Password is required" }).min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
    email: emailPresent(),
});

export const verifyOtpSchema = z.object({
    email: emailPresent(),
    otp: z
        .string({ error: "OTP is required" })
        .trim()
        .regex(OTP6_RE, "Invalid or expired OTP"),
});

export const resetPasswordSchema = z.object({
    email: emailPresent(),
    otp: z
        .string({ error: "OTP is required" })
        .trim()
        .regex(OTP6_RE, "Invalid or expired OTP"),
    newPassword: z
        .string({ error: "New password is required" })
        .min(8, "New password must be at least 8 characters"),
});

export const updateProfileSchema = z.object({
    name: z.string().trim().min(1, "Name cannot be empty").optional(),
    phone: z
        .string()
        .trim()
        .regex(PHONE10_RE, "Phone must be a valid 10-digit number")
        .optional(),
});

// ── Admin auth ───────────────────────────────────────────────────────
export const adminSendOtpSchema = z.object({
    email: emailPresent(),
});

export const adminVerifyOtpSchema = z.object({
    email: emailPresent(),
    otp: z
        .string({ error: "Verification code is required" })
        .trim()
        .regex(OTP6_RE, "Please enter the 6-digit verification code"),
});

// ── Cart ─────────────────────────────────────────────────────────────
export const addToCartSchema = z.object({
    productId: z
        .string({ error: "Product ID is required" })
        .min(1, "Product ID is required"),
    quantity: z
        .coerce
        .number()
        .int("Quantity must be a whole number")
        .min(1, "Quantity must be at least 1")
        .optional(),
});

export const updateCartItemSchema = z.object({
    productId: z
        .string({ error: "Product ID is required" })
        .min(1, "Product ID is required"),
    quantity: z.coerce.number({ error: "Quantity is required" }).int("Quantity must be a whole number"),
});

export const syncCartSchema = z.object({
    items: z.array(
        z.object({
            productId: z.string().optional(),
            quantity: z.coerce.number().optional(),
        })
    ),
});

// ── Wishlist ─────────────────────────────────────────────────────────
export const addToWishlistSchema = z.object({
    productId: z
        .string({ error: "Product ID is required" })
        .min(1, "Product ID is required"),
});

export const syncWishlistSchema = z.object({
    productIds: z.array(z.string()),
});

// ── Coupon ───────────────────────────────────────────────────────────
export const applyCouponSchema = z.object({
    code: z
        .string({ error: "Coupon code is required" })
        .trim()
        .min(1, "Coupon code is required"),
    subtotal: z.coerce.number({ error: "Cart subtotal is required" }).min(0, "Invalid cart subtotal"),
});

export const createCouponSchema = z.object({
    code: z
        .string({ error: "Coupon code is required" })
        .trim()
        .min(1, "Coupon code is required"),
    discountType: z.string().trim().optional(),
    discountValue: z.coerce.number({ error: "Discount value is required" }),
    minPurchase: z.coerce.number().optional(),
    usageLimit: z.coerce.number().int().optional(),
    usageLimitPerUser: z.coerce.number().int().optional(),
    expiryDate: z
        .union([z.string(), z.date()])
        .refine(
            (v) => !Number.isNaN(new Date(v).getTime()),
            "A valid expiry date is required"
        ),
    isActive: z.boolean().optional(),
});

// ── Reviews (multipart body fields arrive as strings) ────────────────
export const createReviewSchema = z.object({
    rating: z.coerce
        .number({ error: "Rating is required" })
        .int("Rating must be a whole number")
        .min(1, "Rating must be between 1 and 5")
        .max(5, "Rating must be between 1 and 5"),
    comment: z
        .string({ error: "Comment is required" })
        .trim()
        .min(1, "Comment is required"),
    title: z.string().trim().optional(),
});

// ── Products (multipart; mirrors addProduct's required-field guard) ───
export const addProductSchema = z.object({
    name: z.string({ error: "Name is required" }).trim().min(1, "Name is required"),
    sku: z.string({ error: "SKU is required" }).trim().min(1, "SKU is required"),
    category: z
        .string({ error: "Category is required" })
        .trim()
        .min(1, "Category is required"),
    price: z.coerce.number({ error: "Price is required" }).min(0, "Price must be zero or more"),
    regularPrice: z.coerce.number({ error: "Regular price is required" }).min(0, "Regular price must be zero or more"),
    stock: z.coerce.number({ error: "Stock is required" }).int("Stock must be a whole number").min(0, "Stock must be zero or more"),
    shortDescription: z
        .string({ error: "Short description is required" })
        .trim()
        .min(1, "Short description is required"),
    tags: z.union([
        z.string().trim().min(1, "Tags are required"),
        z.array(z.any()).min(1, "Tags are required"),
    ], { error: "Tags are required" }),
    color: z.string({ error: "Color is required" }).trim().min(1, "Color is required"),
    material: z
        .string({ error: "Material is required" })
        .trim()
        .min(1, "Material is required"),
    sareeSize: z
        .string({ error: "Saree size is required" })
        .trim()
        .min(1, "Saree size is required"),
    blouseSize: z
        .string({ error: "Blouse size is required" })
        .trim()
        .min(1, "Blouse size is required"),
    washCare: z
        .string({ error: "Wash care is required" })
        .trim()
        .min(1, "Wash care is required"),
});

// ── Admin content (multipart; mirrors each controller's required text fields) ──
export const addBlogSchema = z.object({
    title: z.string({ error: "Title is required" }).trim().min(1, "Title is required"),
    description: z
        .string({ error: "Description is required" })
        .trim()
        .min(1, "Description is required"),
});

export const addCategorySchema = z.object({
    name: z
        .string({ error: "Category name is required" })
        .trim()
        .min(1, "Category name is required"),
    sortDesc: z
        .string({ error: "Description is required" })
        .trim()
        .min(1, "Description is required"),
});

export const upsertCategoryBannerSchema = z.object({
    slug: z.string({ error: "Slug is required" }).trim().min(1, "Slug is required"),
    title: z.string({ error: "Title is required" }).trim().min(1, "Title is required"),
});
