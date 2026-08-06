import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

/**
 * Generate a PDF invoice for an order
 * @param {Object} order The DB order object
 * @returns {Promise<Buffer>} The PDF buffer to be attached to an email
 */
export const generateInvoicePDF = (order) => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: "A4" });
            const chunks = [];

            // Collect PDF data chunks into a buffer
            doc.on("data", (chunk) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", (err) => reject(err));

            // --- HEADER ---
            doc.fillColor("#444444")
                .fontSize(20)
                .text("MS HANDLOOM", 50, 50, { align: "left" }) // Brand Name
                .fontSize(10)
                .text("www.mshandloomer.com", { align: "left" })
                .text("mshandloom7@gmail.com", { align: "left" });

            doc.fontSize(20)
                .text("INVOICE", 0, 50, { align: "right" })
                .fontSize(10)
                .text(`Order ID: ${order.orderId}`, { align: "right" })
                .text(`Date: ${new Date(order.createdAt).toLocaleDateString("en-IN")}`, { align: "right" })
                .text(`Payment: ${order.payment.method.toUpperCase()}`, { align: "right" });

            doc.moveDown(3);
            generateHr(doc, doc.y);
            doc.moveDown(2);

            // --- CUSTOMER DETAILS ---
            const customerY = doc.y;
            doc.fontSize(12).font("Helvetica-Bold").text("Billed To:", 50, customerY);
            doc.fontSize(10).font("Helvetica")
                .text(`${order.shippingAddress.firstName} ${order.shippingAddress.lastName}`, 50, customerY + 15)
                .text(order.shippingAddress.address, 50, customerY + 30)
                .text(`${order.shippingAddress.city}, ${order.shippingAddress.state} ${order.shippingAddress.pincode}`, 50, customerY + 45)
                .text(order.shippingAddress.phone, 50, customerY + 60)
                .text(order.shippingAddress.email, 50, customerY + 75);

            doc.moveDown(4);
            generateHr(doc, doc.y);
            doc.moveDown();

            // --- TABLE HEADER ---
            const tableTop = doc.y;
            doc.font("Helvetica-Bold").fontSize(10);
            generateTableRow(doc, tableTop, "Item", "Description", "Price", "Qty", "Total");
            generateHr(doc, tableTop + 20);
            doc.font("Helvetica");

            // --- ITEMS ---
            let currY = tableTop + 30;
            for (let i = 0; i < order.items.length; i++) {
                const item = order.items[i];
                const itemTotal = item.price * item.quantity;

                generateTableRow(
                    doc,
                    currY,
                    i + 1,
                    item.name,
                    `Rs. ${item.price.toLocaleString("en-IN")}`,
                    item.quantity,
                    `Rs. ${itemTotal.toLocaleString("en-IN")}`
                );

                generateHr(doc, currY + 20);
                currY += 30;

                // Add page break if needed
                if (currY > 700) {
                    doc.addPage();
                    currY = 50;
                }
            }

            // --- TOTALS ---
            doc.moveDown();
            const totalsY = doc.y;

            doc.font("Helvetica-Bold");
            generateTableRow(doc, totalsY, "", "", "", "Subtotal", `Rs. ${order.pricing.subtotal.toLocaleString("en-IN")}`);
            generateTableRow(doc, totalsY + 20, "", "", "", "Shipping", `Rs. ${order.pricing.shipping.toLocaleString("en-IN")}`);
            if (order.pricing.discount > 0) {
                generateTableRow(doc, totalsY + 40, "", "", "", "Discount", `- Rs. ${order.pricing.discount.toLocaleString("en-IN")}`);
                generateTableRow(doc, totalsY + 60, "", "", "", "Total", `Rs. ${order.pricing.total.toLocaleString("en-IN")}`);
            } else {
                generateTableRow(doc, totalsY + 40, "", "", "", "Total", `Rs. ${order.pricing.total.toLocaleString("en-IN")}`);
            }

            // --- FOOTER ---
            doc.font("Helvetica").fontSize(10);
            doc.text(
                "Thank you for shopping with Ms Handloom!",
                50,
                700,
                { align: "center", width: 500 }
            );

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
};

function generateHr(doc, y) {
    doc.strokeColor("#aaaaaa").lineWidth(1).moveTo(50, y).lineTo(550, y).stroke();
}

function generateTableRow(doc, y, item, description, price, quantity, lineTotal) {
    doc.fontSize(10)
        .text(item, 50, y)
        .text(description.substring(0, 40), 100, y) // limit desc length
        .text(price, 280, y, { width: 90, align: "right" })
        .text(quantity, 370, y, { width: 90, align: "right" })
        .text(lineTotal, 0, y, { align: "right" });
}

export default {
    generateInvoicePDF,
};
