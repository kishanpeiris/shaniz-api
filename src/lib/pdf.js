import PDFDocument from 'pdfkit'

// Spec Section 2 / "What's stubbed": "Invoice generation (PDF, auto or
// on-demand)." The `invoices` table and an invoice EMAIL already
// existed (src/lib/email.js sendInvoiceEmail) — this file is the piece
// that was missing: an actual PDF file. Kept deliberately simple (one
// page, no logo/letterhead assets to manage) rather than pulling in a
// heavier templating/HTML-to-PDF pipeline, which would be a lot more
// moving parts for a document that's just "here's what you bought and
// what it cost."

const fmt = (n) => 'LKR ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })

// pg returns DATE/TIMESTAMPTZ columns as JS Date objects — format as a
// plain date rather than a full ISO string with a timezone offset.
const fmtDate = (d) => {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  return date.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Renders one order as an invoice PDF and resolves with a Buffer —
// nothing is written to disk here, storage is a separate concern
// (see storePdf in lib/uploads.js) so this function is easy to test on
// its own with just an order object.
export function generateInvoicePdf(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    // ---- Header ----
    doc
      .fontSize(20)
      .fillColor('#2b3a2f')
      .text("Shani'z", { continued: true })
      .fontSize(11)
      .fillColor('#8a8672')
      .text('  Herbal Hair & Skin Care', { continued: false })
    doc.moveDown(1.2)

    doc.fontSize(16).fillColor('#2b3a2f').text('Invoice')
    doc.moveDown(0.3)
    doc.fontSize(10).fillColor('#5c5949')
    doc.text(`Order ID: ${order.id}`)
    doc.text(`Date: ${fmtDate(order.created_at)}`)
    doc.text(`Status: ${order.status}`)
    doc.moveDown(1)

    // ---- Bill to ----
    const billName = [order.customer_first_name, order.customer_last_name].filter(Boolean).join(' ')
    doc.fontSize(11).fillColor('#2b3a2f').text('Bill to')
    doc.fontSize(10).fillColor('#5c5949')
    if (billName) doc.text(billName)
    if (order.customer_email) doc.text(order.customer_email)
    if (order.customer_phone) doc.text(order.customer_phone)
    const addr = order.shipping_address
    if (addr) {
      doc.text([addr.line1, addr.city, addr.postal_code].filter(Boolean).join(', '))
    }
    doc.moveDown(1.2)

    // ---- Line items table (simple, hand-drawn columns — no external
    // table library needed for a document this small) ----
    const tableTop = doc.y
    const col = { name: 50, qty: 340, price: 400, total: 480 }
    doc.fontSize(10).fillColor('#8a8672')
    doc.text('Item', col.name, tableTop)
    doc.text('Qty', col.qty, tableTop)
    doc.text('Price', col.price, tableTop)
    doc.text('Total', col.total, tableTop)
    doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).strokeColor('#c9a35c').stroke()

    let y = tableTop + 22
    doc.fillColor('#2b3a2f')
    for (const item of order.items || []) {
      const lineTotal = Number(item.unit_price_lkr) * Number(item.qty)
      doc.fontSize(10)
      doc.text(item.name, col.name, y, { width: 280 })
      doc.text(String(item.qty), col.qty, y)
      doc.text(fmt(item.unit_price_lkr), col.price, y)
      doc.text(fmt(lineTotal), col.total, y)
      y += 20
    }

    doc.moveTo(50, y + 4).lineTo(545, y + 4).strokeColor('#c9a35c').stroke()
    y += 14

    if (Number(order.delivery_fee_lkr) > 0) {
      doc.fontSize(10).fillColor('#5c5949')
      doc.text('Delivery', col.price, y)
      doc.text(fmt(order.delivery_fee_lkr), col.total, y)
      y += 18
    }

    doc.fontSize(12).fillColor('#2b3a2f')
    doc.text('Total', col.price, y, { bold: true })
    doc.text(fmt(order.total_lkr), col.total, y)

    doc.moveDown(4)
    doc.fontSize(9).fillColor('#8a8672').text(
      "Thank you for your order. This invoice was generated automatically by Shani'z.",
      50,
      doc.y,
      { width: 495 }
    )

    doc.end()
  })
}
