import nodemailer from "nodemailer";
import dns from "dns";

// Force Node.js to prefer IPv4 DNS resolution globally. This completely eliminates ENETUNREACH 
// errors when attempting to connect to Google SMTP servers in IPv6-unsupported container networks (like Render).
dns.setDefaultResultOrder("ipv4first");

/**
 * HTML Escaper to prevent HTML injection / XSS in email templates
 */
export const escapeHtml = (str) => {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

/**
 * Configure / Reuse Nodemailer transporter
 */
let cachedTransporter = null;

export const getTransporter = () => {
    if (cachedTransporter) return cachedTransporter;

    // Return standard secure SMTP transporter (IPv4 enforced, secure TLS)
    cachedTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === "true", // true for 465, false for 587
        family: 4,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
        tls: {
            minVersion: "TLSv1.2",
            // rejectUnauthorized is left to secure default (true) — NEVER false
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
    });

    return cachedTransporter;
};

/**
 * Set custom transporter (useful for testing with nodemailer-mock or in-memory transport)
 */
export const setTransporter = (t) => {
    cachedTransporter = t;
};

/**
 * Format currency
 */
const formatCurrency = (amount) => `Rs. ${(Number(amount) || 0).toLocaleString("en-IN")}`;

/**
 * Send Order Confirmation Email with PDF attached (if valid)
 * @param {Object} order - The DB order object
 * @param {Buffer} pdfBuffer - The generated PDF buffer (optional)
 */
export const sendOrderConfirmationEmail = async (order, pdfBuffer) => {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            const msg = "[Email] Critical configuration error: EMAIL_USER or EMAIL_PASS not set in environment variables";
            console.error(msg);
            throw Object.assign(new Error(msg), { permanent: true });
        }

        const transporter = getTransporter();

        const hasValidPdf = pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0;

        const safeFirstName = escapeHtml(order.shippingAddress?.firstName || "Customer");
        const safeLastName = escapeHtml(order.shippingAddress?.lastName || "");
        const safeOrderId = escapeHtml(order.orderId || "");
        const safeEmail = order.shippingAddress?.email || "";
        const safeAddress = escapeHtml(order.shippingAddress?.address || "");
        const safeCity = escapeHtml(order.shippingAddress?.city || "");
        const safeState = escapeHtml(order.shippingAddress?.state || "");
        const safePincode = escapeHtml(order.shippingAddress?.pincode || "");
        const safePhone = escapeHtml(order.shippingAddress?.phone || "");

        const itemsHtml = (order.items || [])
            .map(
                (item) => `
                <tr>
                    <td style="padding: 10px; border-bottom: 1px solid #eee;">${escapeHtml(item.name)}</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: center;">${Number(item.quantity) || 1}</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">${formatCurrency((item.price || 0) * (item.quantity || 1))}</td>
                </tr>
            `
            )
            .join("");

        const subtotal = order.pricing?.subtotal || 0;
        const shipping = order.pricing?.shipping || 0;
        const discount = order.pricing?.discount || 0;
        const total = order.pricing?.total || 0;

        const attachments = [];
        if (hasValidPdf) {
            attachments.push({
                filename: `Invoice_${order.orderId}.pdf`,
                content: pdfBuffer,
            });
        }

        const invoiceNote = hasValidPdf
            ? `<p style="margin-top: 30px; font-size: 14px; color: #666;">Please find your detailed invoice attached to this email.</p>`
            : `<p style="margin-top: 30px; font-size: 14px; color: #666;">Your invoice will be included with your shipment and is available in your order tracking dashboard.</p>`;

        const mailOptions = {
            from: `"Ms Handloom" <${process.env.EMAIL_USER}>`,
            to: safeEmail,
            subject: `Order Confirmation - ${safeOrderId}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                    <div style="text-align: center; padding: 20px 0;">
                        <h1 style="color: #8B7355; margin: 0;">MS HANDLOOM</h1>
                    </div>
                    
                    <div style="padding: 20px; background-color: #f9f9f9; border-radius: 5px;">
                        <h2 style="margin-top: 0;">Thank you for your order!</h2>
                        <p>Hi ${safeFirstName},</p>
                        <p>We've received your order <strong>${safeOrderId}</strong> and are getting it ready for shipment.</p>
                        
                        <h3 style="margin-top: 30px;">Order Summary</h3>
                        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                            <thead>
                                <tr style="background-color: #eee;">
                                    <th style="padding: 10px; text-align: left;">Item</th>
                                    <th style="padding: 10px; text-align: center;">Qty</th>
                                    <th style="padding: 10px; text-align: right;">Total</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${itemsHtml}
                            </tbody>
                            <tfoot>
                                <tr>
                                    <td colspan="2" style="padding: 10px; text-align: right; font-weight: bold;">Subtotal:</td>
                                    <td style="padding: 10px; text-align: right;">${formatCurrency(subtotal)}</td>
                                </tr>
                                <tr>
                                    <td colspan="2" style="padding: 10px; text-align: right; font-weight: bold;">Shipping:</td>
                                    <td style="padding: 10px; text-align: right;">${formatCurrency(shipping)}</td>
                                </tr>
                                ${discount > 0 ? `
                                <tr>
                                    <td colspan="2" style="padding: 10px; text-align: right; font-weight: bold; color: green;">Discount:</td>
                                    <td style="padding: 10px; text-align: right; color: green;">-${formatCurrency(discount)}</td>
                                </tr>
                                ` : ""}
                                <tr>
                                    <td colspan="2" style="padding: 10px; text-align: right; font-weight: bold; font-size: 16px;">Total:</td>
                                    <td style="padding: 10px; text-align: right; font-weight: bold; font-size: 16px;">${formatCurrency(total)}</td>
                                </tr>
                            </tfoot>
                        </table>
                        
                        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd;">
                            <h3>Shipping Address</h3>
                            <p style="margin: 0;">${safeFirstName} ${safeLastName}</p>
                            <p style="margin: 0;">${safeAddress}</p>
                            <p style="margin: 0;">${safeCity}, ${safeState} ${safePincode}</p>
                            <p style="margin: 0;">Phone: ${safePhone}</p>
                        </div>
                        
                        ${invoiceNote}
                    </div>
                </div>
            `,
            attachments,
        };

        const info = await transporter.sendMail(mailOptions);
        if (info.rejected && info.rejected.length > 0 && (!info.accepted || info.accepted.length === 0)) {
            throw Object.assign(new Error(`SMTP rejected all recipients: ${info.rejected.join(", ")}`), { permanent: true });
        }

        console.log(`[Email] Order confirmation sent successfully: ${info.messageId}`);
        return { status: "sent", messageId: info.messageId, accepted: info.accepted };
    } catch (err) {
        console.error("[Email Error] Critical failure sending order confirmation:", {
            message: err.message,
            code: err.code,
        });
        throw err;
    }
};

