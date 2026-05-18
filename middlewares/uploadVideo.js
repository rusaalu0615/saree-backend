import multer from "multer";

// Use memory storage — video buffers are uploaded to Cloudinary
// from the controller via utils/cloudinaryUpload.js
const memoryStorage = multer.memoryStorage();

const upLoadVideo = multer({ storage: memoryStorage });

export default upLoadVideo;
