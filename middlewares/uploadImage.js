import cloudinary from "../config/cloudinary.js";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer from "multer";

const imageStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: "images",
        allowedFormats: ["jpg", "jpeg", "png", "gif"],
    }
})

const upLoadImage = multer({ storage: imageStorage })

export default upLoadImage




