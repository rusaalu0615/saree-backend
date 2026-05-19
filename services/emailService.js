import nodemailer from "nodemailer";
import dns from "dns";

// Force Node.js to prefer IPv4 DNS resolution globally. This completely eliminates ENETUNREACH 
// errors when attempting to connect to Google SMTP servers in IPv6-unsupported container networks (like Render).
dns.setDefaultResultOrder("ipv4first");

/**
 * Configure Nodemailer transporter
 */
const getTransporter = () => {
    // Standardizing on port 587 (STARTTLS) which has much higher reliability on cloud platforms like Render
    // We force family: 4 (IPv4) to prevent ENETUNREACH errors on cloud container networks without IPv6
    return nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        family: 4,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
        tls: {
            rejectUnauthorized: false,
            minVersion: "TLSv1.2",
        },
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 45000,
    });
};

/**
 * Format currency
 */
const formatCurrency = (amount) => `Rs. ${amount.toLocaleString("en-IN")}`;

/**
 * Send Order Confirmation Email with PDF attached
 * @param {Object} order - The DB order object
 * @param {Buffer} pdfBuffer - The generated PDF buffer
 */
export const sendOrderConfirmationEmail = async (order, pdfBuffer) => {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            const msg = "[Email] Critical configuration error: EMAIL_USER or EMAIL_PASS not set in environment variables";
            console.error(msg);
            throw new Error(msg);
        }

        const transporter = getTransporter();
        const itemsHtml = order.items
            .map(
                (item) => `
                <tr>
                    <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.name}</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">${formatCurrency(item.price * item.quantity)}</td>
                </tr>
            `
            )
            .join("");

        const mailOptions = {
            from: `"Linen Saree" <${process.env.EMAIL_USER}>`,
            to: order.shippingAddress.email,
            subject: `Order Confirmation - ${order.orderId}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                    <div style="text-align: center; padding: 20px 0;">
                        <h1 style="color: #8B7355; margin: 0;">LINEN SAREE</h1>
                    </div>
                    
                    <div style="padding: 20px; background-color: #f9f9f9; border-radius: 5px;">
                        <h2 style="margin-top: 0;">Thank you for your order!</h2>
                        <p>Hi ${order.shippingAddress.firstName},</p>
                        <p>We've received your order <strong>${order.orderId}</strong> and are getting it ready for shipment.</p>
                        
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
                                    <td style="padding: 10px; text-align: right;">${formatCurrency(order.pricing.subtotal)}</td>
                                </tr>
                                <tr>
                                    <td colspan="2" style="padding: 10px; text-align: right; font-weight: bold;">Shipping:</td>
                                    <td style="padding: 10px; text-align: right;">${formatCurrency(order.pricing.shipping)}</td>
                                </tr>
                                ${order.pricing.discount > 0 ? `
                                <tr>
                                    <td colspan="2" style="padding: 10px; text-align: right; font-weight: bold; color: green;">Discount:</td>
                                    <td style="padding: 10px; text-align: right; color: green;">-${formatCurrency(order.pricing.discount)}</td>
                                </tr>
                                ` : ""}
                                <tr>
                                    <td colspan="2" style="padding: 10px; text-align: right; font-weight: bold; font-size: 16px;">Total:</td>
                                    <td style="padding: 10px; text-align: right; font-weight: bold; font-size: 16px;">${formatCurrency(order.pricing.total)}</td>
                                </tr>
                            </tfoot>
                        </table>
                        
                        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd;">
                            <h3>Shipping Address</h3>
                            <p style="margin: 0;">${order.shippingAddress.firstName} ${order.shippingAddress.lastName}</p>
                            <p style="margin: 0;">${order.shippingAddress.address}</p>
                            <p style="margin: 0;">${order.shippingAddress.city}, ${order.shippingAddress.state} ${order.shippingAddress.pincode}</p>
                            <p style="margin: 0;">Phone: ${order.shippingAddress.phone}</p>
                        </div>
                        
                        <p style="margin-top: 30px; font-size: 14px; color: #666;">
                            Please find your detailed invoice attached to this email.
                        </p>
                    </div>
                </div>
            `,
            attachments: [
                {
                    filename: `Invoice_${order.orderId}.pdf`,
                    content: pdfBuffer,
                },
            ],
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] Order confirmation sent successfully: ${info.messageId}`);
        return true;
    } catch (err) {
        console.error("[Email Error] Critical failure sending order confirmation:", {
            message: err.message,
            stack: err.stack,
            code: err.code,
            command: err.command
        });
        throw err; // Throwing so the caller's catch block can catch it
    }
};

/**
 * Verify connectivity (call this on server startup)
 */
export const verifyEmailConfig = async () => {
    try {
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
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            console.warn("[Email] Skipping shipping update — credentials not set");
            return false;
        }

        const transporter = getTransporter();

        let statusMessage = "";
        let subject = "";

        if (status === "shipped") {
            subject = `Your Order ${order.orderId} has Shipped!`;
            statusMessage = "Good news! Your order has been packed and handed over to our delivery partner.";
        } else if (status === "out_for_delivery") {
            subject = `Your Order ${order.orderId} is Out for Delivery!`;
            statusMessage = "Your order is out for delivery and should arrive today.";
        } else if (status === "delivered") {
            subject = `Your Order ${order.orderId} has been Delivered`;
            statusMessage = "Your order has been successfully delivered. We hope you love your purchase!";
        } else {
            return false; // Don't send emails for other statuses
        }

        const mailOptions = {
            from: `"Linen Saree" <${process.env.EMAIL_USER}>`,
            to: order.shippingAddress.email,
            subject: subject,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                    <div style="text-align: center; padding: 20px 0;">
                        <h1 style="color: #8B7355; margin: 0;">LINEN SAREE</h1>
                    </div>
                    
                    <div style="padding: 20px; background-color: #f9f9f9; border-radius: 5px;">
                        <h2 style="margin-top: 0;">Tracking Update</h2>
                        <p>Hi ${order.shippingAddress.firstName},</p>
                        <p>${statusMessage}</p>
                        
                        <div style="margin: 30px 0; padding: 20px; background-color: #fff; border: 1px solid #ddd; border-radius: 5px; text-align: center;">
                            <h3 style="margin-top: 0; color: #555;">Order Details</h3>
                            <p style="font-size: 18px; font-weight: bold; margin: 10px 0;">${order.orderId}</p>
                            
                            ${order.shiprocket?.awbCode ? `
                                <p style="margin: 10px 0;">Tracking Number / AWB:</p>
                                <p style="font-family: monospace; font-size: 16px; background-color: #eee; padding: 5px; display: inline-block;">${order.shiprocket.awbCode}</p>
                                <p style="margin-top: 5px; font-size: 14px; color: #666;">Courier: ${order.shiprocket.courierName || 'Assigned Courier'}</p>
                            ` : ""}
                        </div>
                        
                        <p>You can track your order live on our website.</p>
                        <a href="http://localhost:3000/track-order" style="display: inline-block; padding: 12px 24px; background-color: #8B7355; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; margin-top: 10px;">Track Order</a>
                    </div>
                </div>
            `,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] Shipping update (${status}) sent: ${info.messageId}`);
        return true;
    } catch (err) {
        console.error("[Email Error] Failed to send shipping update:", err);
        return false;
    }
};

/**
 * Send Admin Verification OTP Email
 * @param {String} email - Admin email address
 * @param {String} otp - 6-digit OTP code
 */
export const sendAdminOTPEmail = async (email, otp) => {
    try {
        // 1. Support Resend API integration (highly reliable HTTP outbound channel)
        if (process.env.RESEND_API_KEY) {
            console.log(`[Email] Using Resend API for OTP delivery to ${email}...`);
            const fromEmail = process.env.RESEND_FROM || "Linen Saree Admin <onboarding@resend.dev>";
            const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    from: fromEmail,
                    to: email,
                    subject: `Admin Verification OTP - ${otp}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e5ded6; border-radius: 8px; color: #333;">
                            <div style="text-align: center; border-bottom: 2px solid #8B7355; padding-bottom: 15px; margin-bottom: 20px;">
                                <h1 style="color: #8B7355; margin: 0; font-family: 'Playfair Display', serif; letter-spacing: 2px;">LINEN SAREE</h1>
                                <p style="margin: 5px 0 0 0; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; color: #888;">Administrative Control Center</p>
                            </div>
                            
                            <div style="padding: 10px 0;">
                                <h2 style="margin-top: 0; color: #444; font-size: 18px;">Admin OTP Verification</h2>
                                <p style="line-height: 1.5; color: #555;">You are attempting to log into the administrative control panel. Use the verification code below to authorize your session.</p>
                                
                                <div style="background-color: #fcfbfa; border: 1px dashed #c4a77d; border-radius: 6px; padding: 20px; text-align: center; margin: 25px 0;">
                                    <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #8B7355;">${otp}</span>
                                </div>
                                
                                <p style="font-size: 13px; color: #666; line-height: 1.5; background-color: #f7f7f7; padding: 10px; border-radius: 4px;">
                                    <strong>Security Notice:</strong> This code is valid for exactly <strong>5 minutes</strong> and can only be used once. If you did not initiate this request, please ignore this email.
                                </p>
                            </div>
                            
                            <div style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px; text-align: center; font-size: 11px; color: #999;">
                                &copy; ${new Date().getFullYear()} Linen Saree E-Commerce. All rights reserved.
                            </div>
                        </div>
                    `,
                }),
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Resend API Error: ${res.status} - ${errText}`);
            }

            const data = await res.json();
            console.log(`[Email] Admin OTP sent successfully via Resend API: ${data.id}`);
            return true;
        }

        // 2. Support Brevo (Sendinblue) HTTP API integration (highly reliable, free public domains permitted)
        if (process.env.BREVO_API_KEY) {
            console.log(`[Email] Using Brevo API for OTP delivery to ${email}...`);
            const senderEmail = process.env.BREVO_SENDER || "rustamali3488@gmail.com";
            const res = await fetch("https://api.brevo.com/v3/smtp/email", {
                method: "POST",
                headers: {
                    "api-key": process.env.BREVO_API_KEY,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    sender: { name: "Linen Saree Admin", email: senderEmail },
                    to: [{ email: email }],
                    subject: `Admin Verification OTP - ${otp}`,
                    htmlContent: `
                        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e5ded6; border-radius: 8px; color: #333;">
                            <div style="text-align: center; border-bottom: 2px solid #8B7355; padding-bottom: 15px; margin-bottom: 20px;">
                                <h1 style="color: #8B7355; margin: 0; font-family: 'Playfair Display', serif; letter-spacing: 2px;">LINEN SAREE</h1>
                                <p style="margin: 5px 0 0 0; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; color: #888;">Administrative Control Center</p>
                            </div>
                            
                            <div style="padding: 10px 0;">
                                <h2 style="margin-top: 0; color: #444; font-size: 18px;">Admin OTP Verification</h2>
                                <p style="line-height: 1.5; color: #555;">You are attempting to log into the administrative control panel. Use the verification code below to authorize your session.</p>
                                
                                <div style="background-color: #fcfbfa; border: 1px dashed #c4a77d; border-radius: 6px; padding: 20px; text-align: center; margin: 25px 0;">
                                    <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #8B7355;">${otp}</span>
                                </div>
                                
                                <p style="font-size: 13px; color: #666; line-height: 1.5; background-color: #f7f7f7; padding: 10px; border-radius: 4px;">
                                    <strong>Security Notice:</strong> This code is valid for exactly <strong>5 minutes</strong> and can only be used once. If you did not initiate this request, please ignore this email.
                                </p>
                            </div>
                            
                            <div style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px; text-align: center; font-size: 11px; color: #999;">
                                &copy; ${new Date().getFullYear()} Linen Saree E-Commerce. All rights reserved.
                            </div>
                        </div>
                    `
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Brevo API Error: ${res.status} - ${errText}`);
            }

            const data = await res.json();
            console.log(`[Email] Admin OTP sent successfully via Brevo API: ${data.messageId}`);
            return true;
        }

        // 3. Fallback to standard Nodemailer SMTP
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            const msg = "[Email] Critical configuration error: EMAIL_USER or EMAIL_PASS not set in environment variables";
            console.error(msg);
            throw new Error(msg);
        }

        const transporter = getTransporter();
        const mailOptions = {
            from: `"Linen Saree Admin" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `Admin Verification OTP - ${otp}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e5ded6; border-radius: 8px; color: #333;">
                    <div style="text-align: center; border-bottom: 2px solid #8B7355; padding-bottom: 15px; margin-bottom: 20px;">
                        <h1 style="color: #8B7355; margin: 0; font-family: 'Playfair Display', serif; letter-spacing: 2px;">LINEN SAREE</h1>
                        <p style="margin: 5px 0 0 0; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; color: #888;">Administrative Control Center</p>
                    </div>
                    
                    <div style="padding: 10px 0;">
                        <h2 style="margin-top: 0; color: #444; font-size: 18px;">Admin OTP Verification</h2>
                        <p style="line-height: 1.5; color: #555;">You are attempting to log into the administrative control panel. Use the verification code below to authorize your session.</p>
                        
                        <div style="background-color: #fcfbfa; border: 1px dashed #c4a77d; border-radius: 6px; padding: 20px; text-align: center; margin: 25px 0;">
                            <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #8B7355;">${otp}</span>
                        </div>
                        
                        <p style="font-size: 13px; color: #666; line-height: 1.5; background-color: #f7f7f7; padding: 10px; border-radius: 4px;">
                            <strong>Security Notice:</strong> This code is valid for exactly <strong>5 minutes</strong> and can only be used once. If you did not initiate this request, please ignore this email.
                        </p>
                    </div>
                    
                    <div style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px; text-align: center; font-size: 11px; color: #999;">
                        &copy; ${new Date().getFullYear()} Linen Saree E-Commerce. All rights reserved.
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

export default {
    sendOrderConfirmationEmail,
    verifyEmailConfig,
    sendShippingUpdateEmail,
    sendAdminOTPEmail,
};
