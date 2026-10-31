import "dotenv/config";
import mongoose from "mongoose";
import Product from "../models/productModal.js";
import Order from "../models/orderModal.js";
import Review from "../models/reviewModal.js";
import productController from "../controllers/productController.js";
import orderController from "../controllers/orderController.js";
import adminController from "../controllers/adminController.js";

const MONGO_URI = process.env.TEST_MONGO_URI || (
    process.env.MONGO_URI ? process.env.MONGO_URI.replace(/\/([^\/?]+)(\?|$)/, '/$1_test$2') : null
);

function createMockRes() {
    let statusCode = 200;
    let data = null;
    return {
        status(c) { statusCode = c; return this; },
        json(payload) { data = payload; return this; },
        getData() { return data; },
        getStatusCode() { return statusCode; },
    };
}

async function benchmark() {
    console.log("=== PERFORMANCE BENCHMARKING ===");
    if (!MONGO_URI) throw new Error("MONGO_URI not configured");
    await mongoose.connect(MONGO_URI);

    const measurements = {};

    // 1. Measure Bounded Product Catalogue Queries (20 iterations)
    const catalogueTimes = [];
    let lastCatalogueData = null;
    for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const res = createMockRes();
        await productController.getAllProducts({ query: { page: "1", limit: "20" } }, res);
        const duration = performance.now() - start;
        catalogueTimes.push(duration);
        lastCatalogueData = res.getData();
    }
    catalogueTimes.sort((a, b) => a - b);
    const catP50 = catalogueTimes[Math.floor(catalogueTimes.length * 0.5)];
    const catP95 = catalogueTimes[Math.floor(catalogueTimes.length * 0.95)];
    const catSize = Buffer.byteLength(JSON.stringify(lastCatalogueData || {}));

    measurements.catalogue = {
        iterations: 20,
        p50_ms: Math.round(catP50 * 10) / 10,
        p95_ms: Math.round(catP95 * 10) / 10,
        size_bytes: catSize,
        size_kb: Math.round(catSize / 102.4) / 10,
    };
    console.log(`Catalogue (limit=20): p50 = ${measurements.catalogue.p50_ms}ms, p95 = ${measurements.catalogue.p95_ms}ms, payload = ${measurements.catalogue.size_kb} KB`);

    // 2. Measure Admin Order Search Queries (20 iterations)
    const orderTimes = [];
    let lastOrderData = null;
    for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const res = createMockRes();
        await orderController.getAllOrders({ query: { search: "ORD-", page: "1", limit: "20" } }, res);
        const duration = performance.now() - start;
        orderTimes.push(duration);
        lastOrderData = res.getData();
    }
    orderTimes.sort((a, b) => a - b);
    const ordP50 = orderTimes[Math.floor(orderTimes.length * 0.5)];
    const ordP95 = orderTimes[Math.floor(orderTimes.length * 0.95)];
    const ordSize = Buffer.byteLength(JSON.stringify(lastOrderData || {}));

    measurements.orderSearch = {
        iterations: 20,
        p50_ms: Math.round(ordP50 * 10) / 10,
        p95_ms: Math.round(ordP95 * 10) / 10,
        size_bytes: ordSize,
        size_kb: Math.round(ordSize / 102.4) / 10,
    };
    console.log(`Admin Order Search: p50 = ${measurements.orderSearch.p50_ms}ms, p95 = ${measurements.orderSearch.p95_ms}ms, payload = ${measurements.orderSearch.size_kb} KB`);

    // 3. Measure Dashboard Stats Aggregation (20 iterations)
    const dashTimes = [];
    let lastDashData = null;
    for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const res = createMockRes();
        await adminController.getDashboardStats({}, res);
        const duration = performance.now() - start;
        dashTimes.push(duration);
        lastDashData = res.getData();
    }
    dashTimes.sort((a, b) => a - b);
    const dashP50 = dashTimes[Math.floor(dashTimes.length * 0.5)];
    const dashP95 = dashTimes[Math.floor(dashTimes.length * 0.95)];
    const dashSize = Buffer.byteLength(JSON.stringify(lastDashData || {}));

    measurements.dashboard = {
        iterations: 20,
        p50_ms: Math.round(dashP50 * 10) / 10,
        p95_ms: Math.round(dashP95 * 10) / 10,
        size_bytes: dashSize,
        size_kb: Math.round(dashSize / 102.4) / 10,
    };
    console.log(`Dashboard Stats Aggregation: p50 = ${measurements.dashboard.p50_ms}ms, p95 = ${measurements.dashboard.p95_ms}ms, payload = ${measurements.dashboard.size_kb} KB`);

    await mongoose.disconnect();
    console.log("=== BENCHMARK COMPLETED SUCCESSFULLY ===");
    console.log(JSON.stringify(measurements, null, 2));
}

benchmark().catch((err) => {
    console.error("Benchmark error:", err);
    process.exit(1);
});

