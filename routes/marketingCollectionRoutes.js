import express from "express";
import { 
    getMarketingCollections, 
    updateMarketingCollection, 
    getCollectionByKey 
} from "../controllers/marketingCollectionController.js";
import upload from "../middlewares/uploadImage.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";

const router = express.Router();

router.get("/", getMarketingCollections);
router.get("/:key", getCollectionByKey);
router.put("/:key", adminProtect, upload.single("image"), updateMarketingCollection);

export default router;
