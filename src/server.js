import 'dotenv/config'
import express from 'express'
// Registers a patch so async route/middleware handlers that throw or
// reject automatically forward to the error-handling middleware below,
// instead of becoming an unhandled promise rejection. Without this,
// Express 4 does NOT catch errors from `async (req, res) => {...}`
// handlers — and on this Node version, an unhandled rejection crashes
// the entire process, not just the one request. Since every route in
// this API is async (DB calls), this import is load-bearing: it's the
// difference between "one bad request returns a 500" and "one bad
// request takes the whole site down for every user." Must be imported
// before any routes are defined.
import 'express-async-errors'
import cors from 'cors'
import cookieParser from 'cookie-parser'

import { attachUser, requireRole } from './middleware/auth.js'
import { requireCsrfHeader } from './middleware/csrf.js'
import { apiLimiter } from './middleware/rateLimit.js'
import { startLogPurgeJob } from './lib/logPurge.js'

import authRoutes from './routes/auth.routes.js'
import productRoutes from './routes/products.routes.js'
import serviceRoutes from './routes/services.routes.js'
import categoryRoutes from './routes/categories.routes.js'
import branchRoutes from './routes/branches.routes.js'
import bookingRoutes from './routes/bookings.routes.js'
import orderRoutes from './routes/orders.routes.js'
import webhookRoutes from './routes/webhooks.routes.js'
import adminRoutes from './routes/admin.routes.js'
import siteRoutes from './routes/site.routes.js'
import accountRoutes from './routes/account.routes.js'
import uploadRoutes from './routes/uploads.routes.js'
import { localUploadDir, isCloudinaryConfigured } from './lib/uploads.js'

const app = express()

// ---- Security headers (spec Section 7) ----
// A dedicated package like `helmet` is worth adding once you deploy —
// these are the headers it would set, spelled out so nothing is hidden.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
  }
  next()
})

// Webhooks are called by the payment gateways directly (not the browser),
// so they're mounted before the CORS/CSRF middleware that assumes a
// browser client. Body is parsed as a raw Buffer (not JSON) here
// specifically so the HMAC signature check in webhooks.routes.js can
// verify against the exact bytes the gateway signed — re-serializing an
// already-parsed JSON body before hashing it (JSON.stringify(req.body))
// can produce different bytes than the original (key order, spacing,
// number formatting), which would make legitimate signatures fail and,
// worse, is the wrong artifact to be checking in the first place.
app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }), webhookRoutes)

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN,
    credentials: true, // required so the httpOnly session cookie is sent
  })
)
app.use(express.json())
app.use(cookieParser())
app.use(attachUser)
app.use('/api', apiLimiter)
app.use('/api', requireCsrfHeader)

// Local dev fallback for uploaded images when Cloudinary isn't configured
// (see src/lib/uploads.js). In production, set CLOUDINARY_* env vars and
// this directory simply stays empty.
if (!isCloudinaryConfigured) {
  app.use('/uploads', express.static(localUploadDir))
}

app.get('/api/health', (req, res) => res.json({ ok: true }))

app.use('/api/auth', authRoutes)
app.use('/api/products', productRoutes)
app.use('/api/services', serviceRoutes)
app.use('/api/categories', categoryRoutes)
app.use('/api/branches', branchRoutes)
app.use('/api/bookings', bookingRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/site', siteRoutes)
app.use('/api/account', accountRoutes)
app.use('/api/uploads', uploadRoutes)
app.use('/api/admin', requireRole('admin', 'superadmin'), adminRoutes)

// ---- error handler (last) ----
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Something went wrong on our end.' })
})

const port = process.env.PORT || 4000
app.listen(port, () => {
  console.log(`Shani'z API listening on http://localhost:${port}`)
  startLogPurgeJob()
})
