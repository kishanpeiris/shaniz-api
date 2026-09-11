import { Resend } from 'resend'

// Spec Section 2: "Automated emails: order confirmation, shipping/dispatch
// notice, invoice (PDF attached)" + Section 2 bookable services: "Booking
// confirmation email with date/time."
//
// Uses Resend (project-spec.md Section 1). If EMAIL_API_KEY isn't set —
// e.g. in local dev, or before you've created a Resend account — emails
// are logged to the console instead of sent, so every other feature that
// depends on "an email gets sent" still works end-to-end without one.

const resend = process.env.EMAIL_API_KEY ? new Resend(process.env.EMAIL_API_KEY) : null
const FROM = process.env.EMAIL_FROM || 'orders@shaniz.lk'

const fmt = (n) => 'LKR ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })

// pg returns DATE columns as JS Date objects (midnight UTC) — format as
// plain YYYY-MM-DD rather than letting template interpolation call
// toString() and print a full timezone-laden date.
const fmtDate = (d) => {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  return date.toISOString().slice(0, 10)
}

async function send({ to, subject, html }) {
  if (!resend) {
    console.log(`\n[dev email — no EMAIL_API_KEY set]\nTo: ${to}\nSubject: ${subject}\n${html}\n`)
    return { dev: true }
  }
  try {
    return await resend.emails.send({ from: FROM, to, subject, html })
  } catch (err) {
    // Never let a failed email break the request that triggered it
    // (an order/booking is already saved in the DB by this point).
    console.error('Email send failed:', err.message)
    return { error: err.message }
  }
}

const layout = (title, bodyHtml) => `
  <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; color: #2b3a2f;">
    <h2 style="color:#2b3a2f; border-bottom: 2px solid #c9a35c; padding-bottom: 10px;">${title}</h2>
    ${bodyHtml}
    <p style="margin-top: 32px; font-size: 12px; color: #8a8672;">Shani'z Herbal Hair &amp; Skin Care</p>
  </div>
`

