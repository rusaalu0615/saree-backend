import "dotenv/config";
import express from "express";
import connectDB from "./config/db.js";
import cors from "cors";
import indexRoutes from "./routes/index.js";

const app = express()

app.use(cors())
app.use(express.json())

connectDB()

app.use("/api", indexRoutes)

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
})