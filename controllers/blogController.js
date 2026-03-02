import blogModal from "../modal/blogModal.js";

const addBlog = async (req, res) => {
    try {
        const { title, description, image } = req.body;

        if (!title || !description || !image) {
            return res.status(400).json({
                success: false,
                message: "Please provide title, description, and image",
            });
        }

        const blog = new blogModal({
            title,
            description,
            image,
        });

        await blog.save();

        res.status(201).json({
            success: true,
            message: "Blog added successfully",
            blog,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

const getAllBlogs = async (req, res) => {
    try {
        const blogs = await blogModal.find({});
        res.status(200).json({
            success: true,
            blogs,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

const deleteBlog = async (req, res) => {
    try {
        const { id } = req.params;
        const blog = await blogModal.findByIdAndDelete(id);

        if (!blog) {
            return res.status(404).json({
                success: false,
                message: "Blog not found",
            });
        }

        res.status(200).json({
            success: true,
            message: "Blog deleted successfully",
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

const updateBlog = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, image } = req.body;

        const updateData = {};
        if (title) updateData.title = title;
        if (description) updateData.description = description;
        if (image) updateData.image = image;

        const blog = await blogModal.findByIdAndUpdate(id, updateData, { new: true });

        if (!blog) {
            return res.status(404).json({
                success: false,
                message: "Blog not found",
            });
        }

        res.status(200).json({
            success: true,
            message: "Blog updated successfully",
            blog,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
}

export default { addBlog, getAllBlogs, deleteBlog, updateBlog };
