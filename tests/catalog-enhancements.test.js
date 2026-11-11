import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Product from "../models/productModal.js";
import productController from "../controllers/productController.js";

const MONGO_URI = process.env.TEST_MONGO_URI || (
    process.env.MONGO_URI ? process.env.MONGO_URI.replace(/\/([^\/?]+)(\?|$)/, '/$1_test$2') : null
);

describe("Catalog Enhancements & Data Retrieval Suite", () => {
    let createdProductIds = [];
    let p1, p2, p3;

    function mockRes() {
        const res = {
            statusCode: 200,
            body: null,
            headers: {},
            setHeader(name, val) { this.headers[name] = val; },
            status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; return this; },
        };
        return res;
    }

    before(async () => {
        if (!MONGO_URI) throw new Error("MONGO_URI not configured");
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(MONGO_URI);
        }

        const suffix = Date.now().toString().slice(-6);

        p1 = await Product.create({
            name: `Royal Kanjivaram Silk Saree ${suffix}`,
            sku: `RKS-${suffix}-RED`,
            category: "silk-sarees",
            material: "Pure Silk",
            color: "Crimson Red",
            price: 5500,
            regularPrice: 7000,
            stock: 10,
            mainImage: "https://example.com/p1-main.jpg",
            galleryImages: [{ url: "https://example.com/p1-g1.jpg" }],
            isFeatured: true,
            isBestSeller: false,
            videoFile: "https://example.com/p1-video.mp4",
            shortDescription: "A royal silk saree",
            tags: "silk, red, royal",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Dry clean",
        });
        createdProductIds.push(p1._id);

        p2 = await Product.create({
            name: `Casual Linen Saree ${suffix}`,
            sku: `CLS-${suffix}-BLU`,
            category: "linen-sarees",
            material: "Organic Linen",
            color: "Azure Blue",
            price: 2200,
            regularPrice: 3000,
            stock: 5,
            mainImage: "https://example.com/p2-main.jpg",
            galleryImages: [],
            isFeatured: false,
            isBestSeller: true,
            shortDescription: "A casual blue linen saree",
            tags: "linen, blue, casual",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Hand wash",
        });
        createdProductIds.push(p2._id);

        p3 = await Product.create({
            name: `Designer Cotton Saree ${suffix}`,
            sku: `DCS-${suffix}-YEL`,
            category: "cotton-sarees",
            material: "Fine Cotton",
            color: "Bright Yellow",
            price: 1500,
            regularPrice: 2000,
            stock: 15,
            mainImage: "https://example.com/p3-main.jpg",
            galleryImages: [],
            isFeatured: true,
            isBestSeller: true,
            videoFile: "https://example.com/p3-video.mp4",
            shortDescription: "A designer yellow cotton saree",
            tags: "cotton, yellow, designer",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Machine wash",
        });
        createdProductIds.push(p3._id);
    });

    after(async () => {
        if (createdProductIds.length > 0) {
            await Product.deleteMany({ _id: { $in: createdProductIds } });
        }
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
        }
    });

    test("1. getProductBySlug resolves canonical slug with SKU suffix", async () => {
        const canonicalSlug = `royal-kanjivaram-silk-saree-${p1.sku.toLowerCase()}`;
        const req = { params: { slug: canonicalSlug } };
        const res = mockRes();
        await productController.getProductBySlug(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.product._id.toString(), p1._id.toString());
        assert.equal(res.body.product.sku, p1.sku);
    });

    test("2. getProductBySlug resolves exact SKU", async () => {
        const req = { params: { slug: p2.sku } };
        const res = mockRes();
        await productController.getProductBySlug(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.product._id.toString(), p2._id.toString());
    });

    test("3. getProductBySlug resolves legacy name dash pattern", async () => {
        const nameSlug = p3.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const req = { params: { slug: nameSlug } };
        const res = mockRes();
        await productController.getProductBySlug(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.product._id.toString(), p3._id.toString());
    });

    test("4. getAllProducts exact SKU search match takes precedence over text search", async () => {
        const req = { query: { search: p1.sku } };
        const res = mockRes();
        await productController.getAllProducts(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.ok(res.body.products.length >= 1);
        assert.equal(res.body.products[0].sku, p1.sku);
    });

    test("5. getAllProducts supports isFeatured, isBestSeller, and hasVideo filters", async () => {
        // hasVideo
        const reqVideo = { query: { hasVideo: "true" } };
        const resVideo = mockRes();
        await productController.getAllProducts(reqVideo, resVideo);
        assert.equal(resVideo.statusCode, 200);
        const videoProducts = resVideo.body.products;
        assert.ok(videoProducts.every(p => !!p.videoFile));

        // isBestSeller
        const reqBest = { query: { isBestSeller: "true" } };
        const resBest = mockRes();
        await productController.getAllProducts(reqBest, resBest);
        assert.equal(resBest.statusCode, 200);
        const bestProducts = resBest.body.products;
        assert.ok(bestProducts.some(p => p.sku === p2.sku));
        assert.ok(bestProducts.every(p => p.isBestSeller === true));

        // isFeatured
        const reqFeat = { query: { isFeatured: "true" } };
        const resFeat = mockRes();
        await productController.getAllProducts(reqFeat, resFeat);
        assert.equal(resFeat.statusCode, 200);
        const featProducts = resFeat.body.products;
        assert.ok(featProducts.some(p => p.sku === p1.sku));
        assert.ok(featProducts.every(p => p.isFeatured === true));
    });

    test("6. getAllProducts supports sort options: featured, color-asc, color-desc", async () => {
        const reqSort = { query: { sortBy: "color-asc", limit: "10" } };
        const resSort = mockRes();
        await productController.getAllProducts(reqSort, resSort);
        assert.equal(resSort.statusCode, 200);
        assert.ok(resSort.body.products.length > 0);
    });

    test("7. getFilters returns facet aggregation counts and priceRange", async () => {
        const req = { query: {} };
        const res = mockRes();
        await productController.getFilters(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.ok(Array.isArray(res.body.colors));
        assert.ok(Array.isArray(res.body.materials));
        assert.ok(res.body.counts && typeof res.body.counts.colors === "object");
        assert.ok(res.body.priceRange && typeof res.body.priceRange.min === "number");
        assert.ok(res.body.priceRange.max >= res.body.priceRange.min);
    });

    test("8. getAdminMediaLibrary returns paginated lightweight image metadata", async () => {
        const req = { query: { page: 1, limit: 10 } };
        const res = mockRes();
        await productController.getAdminMediaLibrary(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.ok(Array.isArray(res.body.products));
        assert.ok(res.body.pagination);
        assert.ok(res.body.pagination.totalProducts >= 3);
        const sample = res.body.products[0];
        assert.ok(sample.name);
        assert.ok(sample.sku);
        assert.ok(sample.mainImage);
    });

    test("9. getAllProducts returns galleryImages with url but excludes heavy metadata, while getProductById returns full metadata", async () => {
        const reqList = { query: { search: p1.sku, limit: "1" } };
        const resList = mockRes();
        await productController.getAllProducts(reqList, resList);

        assert.equal(resList.statusCode, 200);
        const listProduct = resList.body.products[0];
        assert.ok(listProduct);
        assert.equal(listProduct.mainImage, "https://example.com/p1-main.jpg");
        assert.ok(Array.isArray(listProduct.galleryImages));
        assert.equal(listProduct.galleryImages.length, 1);
        assert.equal(listProduct.galleryImages[0].url, "https://example.com/p1-g1.jpg");
        assert.equal(listProduct.galleryImages[0].title, undefined);
        assert.equal(listProduct.galleryImages[0].description, undefined);

        const reqDetail = { params: { id: p1._id.toString() } };
        const resDetail = mockRes();
        await productController.getProductById(reqDetail, resDetail);
        assert.equal(resDetail.statusCode, 200);
        const detailProduct = resDetail.body.product;
        assert.ok(detailProduct);
        assert.equal(detailProduct.galleryImages[0].url, "https://example.com/p1-g1.jpg");
    });

    test("10. getRecommendations does not throw due to seen initialization and excludes current product", async () => {
        const req = {
            params: { productId: p1._id.toString() },
            query: { limit: "8" }
        };
        const res = mockRes();
        await productController.getRecommendations(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.ok(Array.isArray(res.body.products));
        assert.ok(res.body.products.length > 0);
        // Current product must be strictly excluded
        assert.ok(!res.body.products.some(p => p._id.toString() === p1._id.toString()));
        assert.equal(typeof res.body.hasMore, "boolean");

        // Verify lightweight card structure
        const first = res.body.products[0];
        assert.ok(first._id);
        assert.ok(first.name);
        assert.ok(first.sku);
        assert.ok(first.category);
        assert.equal(typeof first.price, "number");
        assert.ok(first.mainImage);
    });

    test("11. getRecommendations broad fallback returns products when no category/material/color/new/sale matches exist", async () => {
        const suffix = Date.now().toString().slice(-6);
        const pIsolated = await Product.create({
            name: `Exotic Saree ${suffix}`,
            sku: `EXO-${suffix}-CYN`,
            category: "exotic-unique-category",
            material: "Rare Space Fiber",
            color: "Neon Cyan",
            price: 99999,
            regularPrice: 99999,
            stock: 2,
            mainImage: "https://example.com/p-iso.jpg",
            galleryImages: [],
            isNewArrival: false,
            isOnSale: false,
            isFeatured: false,
            isBestSeller: false,
            productCollection: "none",
            shortDescription: "An isolated product with no attributes in common",
            tags: "exotic, rare",
            sareeSize: "5.5m",
            blouseSize: "0.8m",
            washCare: "Special",
        });
        createdProductIds.push(pIsolated._id);

        const req = {
            params: { productId: pIsolated._id.toString() },
            query: { limit: "4" }
        };
        const res = mockRes();
        await productController.getRecommendations(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.ok(Array.isArray(res.body.products));
        // Broad fallback stage ({}) must return existing products (p1, p2, p3, etc.)
        assert.ok(res.body.products.length > 0, "Broad fallback must return products");
        // Must exclude the isolated current product
        assert.ok(!res.body.products.some(p => p._id.toString() === pIsolated._id.toString()));
    });
});