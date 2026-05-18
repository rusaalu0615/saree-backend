import mongoose from "mongoose";

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("MongoDB connected");
    } catch (error) {
        console.error("MongoDB initial connection failed:", error.message);
        process.exit(1);
    }

    // Connection event listeners for runtime monitoring
    mongoose.connection.on("disconnected", () => {
        console.warn("MongoDB disconnected. Mongoose will auto-reconnect.");
    });

    mongoose.connection.on("reconnected", () => {
        console.log("MongoDB reconnected.");
    });

    mongoose.connection.on("error", (err) => {
        console.error("MongoDB connection error:", err.message);
    });
};

export default connectDB;