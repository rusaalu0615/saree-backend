import User from "../models/userModal.js";

/**
 * Get user's wishlist items
 */
const getWishlist = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).populate("wishList.productId");
        
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        res.status(200).json({
            success: true,
            wishlist: user.wishList || []
        });
    } catch (error) {
        console.error("Error in getWishlist:", error);
        res.status(500).json({ success: false, message: "Server error while fetching wishlist" });
    }
};

/**
 * Add an item to user's wishlist
 */
const addToWishlist = async (req, res) => {
    try {
        const { productId } = req.body;
        
        if (!productId) {
            return res.status(400).json({ success: false, message: "Product ID is required" });
        }

        const user = await User.findById(req.user._id);
        
        // Check if already in wishlist
        const exists = user.wishList.find(item => item.productId.toString() === productId);
        if (exists) {
            return res.status(200).json({ success: true, message: "Item already in wishlist", wishlist: user.wishList });
        }

        user.wishList.push({ productId, quantity: 1 });
        await user.save();

        // Populate for frontend
        const populatedUser = await User.findById(req.user._id).populate("wishList.productId");

        res.status(200).json({
            success: true,
            message: "Item added to wishlist",
            wishlist: populatedUser.wishList
        });
    } catch (error) {
        console.error("Error in addToWishlist:", error);
        res.status(500).json({ success: false, message: "Server error while adding to wishlist" });
    }
};

/**
 * Remove an item from wishlist
 */
const removeFromWishlist = async (req, res) => {
    try {
        const { productId } = req.params;

        const user = await User.findById(req.user._id);
        user.wishList = user.wishList.filter(item => item.productId.toString() !== productId);
        await user.save();

        // Populate for frontend
        const populatedUser = await User.findById(req.user._id).populate("wishList.productId");

        res.status(200).json({
            success: true,
            message: "Item removed from wishlist",
            wishlist: populatedUser.wishList
        });
    } catch (error) {
        console.error("Error in removeFromWishlist:", error);
        res.status(500).json({ success: false, message: "Server error while removing from wishlist" });
    }
};

/**
 * Clear entire wishlist
 */
const clearWishlist = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        user.wishList = [];
        await user.save();

        res.status(200).json({
            success: true,
            message: "Wishlist cleared",
            wishlist: []
        });
    } catch (error) {
        console.error("Error in clearWishlist:", error);
        res.status(500).json({ success: false, message: "Server error while clearing wishlist" });
    }
};

/**
 * Sync local wishlist to server (merge)
 */
const syncWishlist = async (req, res) => {
    try {
        const { productIds } = req.body; // Expecting array of product IDs

        if (!productIds || !Array.isArray(productIds)) {
            return res.status(400).json({ success: false, message: "productIds array is required" });
        }

        const user = await User.findById(req.user._id);
        
        const currentIds = user.wishList.map(item => item.productId.toString());
        
        productIds.forEach(id => {
            if (!currentIds.includes(id)) {
                user.wishList.push({ productId: id, quantity: 1 });
            }
        });

        await user.save();

        // Populate for frontend
        const populatedUser = await User.findById(req.user._id).populate("wishList.productId");

        res.status(200).json({
            success: true,
            message: "Wishlist synced successfully",
            wishlist: populatedUser.wishList
        });
    } catch (error) {
        console.error("Error in syncWishlist:", error);
        res.status(500).json({ success: false, message: "Server error while syncing wishlist" });
    }
};

export default {
    getWishlist,
    addToWishlist,
    removeFromWishlist,
    clearWishlist,
    syncWishlist
};
