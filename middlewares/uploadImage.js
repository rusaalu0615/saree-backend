import multer from "multer";

// Use memory storage for fast file parsing.
// Files are buffered in RAM and uploaded to Cloudinary in parallel
// from the controller (via utils/cloudinaryUpload.js).
const memoryStorage = multer.memoryStorage();

const upLoadImage = multer({ storage: memoryStorage });

export default upLoadImage;
