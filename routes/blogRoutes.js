import express from "express";
import blogController from "../controllers/blogController.js";
import upLoadImage from "../middlewares/uploadImage.js";
import { adminProtect } from "../middlewares/adminMiddleware.js";
import validate from "../middlewares/validate.js";
import { addBlogSchema } from "../validations/schemas.js";

const blogRouter = express.Router();

const { addBlog, getAllBlogs, deleteBlog, updateBlog, getBlogById } = blogController;

// Public read routes
blogRouter.get("/allblogs", getAllBlogs);
blogRouter.get("/:id", getBlogById);

// Admin write routes
blogRouter.post("/add-blog", adminProtect, upLoadImage.single("image"), validate(addBlogSchema), addBlog);
blogRouter.delete("/:id", adminProtect, deleteBlog);
blogRouter.put("/update/:id", adminProtect, upLoadImage.single("image"), updateBlog);

export default blogRouter;
