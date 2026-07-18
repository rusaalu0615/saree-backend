import Razorpay from "razorpay";
import dotenv from "dotenv";

dotenv.config();

let instance = null;

try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log("Razorpay SDK initialized successfully.");
  } else {
    console.warn("Razorpay keys are missing. Payment integration will not work until keys are added.");
  }
} catch (error) {
  console.error("Failed to initialize Razorpay:", error.message);
}

export default instance;
