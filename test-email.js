import nodemailer from "nodemailer";
import dotenv from "dotenv";

// Load env vars explicitly for the test script
dotenv.config();

console.log("Testing with:");
console.log("EMAIL_USER:", process.env.EMAIL_USER);
console.log("EMAIL_PASS:", process.env.EMAIL_PASS ? "****" + process.env.EMAIL_PASS.slice(-4) : "NOT SET");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

async function testEmail() {
    try {
        console.log("Verifying connection credentials...");
        await transporter.verify();
        console.log("✅ Server is ready to take our messages");

        console.log("Sending test email...");
        const info = await transporter.sendMail({
            from: `"Test Server" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_USER, // Send to yourself
            subject: "Test Email from Node.js",
            text: "Hello! If you receive this, Nodemailer is working perfectly.",
        });

        console.log("✅ Message sent: %s", info.messageId);
    } catch (error) {
        console.error("❌ Error sending email:", error);
    }
}

testEmail();