/**
 * Verify connectivity (diagnostic tool, does not guarantee delivery)
 */
export const verifyEmailConfig = async () => {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            console.warn("[Email] EMAIL_USER/EMAIL_PASS not configured — SMTP disabled");
            return false;
        }
        const transporter = getTransporter();
        console.log("[Email] Verifying configuration on startup...");
        await transporter.verify();
        console.log("[Email] ✅ Configuration verified — Service is ready");
        return true;
    } catch (err) {
        console.error("[Email Error] ❌ Verification failed on startup:", err.message);
        return false;
    }
};

/**
 * Send Shipping Update Email
 * @param {Object} order - The DB order object
 * @param {String} status - The new status (shipped, in_transit, etc)
 */
export const sendShippingUpdateEmail = async (order, status) => {
    if (status !== "shipped" && status !== "out_for_delivery" && status !== "delivered") {
        return { status: "skipped", reason: "status_not_emailed" };
    }

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        throw Object.assign(new Error("[Email] EMAIL_USER/EMAIL_PASS not set — cannot send shipping update"), { permanent: true });
    }

    let statusMessage = "";
    let subject = "";

    const safeOrderId = escapeHtml(order.orderId || "");
    const safeFirstName = escapeHtml(order.shippingAddress?.firstName || "Customer");
    const safeAwb = escapeHtml(order.shiprocket?.awbCode || "");
    const safeCourier = escapeHtml(order.shiprocket?.courierName || "Assigned Courier");

    if (status === "shipped") {
        subject = `Your Order ${order.orderId} has Shipped!`;
        statusMessage = "Good news! Your order has been packed and handed over to our delivery partner.";
    } else if (status === "out_for_delivery") {
        subject = `Your Order ${order.orderId} is Out for Delivery!`;
        statusMessage = "Your order is out for delivery and should arrive today.";
    } else {
        subject = `Your Order ${order.orderId} has been Delivered`;
        statusMessage = "Your order has been successfully delivered. We hope you love your purchase!";
    }

    const transporter = getTransporter();

    const mailOptions = {
        from: `"Ms Handloom" <${process.env.EMAIL_USER}>`,
        to: order.shippingAddress?.email,
        subject: subject,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                <div style="text-align: center; padding: 20px 0;">
                    <h1 style="color: #8B7355; margin: 0;">MS HANDLOOM</h1>
                </div>
                
                <div style="padding: 20px; background-color: #f9f9f9; border-radius: 5px;">
                    <h2 style="margin-top: 0;">Tracking Update</h2>
                    <p>Hi ${safeFirstName},</p>
                    <p>${escapeHtml(statusMessage)}</p>
                    
                    <div style="margin: 30px 0; padding: 20px; background-color: #fff; border: 1px solid #ddd; border-radius: 5px; text-align: center;">
                        <h3 style="margin-top: 0; color: #555;">Order Details</h3>
                        <p style="font-size: 18px; font-weight: bold; margin: 10px 0;">${safeOrderId}</p>
                        
                        ${safeAwb ? `
                            <p style="margin: 10px 0;">Tracking Number / AWB:</p>
                            <p style="font-family: monospace; font-size: 16px; background-color: #eee; padding: 5px; display: inline-block;">${safeAwb}</p>
                            <p style="margin-top: 5px; font-size: 14px; color: #666;">Courier: ${safeCourier}</p>
                        ` : ""}
                    </div>
                    
                    <p>You can track your order live on our website.</p>
                </div>
            </div>
        `,
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        if (info.rejected && info.rejected.length > 0 && (!info.accepted || info.accepted.length === 0)) {
            throw Object.assign(new Error(`SMTP rejected all recipients: ${info.rejected.join(", ")}`), { permanent: true });
        }
        console.log(`[Email] Shipping update (${status}) sent: ${info.messageId}`);
        return { status: "sent", messageId: info.messageId, accepted: info.accepted };
    } catch (err) {
        console.error("[Email Error] Failed to send shipping update:", err.message);
        throw err;
    }
};

/**
 * Send Admin Verification OTP Email
 * @param {String} email - Admin email address
 * @param {String} otp - 6-digit OTP code
 */
export const sendAdminOTPEmail = async (email, otp) => {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            const msg = "[Email] Critical configuration error: EMAIL_USER or EMAIL_PASS not set in environment variables";
            console.error(msg);
            throw new Error(msg);
        }

        const transporter = getTransporter();
        const safeOtp = escapeHtml(otp);
        const mailOptions = {
            from: `"Ms Handloom Admin" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `Admin Verification Code — Ms Handloom`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e5ded6; border-radius: 8px; color: #333;">
                    <div style="text-align: center; border-bottom: 2px solid #8B7355; padding-bottom: 15px; margin-bottom: 20px;">
                        <h1 style="color: #8B7355; margin: 0; font-family: 'Playfair Display', serif; letter-spacing: 2px;">MS HANDLOOM</h1>
                        <p style="margin: 5px 0 0 0; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; color: #888;">Administrative Control Center</p>
                    </div>
                    
                    <div style="padding: 10px 0;">
                        <h2 style="margin-top: 0; color: #444; font-size: 18px;">Admin OTP Verification</h2>
                        <p style="line-height: 1.5; color: #555;">You are attempting to log into the administrative control panel. Use the verification code below to authorize your session.</p>
                        
                        <div style="background-color: #fcfbfa; border: 1px dashed #c4a77d; border-radius: 6px; padding: 20px; text-align: center; margin: 25px 0;">
                            <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #8B7355;">${safeOtp}</span>
                        </div>
                        
                        <p style="font-size: 13px; color: #666; line-height: 1.5; background-color: #f7f7f7; padding: 10px; border-radius: 4px;">
                            <strong>Security Notice:</strong> This code is valid for exactly <strong>5 minutes</strong> and can only be used once. If you did not initiate this request, please ignore this email.
                        </p>
                    </div>
                </div>
            `,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] Admin OTP sent successfully to ${email}: ${info.messageId}`);
        return true;
    } catch (err) {
        console.error("[Email Error] Failed to send admin OTP email:", err.message);
        throw err;
    }
};

