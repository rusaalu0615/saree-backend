import blogModal from "../models/blogModal.js";

const addBlog = async (req, res) => {
    try {
        const { title, description } = req.body;
        const imageFile = req.file;

        // The image can either come as a file (preferred) or as a URL (fallback for legacy)
        const image = imageFile ? imageFile.path : req.body.image;

        if (!title || !description || !image) {
            return res.status(400).json({
                success: false,
                message: "Please provide title, description, and an image",
            });
        }

        const blog = new blogModal({
            title: title.trim(),
            description: description.trim(),
            image,
        });

        await blog.save();

        res.status(201).json({
            success: true,
            message: "Blog post published successfully",
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
        const blogs = await blogModal.find({}).sort({ createdAt: -1 });
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
                message: "Blog post not found",
            });
        }

        res.status(200).json({
            success: true,
            message: "Blog post removed successfully",
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
        const { title, description } = req.body;
        const imageFile = req.file;

        const updateData = {};
        if (title) updateData.title = title.trim();
        if (description) updateData.description = description.trim();
        
        // Handle image update from file OR body URL
        if (imageFile) {
            updateData.image = imageFile.path;
        } else if (req.body.image) {
            updateData.image = req.body.image;
        }

        const blog = await blogModal.findByIdAndUpdate(id, updateData, { new: true });

        if (!blog) {
            return res.status(404).json({
                success: false,
                message: "Blog post not found",
            });
        }

        res.status(200).json({
            success: true,
            message: "Blog entry updated successfully",
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

export default { addBlog, getAllBlogs, deleteBlog, updateBlog };
