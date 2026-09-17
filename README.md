# Shani'z API

Node/Express + PostgreSQL backend for the Shani'z storefront — this is
**Phases 1–6** of `project-spec.md`: auth, catalog, bookings, orders,
admin, and the security/monitoring requirements from Section 7. It also
includes customer self-service accounts, transactional email, image
uploads, and a payment-gateway abstraction that's ready for real sandbox
credentials the moment you have them — see "What's stubbed" below for the
one remaining piece.

Everything in this project has been tested end-to-end against a real,
locally-running Postgres instance and a real running server (not just
read for correctness): migrations run clean, the primary-superadmin
delete-protection trigger blocks deletion, CSRF/RBAC reject unauthorized
requests, booking slots compute correctly and prevent double-bookings
while correctly freeing a slot back up after a cancellation, order
creation re-checks stock/price server-side, a full guest checkout →
sandbox payment → admin dashboard revenue flow was run start to finish,
and every route was confirmed to survive a malformed request without
crashing the server (see the audit section below for why that needed
fixing).

## Recent audit (security + correctness pass)

This codebase went through a full audit — static analysis, a line-by-line
security review, and real end-to-end testing against a live database and
browser. Everything below was found **and fixed and re-verified**, not
just flagged:

- **Critical — server crash on any bad request.** Every route handler is
  `async`, and Express 4 does not catch promise rejections from async
  handlers on its own. On this stack's Node version, an unhandled
  rejection crashes the *entire process* — meaning something as simple as
  a malformed UUID in a URL could take the whole API down for every user
  simultaneously. Fixed by adding `express-async-errors` (imported first
  in `server.js`, before any routes). Confirmed with an isolated
  before/after test that the process no longer dies.
- **Webhook signature verification used the wrong bytes.** It was
  checking the HMAC signature against `JSON.stringify(req.body)` — a
  re-serialized copy of the already-parsed JSON — instead of the actual
  raw bytes the gateway signed. Key ordering/whitespace differences can
  make a legitimate signature fail to verify. Fixed: webhook bodies are
  now parsed as a raw `Buffer` (`express.raw()` in `server.js`) and the
  signature is checked against that directly.
- **Cancelling a booking permanently blocked that slot from ever being
  rebooked.** The database's uniqueness constraint on bookings didn't
  exclude cancelled ones, so a cancelled booking's row stayed there
  forever, causing the *next* real booking attempt for that exact
  slot to fail with a false "already taken" error — even though the
  availability endpoint correctly showed it as open. Fixed with a partial
  unique index (`WHERE status != 'cancelled'`) in `db/schema.sql`.
  Verified live: cancel → rebook the same slot now succeeds, and a
  genuinely double-booked slot still correctly gets rejected.
- **Blackout dates ("days off") had no way to view or remove them.** The
  backend only had a `POST` to create one — no `GET` to list them, no
  `DELETE` to remove one — even though the project spec requires admins
  to be able to block out days off. Added both endpoints (see Services
  section below); the admin UI in `shaniz-site` was updated to match.

Everything else — auth/session handling, the CSRF approach, rate
limiting, password reset flow, RBAC enforcement, and file upload
validation (MIME check *plus* actual re-encoding, which also catches a
spoofed MIME type) — was reviewed and held up well.

## Setup

