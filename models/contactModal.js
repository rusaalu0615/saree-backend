import mongoose from "mongoose";

const contactSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, "Name is required"],
            trim: true,
            maxlength: [100, "Name cannot exceed 100 characters"],
        },
        email: {
            type: String,
            required: [true, "Email is required"],
            trim: true,
            lowercase: true,
            maxlength: [100, "Email cannot exceed 100 characters"],
            match: [/^\S+@\S+\.\S+$/, "Please provide a valid email address"],
        },
        phone: {
            type: String,
            trim: true,
            maxlength: [20, "Phone number cannot exceed 20 characters"],
            default: "",
        },
        message: {
            type: String,
            required: [true, "Message is required"],
            trim: true,
            minlength: [5, "Message must be at least 5 characters"],
            maxlength: [2000, "Message cannot exceed 2000 characters"],
        },
        status: {
            type: String,
            enum: ["new", "in_progress", "resolved", "archived"],
            default: "new",
        },
        ip: {
            type: String,
            default: "",
        },
    },
    {
        timestamps: true,
    }
);

contactSchema.index({ createdAt: -1 });
contactSchema.index({ status: 1 });

const Contact = mongoose.model("Contact", contactSchema);
export default Contact;

