import multer from "multer";

// Use memory storage for fast file parsing.
// Files are buffered in RAM and uploaded to Cloudflare R2
// from the controller (via utils/r2Upload.js).
const memoryStorage = multer.memoryStorage();

const upLoadImage = multer({ storage: memoryStorage });

export default upLoadImage;
