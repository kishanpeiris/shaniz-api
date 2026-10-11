import { Resend } from 'resend'
import { googleMapsLink } from './pickupBranch.js'
import { unsubscribeUrl } from './emailPrefs.js'
import { getServiceProvider, providerWording, providerBranchLabel } from './serviceProvider.js'

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

// Shared by the order confirmation and invoice emails — both need to
// tell a pickup customer which branch and how to get there; nothing to
// show at all for a home-delivery order (pickup_branch is only ever set
// when delivery_method === 'pickup', see orders.routes.js).
function pickupBranchHtml(order) {
  if (!order.pickup_branch) return ''
  const b = order.pickup_branch
  return `
    <div style="margin:16px 0; padding:12px; border:1px solid #c9a35c; border-radius:4px;">
      <p style="margin:0 0 4px; font-weight:bold;">Collect your order from:</p>
      <p style="margin:0;">${esc(b.name)}<br/>${esc(b.address)}${b.phone ? `<br/>${esc(b.phone)}` : ''}</p>
      <p style="margin:8px 0 0;"><a href="${googleMapsLink(b)}" style="color:#2b3a2f;">Get directions on Google Maps →</a></p>
    </div>
  `
}

// Plain-English hints for the most common Resend problems.
function emailHint(message = '') {
  const m = message.toLowerCase()
  if (m.includes('domain') && m.includes('not verified')) {
    return 'Your sending domain is not verified in Resend. Verify it under Resend → Domains, or for a quick test set EMAIL_FROM to onboarding@resend.dev.'
  }
  if (m.includes('only send testing emails')) {
    return 'Resend only lets an unverified account email itself. Verify your domain in Resend → Domains and use an address on it in EMAIL_FROM.'
  }
  if (m.includes('api key')) return 'The EMAIL_API_KEY looks wrong or has been revoked — create a new one in Resend → API Keys.'
  return 'Check the Resend dashboard → Logs for details.'
}

export function emailStatus() {
  return { configured: Boolean(resend), from: FROM }
}
console.log(
  resend
    ? `[email] Resend is configured. Sending from: ${FROM}`
    : '[email] EMAIL_API_KEY is not set — emails are only printed in this log, NOT delivered.'
)

// `unsubscribe` (optional) is a URL: adds the List-Unsubscribe header, which
// makes Gmail/Outlook show their own "Unsubscribe" button next to the sender.
async function send({ to, subject: rawSubject, html, unsubscribe }) {
  // a line break inside a subject could be used to smuggle extra email headers
  const subject = String(rawSubject).replace(/[\r\n]+/g, ' ')
  if (!resend) {
    console.log(`\n[dev email — no EMAIL_API_KEY set]\nTo: ${to}\nSubject: ${subject}\n${html}\n`)
    return { dev: true }
  }
  try {
    const result = await resend.emails.send({
      from: FROM,
      to,
      subject,
      html,
      ...(unsubscribe ? { headers: { 'List-Unsubscribe': `<${unsubscribe}>` } } : {}),
    })
    // The Resend library does NOT throw when Resend refuses an email (for
    // example an unverified domain) — it returns { error }. Without this
    // check a rejected email looked like a success and nothing was logged.
    if (result?.error) {
      console.error(`[email] FAILED to send "${subject}" to ${to}: ${result.error.name} — ${result.error.message}`)
      return { error: result.error.message, hint: emailHint(result.error.message) }
    }
    return result
  } catch (err) {
    // Never let a failed email break the request that triggered it
    // (an order/booking is already saved in the DB by this point).
    console.error(`[email] FAILED to send "${subject}" to ${to}:`, err.message)
    return { error: err.message, hint: emailHint(err.message) }
  }
}

