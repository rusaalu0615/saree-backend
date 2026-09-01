import multer from "multer";

// Use memory storage — video buffers are uploaded to Cloudflare R2
// from the controller via utils/r2Upload.js
const memoryStorage = multer.memoryStorage();

const upLoadVideo = multer({ storage: memoryStorage });

export default upLoadVideo;
