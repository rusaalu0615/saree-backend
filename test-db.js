import mongoose from "mongoose";
import "dotenv/config";

const test = async () => {
    try {
        console.log("Connecting...");
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected. Quering...");
        const count = await mongoose.connection.db.collection("products").countDocuments();
        console.log("Count:", count);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

test();