**1. Get a Postgres database.** Easiest: a free [Neon](https://neon.tech)
or [Supabase](https://supabase.com) project — copy the connection string
they give you. (Or run Postgres locally if you prefer.)

**2. Configure environment variables.**
```bash
cp .env.example .env
```
Fill in `DATABASE_URL` and generate a `JWT_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Set `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` to whatever you want your
first login to be — pick a real password, not the example one.

Everything else in `.env.example` (Resend, Cloudinary, the three payment
gateways) can stay blank for local development — each one has a working
fallback so the app runs fully without them (see "What's stubbed").

**3. Install dependencies and create the schema.**
```bash
npm install
npm run db:migrate
npm run db:seed-superadmin
npm run db:seed-catalog   # optional demo products/services
```

**4. Run it.**
```bash
npm run dev
```
Listens on `http://localhost:4000` by default. Health check:
`curl http://localhost:4000/api/health`.

## How auth works

- Passwords: bcrypt, cost factor 12.
- Sessions: a JWT in an `httpOnly`, `Secure` (in production), `SameSite=Lax`
  cookie — never in `localStorage`, per the spec's security requirements.
- CSRF: state-changing requests (`POST`/`PUT`/`DELETE`) must include the
  header `X-Requested-With: shaniz-frontend`. The React front-end needs to
  send this on every mutating `fetch()` call — see "Connecting the
  front-end" below.
- RBAC: every admin route checks `req.user.role` server-side
  (`requireRole` middleware) — hiding a button in the UI is never
  the only protection.
- Rate limiting: 5 login attempts / 15 minutes per IP, 3 password-reset
  requests / 15 minutes.
- The primary super admin (seeded once, flagged `is_primary_superadmin`)
  cannot be deleted — enforced by a Postgres trigger *and* the API, so
  it holds even if someone queries the DB directly.

## Customer self-service accounts

`src/routes/account.routes.js` — everything behind this router requires a
logged-in user (customer, admin, or superadmin all have accounts):

- `GET/PUT /api/account/profile` — view/edit name.
- `PUT /api/account/password` — change password (requires current password).
- `GET/POST/PUT/DELETE /api/account/addresses` — saved shipping addresses.
- `GET/DELETE /api/account/payment-methods` — saved card tokens (view/remove
  only — there is deliberately no endpoint that accepts a raw card number;
  tokens are created by a gateway's hosted checkout flow).
- `GET /api/account/bookings` — the signed-in user's bookings.

`GET /api/orders/mine` (pre-existing) covers order history.

## Services: availability windows & blackout dates

`src/routes/services.routes.js` (admin/superadmin only, except the plain
`GET /api/services` list which is public):

- `GET/POST /api/services/:id/availability` — weekly recurring windows
  (e.g. "Mon–Sat, 9am–6pm"). `DELETE /api/services/:id/availability/:windowId`
  removes one.
- `GET/POST /api/services/:id/blackouts` — specific calendar dates the
  service is *not* bookable (holidays, days off), on top of the weekly
  windows above. `DELETE /api/services/:id/blackouts/:blackoutId` removes
  one. The booking-slots endpoint (`GET /api/bookings/services/:id/slots`)
  already excludes both blacked-out dates and already-booked times — this
  was completed during the recent audit (see above); previously there was
  no way to view or remove a blackout once created.

## Transactional email

`src/lib/email.js` uses [Resend](https://resend.com). Set `EMAIL_API_KEY`
and `EMAIL_FROM` to send real emails; leave them blank and every email is
logged to the console instead, so the whole app works end-to-end in dev
without an account. Wired into: order confirmation (on order creation),
shipping notice + invoice (on order status change / payment webhook),
booking confirmation (on booking creation), booking update (on
reschedule/cancel), and password reset (on forgot-password request).

## Image uploads

`POST /api/uploads` (admin/superadmin only, `multipart/form-data`, field
name `file`) — used by the admin panel's product/service photo and
hover-GIF fields. Every upload is re-encoded through `sharp` before
storage (strips anything in the file that isn't actual pixel data;
animated GIFs keep all their frames so hover-loop images still animate).
Max 8MB, JPEG/PNG/WEBP/GIF only.

Set `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`
to store uploads on Cloudinary; leave them blank and uploads save to a
local `uploads/` folder served at `/uploads` instead — fine for dev, but
switch to Cloudinary before deploying (a serverless host's local disk
doesn't persist between deploys).

## Payment gateways

`src/lib/gateways.js` has one function per gateway (Koko, IntPay, Dialog
Genie) that builds a real hosted-checkout request. Until you set that
gateway's `_MERCHANT_ID`/`_API_SECRET` env vars, `createCheckoutSession`
returns a sandbox mock URL instead, so checkout still works end-to-end in
dev. Once you have real sandbox docs from each provider (project-spec.md
Section 4), the request/response shape inside that gateway's function is
the only thing that needs updating — everything downstream (order
creation, the webhook handler, emails) already expects the shape
`createCheckoutSession` returns and doesn't need to change.

## Connecting the front-end (`shaniz-site`)

Already done — the React app's `useCatalog` hook, `CartContext` checkout,
`AccountPage`, and `BookingWidget` all call this API directly
(`credentials: 'include'` plus the `X-Requested-With: shaniz-frontend`
CSRF header on every mutating request). Run `npm run db:seed-catalog`
here so the frontend has real products/services to fetch — see
`shaniz-site/README.md` for how to run both together. `FRONTEND_ORIGIN`
in `.env` already matches Vite's default port (5173), and is also used to
build the link inside password-reset emails.

## What's stubbed (needs your input to finish)

- **Real payment gateway credentials** — the abstraction, webhook
  handling, and emails are all built; you just need each gateway's real
  API docs (after registering as a merchant, project-spec.md Section 4)
  to fill in the three `fetch()` calls in `src/lib/gateways.js`.
- **PDF invoices** — the `invoices` table and an invoice *email* exist,
  but nothing generates an actual PDF file yet; `sendInvoiceEmail` sends a
  text summary and accepts an optional PDF URL once you add that.
- **CMS / page customization** — not built. Everything in Section 2's
  "Page customization UI" is still a future phase.
- **New-admin-account email alert** — the spec's Section 7 monitoring
  alert ("email to super admin ... on new admin account created") isn't
  wired up; the audit log already records the event, this would just add
  an email on top.

## Project structure

```
db/schema.sql          full schema — run via npm run db:migrate
scripts/
  migrate.js            applies db/schema.sql
  seed-superadmin.js    one-time protected super admin creation
  seed-catalog.js       demo products/services for local dev
src/
  db/pool.js            pg connection pool, parameterized queries only
  lib/
    session.js           JWT + httpOnly cookie helpers
    log.js                audit_log / activity_log writers
    logPurge.js           daily cron job purging old log rows
    email.js              Resend integration + console fallback
    uploads.js             image validation/re-encoding + Cloudinary/local storage
    gateways.js            payment gateway checkout-session abstraction
  middleware/
    auth.js               attachUser / requireAuth / requireRole
    csrf.js                custom-header CSRF check
    rateLimit.js           login + password-reset limiters
  routes/
    auth.routes.js         register/login/logout/password reset
    account.routes.js      customer self-service: profile, addresses, payment methods, bookings
    uploads.routes.js      admin image/GIF upload endpoint
    products.routes.js     catalog CRUD + stock adjustment
    services.routes.js     service CRUD + availability windows + blackout dates (days off)
    bookings.routes.js     slot computation, booking, admin calendar
    orders.routes.js       order creation (server-computed totals), admin listing
    webhooks.routes.js     payment gateway callbacks
    admin.routes.js        dashboard, logs, customer/admin management, maintenance mode
    site.routes.js         public maintenance-mode / outage-banner status
  server.js               wires everything together
```

## Going live — step by step

This walks through taking both `shaniz-api` (this repo) and `shaniz-site`
(the frontend) from zero to a live site on your own domain. Do it in this
order — each step depends on the one before it.

### 1. Create the accounts you'll need

You don't need all of these on day one (payments especially can wait —
see project-spec.md Section 4), but it's easier to create them up front:

| Service | For | Free tier? |
|---|---|---|
| [GitHub](https://github.com) | hosting both repos' code | Yes |
| [Neon](https://neon.tech) or [Supabase](https://supabase.com) | production Postgres | Yes |
| [Render](https://render.com) or [Railway](https://railway.app) | hosting this backend | Yes |
| [Vercel](https://vercel.com) | hosting `shaniz-site` (frontend) | Yes |
| [Cloudinary](https://cloudinary.com) | product image storage | Yes |
| [Resend](https://resend.com) | transactional email | Yes (100/day) |
| A domain registrar (Namecheap, GoDaddy, etc.) | your custom domain | — |
| Koko / IntPay / PayHere | payment processing | Merchant sign-up required — see Section 4 of project-spec.md |

### 2. Push both repos to GitHub

```bash
cd shaniz-api
git init && git add . && git commit -m "Initial commit"
git remote add origin https://github.com/<you>/shaniz-api.git
git push -u origin main
```
Repeat for `shaniz-site`. **Double-check `.env` is in `.gitignore` and was
never committed** — `.env.example` (no real values) is fine to commit,
`.env` (your real secrets) is not.

### 3. Create the production database

In Neon or Supabase: create a new project, then copy the connection
string it gives you (starts with `postgresql://...`). Keep this tab open
— you'll paste it into Render/Railway's environment variables next.

### 4. Deploy the backend (this repo)

On Render (Railway is nearly identical):
1. **New → Web Service**, connect your `shaniz-api` GitHub repo.
2. **Root directory**: leave blank (this repo *is* the root).
3. **Build command**: `npm install`
4. **Start command**: `npm start`
5. **Environment variables** — add every one of these (see `.env.example`
   for the full list with comments):
   - `DATABASE_URL` — from Step 3. Add `?sslmode=require` at the end if
     your provider needs it (Neon/Supabase usually include it already).
   - `JWT_SECRET` — generate with
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
     — a real random value, not anything used in local dev or shared in chat.
   - `NODE_ENV=production`
   - `FRONTEND_ORIGIN` — leave as a placeholder for now
     (`https://placeholder.vercel.app`); you'll come back and set this to
     the real frontend URL in Step 7.
   - `SUPERADMIN_NAME`, `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` — your
     first login. Pick a real password.
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
     — from Step 6 below (can add now or come back).
   - `PUBLIC_API_URL` — the backend's own deployed URL (e.g.
     `https://shaniz-api.onrender.com`, or your custom API domain once you
     set one up in Step 8). Only matters if you skip Cloudinary and use
     the local-disk upload fallback — it's what makes those image URLs
     resolve for site visitors instead of just on your own machine.
   - `EMAIL_API_KEY`, `EMAIL_FROM` — from Step 6 below.
   - Payment gateway vars — leave blank until you have sandbox
     credentials (Step 8); the app works fully without them.
6. Deploy. Once it's live, note the URL Render/Railway gives you (e.g.
   `https://shaniz-api.onrender.com`).
7. **Health check**: `curl https://<your-backend-url>/api/health` should
   return `{"ok":true}`.

### 5. Run the production migration and seed the superadmin

These are one-time commands run *against the production database*, not
part of the deploy itself. Easiest way: run them from your own machine
with `DATABASE_URL` temporarily pointed at production:

```bash
DATABASE_URL="<your production connection string>" npm run db:migrate
DATABASE_URL="<your production connection string>" npm run db:seed-superadmin
```

(Most hosts also offer a "Shell" tab in their dashboard where you can run
these directly on the deployed instance instead — either works.) Skip
`db:seed-catalog` in production — that's demo data for local dev only.

**Immediately after this**, log in once with your `SUPERADMIN_EMAIL` /
`SUPERADMIN_PASSWORD` and change the password from Settings → your
account, since it may have been typed into a terminal, `.env` file, or
shared with someone during setup — treat the seeded password as
temporary.

### 6. Set up Cloudinary and Resend

**Cloudinary** (product/service images): create a free account, and from
the dashboard copy your Cloud Name, API Key, and API Secret into the
backend's environment variables (Step 4). Without this, uploaded images
save to local disk — fine for local dev, but **most hosts wipe local disk
on every redeploy**, so do this before you upload real product photos.

**Resend** (emails): create an account, verify a sending domain (or use
their test domain while you're still setting up), generate an API key,
and set `EMAIL_API_KEY` + `EMAIL_FROM` (e.g.
`Shani'z <orders@yourdomain.com>`) in the backend's environment
variables. Without this, every email is just logged to the server
console instead of actually sent — fine for testing, not for launch.

### 7. Deploy the frontend (`shaniz-site`)

On Vercel:
1. **Add New → Project**, import your `shaniz-site` GitHub repo.
2. Framework preset should auto-detect as Vite.
3. **Environment variable**: `VITE_API_URL` = your backend's URL from
   Step 4 (e.g. `https://shaniz-api.onrender.com`).
4. Deploy. Note the URL Vercel gives you (e.g.
   `https://shaniz-site.vercel.app`).
5. **Go back to the backend's environment variables** (Step 4) and update
   `FRONTEND_ORIGIN` to this real Vercel URL, then redeploy the backend
   (or trigger the restart your host uses to pick up new env vars) — this
   is what allows the frontend's requests through CORS.

At this point, visit your Vercel URL — the site should be fully
functional on Vercel's free subdomain, including checkout (sandbox mode),
bookings, and the admin panel.

### 8. Point your custom domain at it

1. In Vercel: **Project → Settings → Domains**, add your domain (e.g.
   `shaniz.lk`). Vercel gives you DNS records to add.
2. At your domain registrar: add those records (usually an `A` record for
   the root domain and a `CNAME` for `www`).
3. Once DNS propagates (can take a few minutes to a few hours), your
   custom domain serves the frontend.
4. **Update the backend's `FRONTEND_ORIGIN`** to your real domain (e.g.
   `https://shaniz.lk`) and redeploy the backend again.
5. Optional but recommended: put the backend on a subdomain of the same
   domain too (e.g. `api.shaniz.lk`, configured in Render/Railway's domain
   settings) instead of the host's default subdomain — tidier, and some
   payment gateways prefer webhook URLs on your own domain.

### 9. Payment gateways (Koko / IntPay / PayHere)

Per project-spec.md Section 4: register as a merchant with each gateway
you want to support, complete their KYC/verification, and they'll give
you sandbox credentials first. Add those to the backend's environment
variables (`KOKO_MERCHANT_ID`/`KOKO_API_SECRET`, etc. — see
`.env.example`). The three `fetch()` calls in `src/lib/gateways.js` are
written and ready, but each one has a placeholder request/response shape
since every gateway's real API differs — update those to match once you
have each gateway's actual API docs. Test a full purchase in sandbox mode
end to end before ever touching live credentials. When you do go live,
put the live credentials in the same environment variables (never in
code, never committed) and do one real, small, refundable test purchase
before announcing launch.

### 10. Final go-live checklist

- [ ] Superadmin password changed from the one used during setup (Step 5)
- [ ] `NODE_ENV=production` set on the backend
- [ ] `FRONTEND_ORIGIN` on the backend matches your real, final domain
      (not a Vercel preview URL or localhost)
- [ ] Cloudinary configured (Step 6) — don't launch on local-disk uploads
- [ ] Resend configured (Step 6) — don't launch with emails only going to
      the console
- [ ] At least one full test purchase completed in sandbox mode
- [ ] Database backups enabled — Neon and Supabase both offer automatic
      daily backups on their dashboard; turn this on
- [ ] HTTPS working on both the frontend and backend domains (Vercel and
      Render/Railway both provision this automatically once DNS is
      pointed correctly)
- [ ] Run `npm audit` in both repos and address anything high/critical
      before launch, and periodically after

### Ongoing: pushing updates after launch

Per project-spec.md Section 11 — for small fixes and content changes,
just push to GitHub; both hosts auto-deploy and only switch traffic once
the new build passes, so a broken deploy never goes live. For database
schema changes or anything that could break checkout mid-transaction,
turn on **Maintenance Mode** first (`PUT /api/admin/maintenance-mode`,
or the toggle in the admin panel's Maintenance page), deploy, confirm it
works, then turn it back off.

