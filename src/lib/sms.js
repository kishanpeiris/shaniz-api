// Order/booking confirmation text messages. Uses Twilio's plain REST API
// via fetch (no SDK dependency needed for something this simple). Same
// fallback pattern as src/lib/email.js: if Twilio isn't configured, the
// message is logged to the console instead of sent, so nothing else that
// depends on "a confirmation goes out" breaks while you're still setting
// this up or testing locally.
//
// Twilio was picked as the concrete example because it's the most
// widely-documented option and works worldwide, but any SMS provider
// with an HTTP API (including Sri Lanka-specific gateways like Dialog's
// or Hutch's business SMS APIs) would slot in here the same way — swap
// the fetch call in `sendSms` below for that provider's API and nothing
// else in this file or its callers needs to change.

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER
const smsConfigured = Boolean(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM)

const fmtDate = (d) => {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  return date.toISOString().slice(0, 10)
}

async function sendSms(to, body) {
  if (!to) return { skipped: 'no phone number on file' }

  if (!smsConfigured) {
    console.log(`\n[dev sms — Twilio not configured]\nTo: ${to}\n${body}\n`)
    return { dev: true }
  }

  try {
    const params = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body })
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('SMS send failed:', res.status, text.slice(0, 300))
      return { error: text }
    }
    return await res.json()
  } catch (err) {
    // Never let a failed SMS break the request that triggered it — the
    // order/booking is already saved by the time this runs.
    console.error('SMS send failed:', err.message)
    return { error: err.message }
  }
}

export async function sendOrderConfirmationSms(order, phone) {
  const body = `Shani'z: Thanks for your order! Total LKR ${Number(order.total_lkr).toLocaleString()}. Order #${order.id.slice(0, 8)}. We'll email you when it ships.`
  return sendSms(phone, body)
}

export async function sendBookingConfirmationSms(booking, serviceName, phone) {
  const body = `Shani'z: Your booking for ${serviceName} is confirmed for ${fmtDate(booking.booked_date)} at ${String(booking.booked_time).slice(0, 5)}.`
  return sendSms(phone, body)
}
