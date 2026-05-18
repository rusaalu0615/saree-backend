import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function updateStock() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }));
        
        const result = await Product.updateMany({}, { $set: { stock: 100 } });
        console.log(`Successfully updated ${result.modifiedCount} products to 100 stock.`);
        
        process.exit(0);
    } catch (err) {
        console.error('Error updating stock:', err);
        process.exit(1);
    }
}

updateStock();