/**
 * Send Password Reset OTP Email
 * @param {String} email - User's email address
 * @param {String} otp - 6-digit OTP code
 */
export const sendPasswordResetOTPEmail = async (email, otp) => {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            const msg = "[Email] Critical configuration error: EMAIL_USER or EMAIL_PASS not set";
            console.error(msg);
            throw new Error(msg);
        }

        const transporter = getTransporter();
        const safeOtp = escapeHtml(otp);
        const mailOptions = {
            from: `"Ms Handloom" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `Password Reset Verification Code — Ms Handloom`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e5ded6; border-radius: 8px; color: #333;">
                    <div style="text-align: center; border-bottom: 2px solid #8B7355; padding-bottom: 15px; margin-bottom: 20px;">
                        <h1 style="color: #8B7355; margin: 0; font-family: 'Playfair Display', serif; letter-spacing: 2px;">MS HANDLOOM</h1>
                    </div>
                    
                    <div style="padding: 10px 0;">
                        <h2 style="margin-top: 0; color: #444; font-size: 18px;">Password Reset Request</h2>
                        <p style="line-height: 1.5; color: #555;">We received a request to reset your password. Use the verification code below to proceed.</p>
                        
                        <div style="background-color: #fcfbfa; border: 1px dashed #c4a77d; border-radius: 6px; padding: 20px; text-align: center; margin: 25px 0;">
                            <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #8B7355;">${safeOtp}</span>
                        </div>
                    </div>
                </div>
            `,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] Password Reset OTP sent successfully to ${email}: ${info.messageId}`);
        return true;
    } catch (err) {
        console.error("[Email Error] Failed to send password reset OTP email:", err.message);
        throw err;
    }
};

/**
 * Send New Order Notification to Admin
 * @param {Object} order - The DB order object
 */
export const sendAdminOrderNotificationEmail = async (order) => {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            throw Object.assign(new Error("[Email] EMAIL_USER/EMAIL_PASS not set — cannot send admin notification"), { permanent: true });
        }

        const adminEmails = process.env.ADMIN_EMAILS || process.env.EMAIL_USER;
        if (!adminEmails) {
            throw Object.assign(new Error("[Email] No admin recipient configured (ADMIN_EMAILS/EMAIL_USER)"), { permanent: true });
        }

        const transporter = getTransporter();

        const safeOrderId = escapeHtml(order.orderId || "");
        const safeCustName = escapeHtml(`${order.shippingAddress?.firstName || ""} ${order.shippingAddress?.lastName || ""}`.trim());
        const safeEmail = escapeHtml(order.shippingAddress?.email || "");
        const safePhone = escapeHtml(order.shippingAddress?.phone || "");
        const safeMethod = escapeHtml(order.payment?.method?.toUpperCase() || "COD");
        const safeAddress = escapeHtml(order.shippingAddress?.address || "");
        const safeCity = escapeHtml(order.shippingAddress?.city || "");
        const safeState = escapeHtml(order.shippingAddress?.state || "");
        const safePincode = escapeHtml(order.shippingAddress?.pincode || "");

        const itemsList = (order.items || [])
            .map((i) => `<li>${Number(i.quantity) || 1}x ${escapeHtml(i.name)} (SKU: ${escapeHtml(i.sku || "N/A")}) - ${formatCurrency((i.price || 0) * (i.quantity || 1))}</li>`)
            .join("");

        const mailOptions = {
            from: `"Ms Handloom System" <${process.env.EMAIL_USER}>`,
            to: adminEmails,
            subject: `🎉 NEW ORDER: ${safeOrderId} - ${formatCurrency(order.pricing?.total || 0)}`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px;">
                    <div style="text-align: center; border-bottom: 2px solid #8B7355; padding-bottom: 15px; margin-bottom: 20px;">
                        <h1 style="color: #28a745; margin: 0; font-size: 24px;">New Order Received!</h1>
                    </div>
                    
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                        <tr><td style="padding: 5px 0;"><strong>Order ID:</strong></td><td>${safeOrderId}</td></tr>
                        <tr><td style="padding: 5px 0;"><strong>Customer:</strong></td><td>${safeCustName}</td></tr>
                        <tr><td style="padding: 5px 0;"><strong>Email:</strong></td><td>${safeEmail}</td></tr>
                        <tr><td style="padding: 5px 0;"><strong>Phone:</strong></td><td>${safePhone}</td></tr>
                        <tr><td style="padding: 5px 0;"><strong>Payment:</strong></td><td><span style="background: #e9ecef; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: bold;">${safeMethod}</span></td></tr>
                        <tr><td style="padding: 5px 0;"><strong>Total Value:</strong></td><td style="color: #28a745; font-weight: bold; font-size: 16px;">${formatCurrency(order.pricing?.total || 0)}</td></tr>
                    </table>
                    
                    <h3 style="border-bottom: 1px solid #ddd; padding-bottom: 5px;">Items Ordered</h3>
                    <ul style="padding-left: 20px; line-height: 1.6;">
                        ${itemsList}
                    </ul>
                    
                    <div style="margin-top: 25px; padding: 15px; background: #f9f9f9; border-left: 4px solid #8B7355; border-radius: 4px;">
                        <h4 style="margin-top: 0; margin-bottom: 10px; color: #555;">Shipping Destination:</h4>
                        <p style="margin:0; font-size: 14px; line-height: 1.5;">
                        ${safeAddress}<br>
                        ${safeCity}, ${safeState} - <strong>${safePincode}</strong>
                        </p>
                    </div>
                </div>
            `,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] Admin notification sent successfully: ${info.messageId}`);
        return { status: "sent", messageId: info.messageId, accepted: info.accepted };
    } catch (err) {
        console.error("[Email Error] Failed to send admin order notification:", err.message);
        throw err;
    }
};

export default {
    escapeHtml,
    sendOrderConfirmationEmail,
    verifyEmailConfig,
    sendShippingUpdateEmail,
    sendAdminOTPEmail,
    sendPasswordResetOTPEmail,
    sendAdminOrderNotificationEmail,
    getTransporter,
    setTransporter,
};
