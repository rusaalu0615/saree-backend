import crypto from "crypto";

// Verify x-api-key against SHIPROCKET_WEBHOOK_TOKEN with timing-safe compare.
// Missing production token fails closed (401). Secret is never logged.
export const verifyCarrierWebhook = (req, res, next) => {
  const expected = process.env.SHIPROCKET_WEBHOOK_TOKEN;
  if (!expected) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const incoming = String(req.headers["x-api-key"] || "");
  const a = Buffer.from(incoming);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  return next();
};

export default verifyCarrierWebhook;
