import categoriesModal from "../models/categoriesModal.js";

/**
 * GET /api/category/allcategory
 */
const getAllCategory = async (req, res) => {
    try {
        const categories = await categoriesModal.find();
        res.status(200).json({
            success: true,
            message: "Categories fetched successfully",
            categories,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

/**
 * POST /api/category/add-category
 */
const addCategory = async (req, res) => {
    try {
        const { name, sortDesc } = req.body;
        const image = req.file;

        if (!name || !sortDesc || !image) {
            return res.status(400).json({
                success: false,
                message: "All fields (Name, Description, and Image) are required",
            });
        }

        const category = await categoriesModal.create({
            name: name.trim(),
            sortDesc: sortDesc.trim(),
            image: image.path, // Cloudinary URL
        });

        res.status(201).json({
            success: true,
            message: "Category added successfully",
            category,
        });
    } catch (error) {
        console.error(error);
        
        // Handle MongoDB duplicate key error (code 11000)
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: "A category with this name already exists",
            });
        }

        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

/**
 * PUT /api/category/:id
 */
const updateCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, sortDesc } = req.body;
        const imageFile = req.file;

        const updateData = {};
        if (name) updateData.name = name.trim();
        if (sortDesc) updateData.sortDesc = sortDesc.trim();
        if (imageFile) updateData.image = imageFile.path;

        const category = await categoriesModal.findByIdAndUpdate(id, updateData, { new: true });
        if (!category) {
            return res.status(404).json({
                success: false,
                message: "Category not found",
            });
        }

        res.status(200).json({
            success: true,
            message: "Category updated successfully",
            category,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

/**
 * DELETE /api/category/:id
 */
const deleteCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const category = await categoriesModal.findByIdAndDelete(id);
        if (!category) {
            return res.status(404).json({
                success: false,
                message: "Category not found",
            });
        }
        res.status(200).json({
            success: true,
            message: "Category deleted successfully",
            category,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export default { addCategory, deleteCategory, getAllCategory, updateCategory };