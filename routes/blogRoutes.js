import express from "express";
import blogController from "../controllers/blogController.js";
import upLoadImage from "../middlewares/uploadImage.js";

const blogRouter = express.Router();

const { addBlog, getAllBlogs, deleteBlog, updateBlog, getBlogById } = blogController;

// Using upLoadImage.single("image") to handle the featured image upload in the backend
blogRouter.post("/add-blog", upLoadImage.single("image"), addBlog);
blogRouter.get("/allblogs", getAllBlogs);
blogRouter.get("/:id", getBlogById);
blogRouter.delete("/:id", deleteBlog);
blogRouter.put("/update/:id", upLoadImage.single("image"), updateBlog);

export default blogRouter;
