import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer from "multer";

const videoStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: "videos",
        resource_type: "video",
        allowedFormats: ["mp4", "avi", "mkv", "mov", "webm"],
    }
})

const upLoadVideo = multer({ storage: videoStorage })

export default upLoadVideo;