export async function sendOrderConfirmationEmail(order, toEmail) {
  const rows = order.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0;">${i.name} × ${i.qty}${
          i.is_preorder
            ? `<br/><span style="font-size:12px; color:#8a6d3b;">Pre-order — estimated arrival ${i.preorder_eta_date}</span>`
            : ''
        }</td><td style="text-align:right;">${fmt(
          i.unit_price_lkr * i.qty
        )}</td></tr>`
    )
    .join('')

  const html = layout(
    'Order Confirmation',
    `
      <p>Thank you for your order! Here's a summary:</p>
      <p style="font-size:13px; color:#5c5949;">Order ID: ${order.id}</p>
      <table style="width:100%; border-collapse:collapse; margin: 16px 0;">${rows}
        <tr><td style="padding-top:10px; font-weight:bold;">Total</td>
            <td style="padding-top:10px; font-weight:bold; text-align:right;">${fmt(order.total_lkr)}</td></tr>
      </table>
      <p>Status: <strong>${order.status}</strong></p>
    `
  )
  return send({ to: toEmail, subject: `Order confirmation — ${order.id.slice(0, 8)}`, html })
}

export async function sendShippingNoticeEmail(order, toEmail) {
  const html = layout(
    'Your Order Has Shipped',
    `<p>Order <strong>${order.id.slice(0, 8)}</strong> is on its way.</p>`
  )
  return send({ to: toEmail, subject: `Your order has shipped — ${order.id.slice(0, 8)}`, html })
}

export async function sendBookingConfirmationEmail(booking, serviceName, toEmail) {
  const html = layout(
    'Booking Confirmed',
    `
      <p>Your appointment is confirmed:</p>
      <p><strong>${serviceName}</strong><br/>
      ${fmtDate(booking.booked_date)} at ${booking.booked_time}</p>
      <p style="font-size:13px; color:#5c5949;">Booking ID: ${booking.id}</p>
    `
  )
  return send({ to: toEmail, subject: `Booking confirmed — ${serviceName}`, html })
}

export async function sendBookingReminderEmail(booking, serviceName, toEmail) {
  const html = layout(
    'See You Tomorrow',
    `
      <p>Just a friendly reminder about your appointment tomorrow:</p>
      <p><strong>${serviceName}</strong><br/>
      ${fmtDate(booking.booked_date)} at ${String(booking.booked_time).slice(0, 5)}</p>
      <p style="font-size:13px; color:#5c5949;">Need to reschedule or cancel? Just reply to this email or reach out to us directly.</p>
    `
  )
  return send({ to: toEmail, subject: `Reminder: ${serviceName} tomorrow`, html })
}

export async function sendBookingUpdateEmail(booking, serviceName, toEmail) {
  const statusText =
    booking.status === 'cancelled'
      ? 'has been cancelled'
      : `is now scheduled for ${fmtDate(booking.booked_date)} at ${booking.booked_time}`
  const html = layout('Booking Update', `<p><strong>${serviceName}</strong> ${statusText}.</p>`)
  return send({ to: toEmail, subject: `Booking update — ${serviceName}`, html })
}

export async function sendPasswordResetEmail(toEmail, resetUrl) {
  const html = layout(
    'Reset Your Password',
    `
      <p>Click the link below to reset your password. This link expires in 20 minutes and can only be used once.</p>
      <p><a href="${resetUrl}" style="color:#2b3a2f;">${resetUrl}</a></p>
      <p style="font-size:13px; color:#5c5949;">If you didn't request this, you can ignore this email.</p>
    `
  )
  return send({ to: toEmail, subject: 'Reset your Shani\u2019z password', html })
}

export async function sendVerificationEmail(toEmail, verifyUrl) {
  const html = layout(
    'Confirm Your Email',
    `
      <p>Thanks for creating a Shani&rsquo;z account. Click the link below to confirm this email address. This link expires in 24 hours.</p>
      <p><a href="${verifyUrl}" style="color:#2b3a2f;">${verifyUrl}</a></p>
      <p style="font-size:13px; color:#5c5949;">If you didn't create this account, you can ignore this email.</p>
    `
  )
  return send({ to: toEmail, subject: 'Confirm your Shani\u2019z email address', html })
}

export async function sendFraudAlertEmail(order, flags, toEmail) {
  const rows = flags
    .map((f) => `<li><strong>${f.severity.toUpperCase()}</strong> — ${f.message}</li>`)
    .join('')
  const html = layout(
    'Fraud Check Flagged an Order',
    `
      <p>Order <strong>${order.id}</strong> (Rs. ${Number(order.total_lkr).toLocaleString()}) tripped the following automatic check${flags.length > 1 ? 's' : ''}:</p>
      <ul>${rows}</ul>
      <p style="font-size:13px; color:#5c5949;">This isn't a confirmation of fraud — just worth a quick look before shipping. Review it from Admin → Fraud Alerts.</p>
    `
  )
  return send({ to: toEmail, subject: `⚠ Order flagged for review — ${order.id.slice(0, 8)}`, html })
}

// Spec Section 7 monitoring: "Alert (email) to super admin on ... new
// admin account created." toEmail is one superadmin's address — the
// caller (admin.routes.js) sends one of these per active superadmin,
// same pattern as sendFraudAlertEmail.
export async function sendNewAdminAlertEmail(newAdmin, actorName, toEmail) {
  const html = layout(
    'New Admin Account Created',
    `
      <p><strong>${actorName}</strong> just created a new ${newAdmin.role} account:</p>
      <ul>
        <li>Name: ${newAdmin.name}</li>
        <li>Email: ${newAdmin.email}</li>
        <li>Role: ${newAdmin.role}</li>
      </ul>
      <p style="font-size:13px; color:#5c5949;">If this wasn't you or expected, review it from Admin → Admins and the audit log right away.</p>
    `
  )
  return send({ to: toEmail, subject: `New ${newAdmin.role} account created — ${newAdmin.email}`, html })
}

// Spec Section 8's "Stock alerts widget" already shows this on the
// dashboard, but only to someone actively looking at it. This is the
// same information pushed out proactively instead — fires once per
// product per crossing (see lib/lowStockAlert.js for why), not once per
// sale, so it can't spam admins while a popular item slowly sells out.
export async function sendLowStockAlertEmail(product, toEmail) {
  const html = layout(
    'Low Stock Alert',
    `
      <p><strong>${product.name}</strong> just dropped to <strong>${product.newQty}</strong> in stock — at or below its low-stock threshold of ${product.threshold}.</p>
      <p style="font-size:13px; color:#5c5949;">Restock it, or adjust the threshold, from Admin → Products.</p>
    `
  )
  return send({ to: toEmail, subject: `Low stock: ${product.name} (${product.newQty} left)`, html })
}

// The homepage "Visit us" contact form (project-spec.md "Contact form —
// still a placeholder"). No customer-facing confirmation email is sent
// here — just notifying the business. name/email/message are already
// validated (length + shape) by the zod schema in site.routes.js before
// this is called; still escaped-free since this is an internal email,
// not rendered back to any visitor.
export async function sendContactMessageEmail({ name, email, message }, toEmail) {
  const html = layout(
    'New Contact Form Message',
    `
      <p><strong>From:</strong> ${name} (${email})</p>
      <p style="white-space: pre-wrap;">${message}</p>
    `
  )
  return send({ to: toEmail, subject: `Website message from ${name}`, html })
}

export async function sendInvoiceEmail(order, toEmail, pdfUrl) {
  const html = layout(
    'Your Invoice',
    `<p>Your invoice for order <strong>${order.id.slice(0, 8)}</strong> is ready.</p>
     ${pdfUrl ? `<p><a href="${pdfUrl}" style="color:#2b3a2f;">Download invoice (PDF)</a></p>` : ''}`
  )
  return send({ to: toEmail, subject: `Invoice — ${order.id.slice(0, 8)}`, html })
}