// Used by Admin → Settings → "Send a test email" so email problems can be
// diagnosed without waiting for a real customer to report them.
export async function sendTestEmail(to) {
  const html = layout('Test email', `<p>If you can read this, email sending from Shani'z is working.</p>`)
  const result = await send({ to, subject: 'Shani\u2019z test email', html })
  return {
    mode: resend ? 'resend' : 'console-only',
    from: FROM,
    ok: resend ? !result.error : false,
    error: result.error ?? null,
    hint: result.hint ?? (resend ? null : 'EMAIL_API_KEY is not set on the server, so emails are only printed in the server log.'),
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// `optOut` = { url, label } adds a "stop these emails" line to the footer.
const layout = (title, bodyHtml, optOut) => `
  <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; color: #2b3a2f;">
    <h2 style="color:#2b3a2f; border-bottom: 2px solid #c9a35c; padding-bottom: 10px;">${title}</h2>
    ${bodyHtml}
    <p style="margin-top: 32px; font-size: 12px; color: #8a8672;">Shani'z Herbal Hair &amp; Skin Care</p>
    ${
      optOut
        ? `<p style="font-size: 12px; color: #8a8672;">Don't want these emails? <a href="${optOut.url}" style="color:#8a8672;">${optOut.label}</a>. You'll still receive order and account emails.</p>`
        : ''
    }
  </div>
`

export async function sendOrderConfirmationEmail(order, toEmail) {
  const provider = await getServiceProvider()
  const rows = order.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0;">${esc(i.name)} × ${i.qty}${
          i.is_preorder
            ? `<br/><span style="font-size:12px; color:#8a6d3b;">Pre-order: estimated arrival ${i.preorder_eta_date}</span>`
            : ''
        }${
          i.booking
            ? `<br/><span style="font-size:12px; color:#5c5949;">${fmtDate(i.booking.date)} at ${String(i.booking.time).slice(0, 5)} · ${esc(providerBranchLabel(provider, i.booking.branch_name))}</span>`
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
      ${pickupBranchHtml(order)}
      <table style="width:100%; border-collapse:collapse; margin: 16px 0;">${rows}${
        Number(order.discount_lkr) > 0
          ? `<tr><td style="padding-top:6px; color:#5c5949;">VIP discount (${Number(order.vip_discount_percent)}%)</td><td style="padding-top:6px; text-align:right; color:#5c5949;">-${fmt(order.discount_lkr)}</td></tr>`
          : ''
      }${
        Number(order.code_discount_lkr) > 0
          ? `<tr><td style="padding-top:6px; color:#5c5949;">Discount code (${esc(order.discount_code)})</td><td style="padding-top:6px; text-align:right; color:#5c5949;">-${fmt(order.code_discount_lkr)}</td></tr>`
          : ''
      }
        <tr><td style="padding-top:10px; font-weight:bold;">Total</td>
            <td style="padding-top:10px; font-weight:bold; text-align:right;">${fmt(order.total_lkr)}</td></tr>
      </table>
      <p>Status: <strong>${order.status}</strong></p>
    `
  )
  return send({ to: toEmail, subject: `Order confirmation: ${order.id.slice(0, 8)}`, html })
}

export async function sendShippingNoticeEmail(order, toEmail) {
  const html = layout(
    'Your Order Has Shipped',
    `<p>Order <strong>${order.id.slice(0, 8)}</strong> is on its way.</p>`
  )
  return send({ to: toEmail, subject: `Your order has shipped: ${order.id.slice(0, 8)}`, html })
}

export async function sendBookingConfirmationEmail(booking, serviceName, toEmail) {
  const provider = await getServiceProvider()
  const html = layout(
    'Booking Confirmed',
    `
      <p>Your appointment is confirmed:</p>
      <p><strong>${esc(serviceName)}</strong><br/>
      <span style="font-size:13px; color:#5c5949;">${esc(providerWording(provider))}</span><br/>
      ${fmtDate(booking.booked_date)} at ${String(booking.booked_time).slice(0, 5)}</p>
      ${
        booking.branch?.name
          ? `<p><strong>Where:</strong> ${esc(providerBranchLabel(provider, booking.branch.name))}${booking.branch.address ? `<br/>${esc(booking.branch.address)}` : ''}${
              booking.branch.phone ? `<br/>${esc(booking.branch.phone)}` : ''
            }</p>`
          : ''
      }
      <p style="font-size:13px; color:#5c5949;">Booking ID: ${booking.id}</p>
    `
  )
  return send({ to: toEmail, subject: `Booking confirmed: ${serviceName}`, html })
}

export async function sendBookingReminderEmail(booking, serviceName, toEmail) {
  const provider = await getServiceProvider()
  const optUrl = unsubscribeUrl(toEmail, 'booking_reminders')
  const html = layout(
    'See You Tomorrow',
    `
      <p>Just a friendly reminder about your appointment tomorrow:</p>
      <p><strong>${esc(serviceName)}</strong><br/>
      <span style="font-size:13px; color:#5c5949;">${esc(providerWording(provider))}</span><br/>
      ${fmtDate(booking.booked_date)} at ${String(booking.booked_time).slice(0, 5)}</p>
      <p style="font-size:13px; color:#5c5949;">Need to reschedule or cancel? Just reply to this email or reach out to us directly.</p>
    `,
    { url: optUrl, label: 'Stop booking reminders' }
  )
  return send({ to: toEmail, subject: `Reminder: ${serviceName} tomorrow`, html, unsubscribe: optUrl })
}

// "You left something in your basket" — sent by src/lib/cartReminders.js.
export async function sendCartReminderEmail(toEmail, firstName, items) {
  const optUrl = unsubscribeUrl(toEmail, 'cart_reminders')
  const rows = items
    .map((i) => `<tr><td style="padding:6px 0;">${esc(i.name)} × ${Number(i.qty) || 1}</td></tr>`)
    .join('')
  const html = layout(
    'You left something in your basket',
    `
      <p>Hi${firstName ? ` ${esc(firstName)}` : ''}, your basket is still waiting for you:</p>
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
      <p style="margin-top:20px;"><a href="${process.env.FRONTEND_ORIGIN}/basket" style="background:#2b3a2f; color:#fff; padding:10px 22px; border-radius:20px; text-decoration:none;">Return to your basket</a></p>
      <p style="font-size:13px; color:#5c5949;">Prices and availability are checked again at checkout.</p>
    `,
    { url: optUrl, label: 'Stop basket reminders' }
  )
  return send({ to: toEmail, subject: 'Your Shani\u2019z basket is waiting', html, unsubscribe: optUrl })
}

// "Still thinking about these?" — sent by src/lib/wishlistReminders.js.
// `items` = [{ type, id, name, price }]; at most 5 are listed.
export async function sendWishlistReminderEmail(toEmail, firstName, items, moreCount = 0) {
  const optUrl = unsubscribeUrl(toEmail, 'wishlist_reminders')
  const rows = items
    .map(
      (i) =>
        `<tr><td style="padding:8px 0;"><a href="${process.env.FRONTEND_ORIGIN}/${i.type === 'service' ? 'service' : 'product'}/${i.id}" style="color:#2b3a2f;">${esc(i.name)}</a></td><td style="padding:8px 0; text-align:right;">${fmt(i.price)}</td></tr>`
    )
    .join('')
  const html = layout(
    'Still thinking about these?',
    `
      <p>Hi${firstName ? ` ${esc(firstName)}` : ''}, a few things you saved to your wishlist are still available:</p>
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
      ${moreCount > 0 ? `<p style="font-size:13px; color:#5c5949;">…and ${moreCount} more on your wishlist.</p>` : ''}
      <p style="margin-top:20px;"><a href="${process.env.FRONTEND_ORIGIN}/wishlist" style="background:#2b3a2f; color:#fff; padding:10px 22px; border-radius:20px; text-decoration:none;">View your wishlist</a></p>
      <p style="font-size:13px; color:#5c5949;">Prices and availability are checked again at checkout. This is a one-time reminder.</p>
    `,
    { url: optUrl, label: 'Stop wishlist reminders' }
  )
  return send({ to: toEmail, subject: 'Your Shani\u2019z wishlist', html, unsubscribe: optUrl })
}

// Unlike sendCartReminderEmail (basket never made it to checkout), this
// is for someone who filled in the whole checkout form — address,
// delivery method, payment gateway chosen — and the order exists, but
// no payment webhook ever confirmed it. Covers guest checkouts too,
// since customer_email is captured on every order regardless of
// whether the customer has an account.
export async function sendCheckoutReminderEmail(order, toEmail, firstName) {
  const optUrl = unsubscribeUrl(toEmail, 'checkout_reminders')
  const items = Array.isArray(order.items) ? order.items : []
  const rows = items
    .map((i) => `<tr><td style="padding:6px 0;">${esc(i.name)} × ${Number(i.qty) || 1}</td></tr>`)
    .join('')
  const html = layout(
    'Finish your order?',
    `
      <p>Hi${firstName ? ` ${esc(firstName)}` : ''}, you started an order with us but the payment was never completed:</p>
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
      <p style="margin-top:20px;"><a href="${process.env.FRONTEND_ORIGIN}/payment/${order.id}" style="background:#2b3a2f; color:#fff; padding:10px 22px; border-radius:20px; text-decoration:none;">Complete payment</a></p>
      <p style="font-size:13px; color:#5c5949;">Prices, stock and any preorder dates are checked again when you complete payment. If you no longer want this order, you can simply ignore this email — nothing has been charged.</p>
    `,
    { url: optUrl, label: 'Stop checkout reminders' }
  )
  return send({ to: toEmail, subject: 'Finish your Shani\u2019z order?', html, unsubscribe: optUrl })
}

export async function sendBookingUpdateEmail(booking, serviceName, toEmail) {
  const statusText =
    booking.status === 'cancelled'
      ? 'has been cancelled'
      : `is now scheduled for ${fmtDate(booking.booked_date)} at ${booking.booked_time}`
  const html = layout('Booking Update', `<p><strong>${esc(serviceName)}</strong> ${statusText}.</p>`)
  return send({ to: toEmail, subject: `Booking update: ${serviceName}`, html })
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
    .map((f) => `<li><strong>${esc(f.severity.toUpperCase())}</strong> — ${esc(f.message)}</li>`)
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
      <p><strong>${esc(actorName)}</strong> just created a new ${newAdmin.role} account:</p>
      <ul>
        <li>Name: ${esc(newAdmin.name)}</li>
        <li>Email: ${esc(newAdmin.email)}</li>
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
      <p><strong>${esc(product.name)}</strong> just dropped to <strong>${product.newQty}</strong> in stock — at or below its low-stock threshold of ${product.threshold}.</p>
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
//
// englishTranslation (optional): when the visitor had the site set to
// Sinhala or Tamil, site.routes.js attempts an AI translation of their
// message before calling this — shown here as a clearly-labeled
// addition above the original, never replacing it, so nothing is lost
// if the translation is imperfect.
export async function sendContactMessageEmail({ name, email, message }, toEmail, englishTranslation) {
  const html = layout(
    'New Contact Form Message',
    `
      <p><strong>From:</strong> ${esc(name)} (${esc(email)})</p>
      ${
        englishTranslation
          ? `<p style="background:#f6f1e4; border-left:3px solid #b8934a; padding:10px 14px; margin:14px 0;">
               <strong>English translation:</strong><br/>
               <span style="white-space: pre-wrap;">${esc(englishTranslation)}</span>
             </p>
             <p style="font-size:12px; color:#8a8672; margin-bottom:4px;">Original message:</p>`
          : ''
      }
      <p style="white-space: pre-wrap;">${esc(message)}</p>
    `
  )
  return send({ to: toEmail, subject: `Website message from ${name}`, html })
}

export async function sendInvoiceEmail(order, toEmail, pdfUrl) {
  const html = layout(
    'Your Invoice',
    `<p>Your invoice for order <strong>${order.id.slice(0, 8)}</strong> is ready.</p>
     ${pickupBranchHtml(order)}
     ${pdfUrl ? `<p><a href="${pdfUrl}" style="color:#2b3a2f;">Download invoice (PDF)</a></p>` : ''}`
  )
  return send({ to: toEmail, subject: `Invoice: ${order.id.slice(0, 8)}`, html })
}

// Order cancellation/return requests — a customer's request never
// changes the order's status by itself (see the eligibility + creation
// logic in orders.routes.js); an admin approving or rejecting it is
// what actually does that. These two emails cover the two ends of that
// flow: telling the admin a request needs review, and telling the
// customer what was decided.
export async function sendRefundRequestReceivedEmail(order, request, toEmail) {
  const html = layout(
    request.type === 'cancellation' ? 'Cancellation Requested' : 'Return Requested',
    `
      <p>Order <strong>${order.id.slice(0, 8)}</strong> (Rs. ${Number(order.total_lkr).toLocaleString()}) — a customer
      has requested a ${request.type === 'cancellation' ? 'cancellation' : 'return/refund'}.</p>
      <p style="font-size:13px; color:#5c5949;"><strong>Their reason:</strong> ${esc(request.reason)}</p>
      <p style="font-size:13px; color:#5c5949;">Review it from Admin → Refund Requests.</p>
    `
  )
  return send({ to: toEmail, subject: `${request.type === 'cancellation' ? 'Cancellation' : 'Return'} requested — ${order.id.slice(0, 8)}`, html })
}

export async function sendRefundRequestResolvedEmail(order, request, toEmail) {
  const approved = request.status === 'approved'
  const html = layout(
    approved ? 'Your Request Was Approved' : 'Update On Your Request',
    `
      <p>Your ${request.type === 'cancellation' ? 'cancellation' : 'return/refund'} request for order
      <strong>${order.id.slice(0, 8)}</strong> has been ${approved ? 'approved' : 'declined'}.</p>
      ${
        approved && request.type !== 'cancellation'
          ? `<p>Rs. ${Number(order.total_lkr).toLocaleString()} will be refunded to your original payment method.</p>`
          : ''
      }
      ${request.admin_note ? `<p style="font-size:13px; color:#5c5949;"><strong>Note from us:</strong> ${esc(request.admin_note)}</p>` : ''}
    `
  )
  return send({ to: toEmail, subject: `${approved ? 'Approved' : 'Update'}: your request for order ${order.id.slice(0, 8)}`, html })
}
