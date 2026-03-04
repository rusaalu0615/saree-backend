import categoriesModal from "../modal/categoriesModal.js";

const addCategory = async (req, res) => {
    try {
        const { name, sortDesc } = req.body;
        const image = req.file;

        if (!name || !sortDesc || !image) {
            return res.status(400).json({
                message: "All fields are required",
            });
        }

        const category = await categoriesModal.create({
            name,
            sortDesc,
            image: image.path, // ✅ Cloudinary URL
        });

        res.status(201).json({
            success: true,
            message: "Category added successfully",
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

const deletCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const category = await categoriesModal.findByIdAndDelete(id);
        if (!category) {
            return res.status(404).json({
                success: false,
                message: "Category not found",
            })
        }
        res.status(200).json({
            success: true,
            message: "Category deleted successfully",
            category,
        })
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        })
    }
}

const getAllCategory = async (req, res) => {
    try {
        const categories = await categoriesModal.find();
        if (!categories) {
            return res.status(404).json({
                success: false,
                message: "Categories not found",
            })
        }
        res.status(200).json({
            success: true,
            message: "Categories fetched successfully",
            categories,
        })

    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        })
    }
}

const updateCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, sortDesc } = req.body;
        const image = req.file;

        const updateData = {};
        if (name) updateData.name = name;
        if (sortDesc) updateData.sortDesc = sortDesc;
        if (image) updateData.image = image.path; // Cloudinary URL

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

export default { addCategory, deletCategory, getAllCategory, updateCategory };