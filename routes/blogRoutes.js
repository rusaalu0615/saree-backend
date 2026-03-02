import express from "express";
import blogController from "../controllers/blogController.js";

const blogRouter = express.Router();

const { addBlog, getAllBlogs, deleteBlog, updateBlog } = blogController;

blogRouter.post("/add-blog", addBlog);
blogRouter.get("/allblogs", getAllBlogs);
blogRouter.delete("/:id", deleteBlog);
blogRouter.put("/update/:id", updateBlog);

export default blogRouter;
