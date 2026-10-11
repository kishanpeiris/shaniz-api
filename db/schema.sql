-- Shani'z database schema
-- Run with: psql "$DATABASE_URL" -f db/schema.sql
-- Matches the data model in project-spec.md, Section 3.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ---------------------------------------------------------------------
-- Users & auth
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer', 'admin', 'superadmin')),
  is_primary_superadmin BOOLEAN NOT NULL DEFAULT FALSE,
  disabled      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one row may ever have is_primary_superadmin = true, and it can
-- never be deleted (enforced in application code + the trigger below).
CREATE UNIQUE INDEX IF NOT EXISTS one_primary_superadmin
  ON users (is_primary_superadmin) WHERE is_primary_superadmin = TRUE;

-- ---------------------------------------------------------------------
-- Customer registration overhaul: separate first/last name (last_name
-- stays nullable — some people go by one name, "mononym-friendly"),
-- an optional mobile number, and an email-verified flag. `name` (above)
-- is kept as the single combined display name so every existing page
-- that already reads `user.name` keeps working unchanged.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
-- 'en' (English, default), 'si' (Sinhala), or 'ta' (Tamil). Applied on
-- login/register and readable from Account settings; guests (not
-- logged in) get their language choice remembered in the browser only
-- (see LanguageContext.jsx on the frontend).
ALTER TABLE users ADD COLUMN IF NOT EXISTS language_pref TEXT NOT NULL DEFAULT 'en'
  CHECK (language_pref IN ('en', 'si', 'ta'));

-- Defense in depth alongside app-level lowercasing on register/login/
-- forgot-password: guarantees "a@x.com" and "A@X.com" can never both
-- register, even if a future code path forgets to lowercase first.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email));

-- Single-use, time-limited tokens emailed to confirm an address — same
-- pattern as password_reset_tokens below, just for a different purpose.
CREATE TABLE IF NOT EXISTS email_verify_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_verify_tokens_user ON email_verify_tokens (user_id);

-- Emails an admin has blocked from ever registering (spam/abuse). Checked
-- at registration time; rejection message is deliberately vague so it
-- doesn't confirm to the person that they've been specifically blocked.
CREATE TABLE IF NOT EXISTS blacklisted_emails (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL UNIQUE,
  reason     TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_primary_superadmin_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_primary_superadmin THEN
    RAISE EXCEPTION 'The primary super admin account cannot be deleted.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_primary_superadmin_delete ON users;
CREATE TRIGGER trg_prevent_primary_superadmin_delete
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION prevent_primary_superadmin_delete();

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  ip         TEXT,
  success    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts (email, created_at);

-- ---------------------------------------------------------------------
-- Addresses & saved payment methods (tokens only — never raw card data)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS addresses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name  TEXT,
  last_name   TEXT,
  line1       TEXT NOT NULL,
  city        TEXT NOT NULL,
  postal_code TEXT,
  phone       TEXT,
  -- Sri Lanka delivery-fee zone (project-spec.md checkout requirements).
  -- 'colombo_main' | 'colombo_suburbs' | 'outer_suburbs' | 'outside_colombo'
  region      TEXT,
  address_type TEXT NOT NULL DEFAULT 'shipping' CHECK (address_type IN ('shipping', 'billing')),
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive columns for installs where the table already existed before
-- these fields were added — safe to run repeatedly.
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS address_type TEXT NOT NULL DEFAULT 'shipping';
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
DO $$ BEGIN
  ALTER TABLE addresses ADD CONSTRAINT addresses_address_type_check CHECK (address_type IN ('shipping', 'billing'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payment_methods (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gateway    TEXT NOT NULL CHECK (gateway IN ('koko', 'intpay', 'dialog_genie', 'payhere')),
  token      TEXT NOT NULL, -- gateway-issued token, never a raw card number
  brand      TEXT, -- 'visa' | 'mastercard' | null (only meaningful for card gateways)
  last4      TEXT,
  expiry     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS brand TEXT;

-- ---------------------------------------------------------------------
-- Catalog: products & services
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  price_lkr     NUMERIC(12,2) NOT NULL CHECK (price_lkr >= 0),
  stock_qty     INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  category      TEXT,
  images        TEXT[] DEFAULT '{}',
  hover_gif_url TEXT,
  hover_video_url TEXT, -- looping WebM clip, tried first on hover
  hover_webp_url  TEXT, -- animated WebP, tried second (hover_gif_url kept only for older uploads)
  is_active     BOOLEAN NOT NULL DEFAULT TRUE, -- auto-set false when out of stock, or admin can hide manually
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- BUG FIX: the two columns above were only ever inside the CREATE TABLE
-- statement, which is a no-op on any database where `products` already
-- existed (CREATE TABLE IF NOT EXISTS skips the whole statement, columns
-- and all, once the table is present) — so anyone upgrading an existing
-- deployment never actually got these columns even though `db:migrate`
-- reported success. Explicit ALTERs below fix that for existing installs;
-- brand-new installs get them from the CREATE TABLE above either way.
ALTER TABLE products ADD COLUMN IF NOT EXISTS hover_video_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS hover_webp_url TEXT;

-- Per-language content (admin fills these in manually — see the "no
-- auto-translate" decision in SESSION-SUMMARY.md). English stays in the
-- original name/description columns as the base value and fallback;
-- these are purely additive, so a product with nothing typed into them
-- yet still displays perfectly normally in English.
ALTER TABLE products ADD COLUMN IF NOT EXISTS name_si TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS name_ta TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS description_si TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS description_ta TEXT;

-- Admin-manageable categories with optional one-level subcategories
-- (parent_id). Shared table for both products and services, scoped by
-- `kind` — a "Hair Care" product category and a "Hair Care" service
-- category are deliberately separate rows, since what makes sense to
-- group together differs between the two. The old free-text
-- products.category / services.category columns are kept exactly as
-- they were (nothing migrated automatically) — new/edited items get a
-- real category_id, and API responses resolve the display name as
-- COALESCE(categories.name, <legacy text column>) so existing catalog
-- data keeps working without a manual migration step.
CREATE TABLE IF NOT EXISTS categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT NOT NULL CHECK (kind IN ('product', 'service')),
  name       TEXT NOT NULL,
  parent_id  UUID REFERENCES categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_categories_kind ON categories (kind);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories (parent_id);

ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id) ON DELETE SET NULL;

-- Special banners ("100% Natural", "New Arrival", ...) — a free-form
-- list of short labels per product/service rather than a fixed enum, so
-- an admin can type a brand-new one at any time without a code change.
ALTER TABLE products ADD COLUMN IF NOT EXISTS badges TEXT[] DEFAULT '{}';

-- A longer clip for the product/service detail page's media gallery —
-- distinct from hover_video_url (a short muted loop for the Shop grid
-- card). Shown alongside the photos in the gallery with the same
-- prev/next navigation and a maximize/lightbox view.
ALTER TABLE products ADD COLUMN IF NOT EXISTS detail_video_url TEXT;
-- (The matching services.category_id / badges / detail_video_url columns
-- are added further down, right after CREATE TABLE services — adding
-- them here would fail, since the services table doesn't exist yet at
-- this point in the file.)

-- Sold-out vs pre-order (project-spec addendum): admin picks how an
-- out-of-stock product behaves. 'in_stock' is the normal case; the other
-- two only matter once stock_qty hits 0. preorder_eta_days is a rolling
-- duration ("ships in ~N days"), not a fixed date, so it doesn't go
-- stale — the absolute date is only computed and snapshotted once a
-- customer actually places a pre-order (see orders.items below).
ALTER TABLE products ADD COLUMN IF NOT EXISTS availability_mode TEXT NOT NULL DEFAULT 'in_stock'
  CHECK (availability_mode IN ('in_stock', 'out_of_stock', 'preorder'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS preorder_eta_days INTEGER CHECK (preorder_eta_days IS NULL OR preorder_eta_days > 0);
-- No separate "thumbnail" column: the main/cover photo is simply
-- images[0]. Admin's "set as main" action reorders the array rather
-- than pointing an index at it, so it can't go stale if photos are
-- later added, removed, or reordered.

-- ---------------------------------------------------------------------
-- Branches: physical locations bookable services happen at. A service
-- without a branch_id (see below) is treated as location-less (e.g. an
-- at-home service, or simply "not set yet") — the storefront just
-- doesn't show a location/map for it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  address    TEXT NOT NULL,
  latitude   DOUBLE PRECISION,
  longitude  DOUBLE PRECISION,
  phone      TEXT,
  -- The branch pre-selected by default in checkout's pickup picker.
  -- Enforced as "at most one TRUE row" by a partial unique index
  -- (added further down, alongside the other post-hoc ALTERs, since it
  -- also needs to apply to databases that already have this table)
  -- rather than in application code, so it can never drift out of sync
  -- no matter which code path updates it.
  is_main    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Opening hours per branch: {"0": {"open": "10:00", "close": "16:00"}, "1": {...}}
-- where the key is the day of week (0 = Sunday). A day that is missing means
-- CLOSED that day. NULL (never set) means "no restriction" — bookings then
-- follow each service's own weekly windows only, exactly as before.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS opening_hours JSONB;

CREATE TABLE IF NOT EXISTS services (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  name_si      TEXT,
  name_ta      TEXT,
  description_si TEXT,
  description_ta TEXT,
  price_lkr    NUMERIC(12,2) NOT NULL CHECK (price_lkr >= 0),
  service_type TEXT NOT NULL CHECK (service_type IN ('bookable', 'purchasable')),
  duration_minutes INTEGER, -- required for bookable services
  images       TEXT[] DEFAULT '{}',
  hover_video_url TEXT, -- same hover treatment as products: video first
  hover_webp_url  TEXT, -- then animated webp
  hover_gif_url   TEXT, -- then legacy gif, then falls back to images[0]
  branch_id    UUID REFERENCES branches(id) ON DELETE SET NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Kept as explicit ALTERs too, for anyone updating an existing
-- deployment where the services table was created before hover media
-- and branches existed (CREATE TABLE IF NOT EXISTS above is a no-op in
-- that case — see the matching note on the products table above).
ALTER TABLE services ADD COLUMN IF NOT EXISTS hover_video_url TEXT;
-- Same manual per-language columns as products (see the products table
-- below) — added via explicit ALTERs too since services predates this
-- feature on existing deployments.
ALTER TABLE services ADD COLUMN IF NOT EXISTS name_si TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS name_ta TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS description_si TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS description_ta TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS hover_webp_url TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS hover_gif_url TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE SET NULL;
-- Same three additions as products above (categories table already
-- exists by this point in the file, so this is safe here).
ALTER TABLE services ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE services ADD COLUMN IF NOT EXISTS badges TEXT[] DEFAULT '{}';
ALTER TABLE services ADD COLUMN IF NOT EXISTS detail_video_url TEXT;

-- A lightweight, non-destructive answer to "the thumbnail crop is cutting
-- off the wrong part of the photo": rather than force a specific crop at
-- upload time (which would permanently discard part of the original
-- photo), the admin picks a focal point on the *existing* main photo —
-- CSS object-position, applied wherever that photo is shown in a
-- square/cropped box (Shop grid, product detail page). Defaults to dead
-- center (50, 50), which is exactly today's behavior, so nothing changes
-- for a product until someone deliberately adjusts it.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_focal_x REAL NOT NULL DEFAULT 50;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_focal_y REAL NOT NULL DEFAULT 50;
ALTER TABLE services ADD COLUMN IF NOT EXISTS image_focal_x REAL NOT NULL DEFAULT 50;
ALTER TABLE services ADD COLUMN IF NOT EXISTS image_focal_y REAL NOT NULL DEFAULT 50;

-- Per-language descriptions. `description` (no suffix) stays the
-- English/default copy — these are optional overrides for the other
-- two languages. NULL just means "no Sinhala/Tamil version written yet,
-- fall back to English", which the API and storefront both already
-- treat as the normal, expected case for anything not yet translated.
ALTER TABLE products ADD COLUMN IF NOT EXISTS description_si TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS description_ta TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS description_si TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS description_ta TEXT;

CREATE TABLE IF NOT EXISTS service_availability (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
  start_time TIME NOT NULL,
  end_time   TIME NOT NULL,
  CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS service_blackouts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID REFERENCES services(id) ON DELETE CASCADE, -- NULL = applies to all services (e.g. a day off)
  blackout_date DATE NOT NULL,
  reason     TEXT
);

-- ---------------------------------------------------------------------
-- Orders & bookings
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL, -- nullable: guest checkout
  guest_email    TEXT, -- required when user_id IS NULL
  items          JSONB NOT NULL, -- [{ type, id, name, unit_price_lkr, qty }]
  total_lkr      NUMERIC(12,2) NOT NULL CHECK (total_lkr >= 0),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'paid', 'shipped', 'completed', 'cancelled', 'refunded')),
  gateway_used   TEXT CHECK (gateway_used IN ('koko', 'intpay', 'dialog_genie', 'payhere')),
  gateway_txn_id TEXT,
  shipping_address_id UUID REFERENCES addresses(id),
  -- Customer contact + delivery details, captured at checkout for BOTH
  -- guests and logged-in customers (project-spec.md checkout
  -- requirements). Addresses are snapshotted as JSONB on the order
  -- itself (not just a foreign key) so the order's paper trail stays
  -- accurate even if the customer later edits or deletes a saved address.
  customer_first_name TEXT,
  customer_last_name  TEXT,
  customer_phone      TEXT,
  customer_email      TEXT, -- always populated: account email or guest email
  delivery_method TEXT CHECK (delivery_method IN ('pickup', 'delivery')),
  -- No inline CHECK here (unlike delivery_method above) — delivery
  -- zones are admin-editable (Admin → Delivery, added in an earlier
  -- pass), so a hardcoded list of allowed values would silently reject
  -- any zone an admin adds later. isValidRegion() in lib/delivery.js,
  -- checked at order-creation time in orders.routes.js, is what
  -- actually guards this column now.
  delivery_region TEXT,
  -- Which branch a pickup order will be collected from — only ever set
  -- when delivery_method = 'pickup'. ON DELETE SET NULL rather than
  -- blocking branch deletion: an order's own emailed/PDF'd branch
  -- details already captured everything that mattered at the time, so
  -- losing the live link later is a minor cosmetic loss, not a data
  -- integrity problem worth blocking an admin's branch cleanup over.
  pickup_branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  delivery_fee_lkr NUMERIC(12,2) NOT NULL DEFAULT 0,
  shipping_address JSONB, -- snapshot: {first_name,last_name,line1,city,postal_code,phone,region}
  billing_address  JSONB, -- same shape; null/omitted when billing = shipping
  save_card_requested BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR guest_email IS NOT NULL)
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_first_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_last_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_method TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_region TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_branch_id UUID REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee_lkr NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_address JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS save_card_requested BOOLEAN NOT NULL DEFAULT FALSE;
-- Captured at checkout time for the fraud-detection velocity check below
-- (same IP placing many orders quickly). Never shown to the customer.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_ip TEXT;
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_delivery_method_check CHECK (delivery_method IN ('pickup', 'delivery'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- Widening, not narrowing: a database from before delivery zones became
-- admin-editable may still have the old hardcoded 4-value CHECK sitting
-- on this column from when it was first created (that ADD CONSTRAINT
-- always used to silently no-op here via duplicate_object once already
-- present, so it could never widen itself no matter how many times
-- schema.sql re-ran) — drop it unconditionally so isValidRegion()
-- becomes the one and only source of truth for what's allowed, matching
-- a database created fresh today (no CHECK on this column at all).
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_region_check;

-- Same one-main-only rule as the fresh-install CREATE TABLE above,
-- applied to databases that already had a branches table before this
-- pass added is_main.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS is_main BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS branches_one_main_only ON branches (is_main) WHERE is_main = TRUE;

-- Logged-in customers' baskets persist across devices/sessions ("logging
-- in will save their basket"). One row per user; the whole basket is
-- small enough to store as a single JSONB blob rather than a line-items
-- table, and it's disposable (never the source of truth for an order —
-- POST /api/orders re-validates everything from products/services).
CREATE TABLE IF NOT EXISTS saved_carts (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  items      JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Basket-reminder bookkeeping: how many reminder emails have gone out for
-- the current basket, and when the last one was sent. Both reset whenever
-- the customer changes their basket (see PUT /api/account/cart).
ALTER TABLE saved_carts ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
ALTER TABLE saved_carts ADD COLUMN IF NOT EXISTS reminders_sent INTEGER NOT NULL DEFAULT 0;

-- Abandoned-checkout reminders: an order that stays 'pending' (created,
-- but payment never confirmed by a gateway webhook) for a while gets ONE
-- reminder email pointing back to /payment/:orderId. Unlike saved_carts,
-- this covers GUEST checkouts too, since customer_email is captured at
-- order creation for both guest and logged-in orders — see
-- src/lib/checkoutReminders.js.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_reminder_sent_at TIMESTAMPTZ;

-- First-party page-view counter for the admin dashboard (Section 8: "not
-- vanity metrics", but total traffic and top pages are useful alongside
-- the money/order metrics already there, and Google Analytics data isn't
-- something the admin API can query directly without a separate OAuth
-- integration — this is the simple, self-contained alternative). One
-- row per page view, written by POST /api/site/pageview (see
-- site.routes.js), fired from the frontend's router on every navigation.
CREATE TABLE IF NOT EXISTS page_views (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views (created_at);

-- VIP customers: a baseline percentage discount, admin-adjustable per
-- customer, applied automatically at checkout. 0 = not VIP (the normal
-- case for every existing customer — this migration doesn't change
-- anyone's status). A single percent column rather than a separate
-- is_vip boolean: "is this customer VIP" is just "is this > 0", so
-- there's nothing to keep in sync between two fields.
ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0
  CHECK (vip_discount_percent >= 0 AND vip_discount_percent <= 100);

-- Snapshotted onto the order at checkout (not just read live from
-- users.vip_discount_percent) so an order's own record stays accurate
-- even if the customer's discount rate is changed by an admin later —
-- same "snapshot everything real money depended on" approach already
-- used for shipping_address/billing_address on this table.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vip_discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_lkr NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Emails a person has opted out of, by type (e.g. 'cart_reminders').
-- Keyed by email address (not user id) so it also works for guests who
-- click "unsubscribe" in an email, and survives an account being deleted.
-- Order, payment, account-security and booking-confirmation emails are
-- transactional and are NOT covered by this table.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email      TEXT NOT NULL,
  type       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (email, type)
);

CREATE TABLE IF NOT EXISTS bookings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id   UUID NOT NULL REFERENCES services(id),
  order_id     UUID REFERENCES orders(id) ON DELETE SET NULL,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL, -- nullable: guest booking
  guest_name   TEXT, -- collected for guest bookings (mononym-friendly, stored as one field)
  guest_email  TEXT,
  guest_mobile TEXT,
  booked_date  DATE NOT NULL,
  booked_time  TIME NOT NULL,
  status       TEXT NOT NULL DEFAULT 'confirmed'
               CHECK (status IN ('confirmed', 'completed', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Same issue as products/services above: guest_name and guest_mobile
-- were only inside this CREATE TABLE, which is a no-op once `bookings`
-- already exists. Explicit ALTERs so existing deployments actually get
-- them (guest_email already existed before this pair was added, so it
-- doesn't need one).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_name TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_mobile TEXT;
-- Contact numbers: a booking needs at least one of mobile / home phone.
-- Stored for signed-in customers too (their profile may have no number).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_home_phone TEXT;
-- Booking reminder emails (day-before): set TRUE once a reminder has gone
-- out for this booking, so the daily job never double-sends one even if
-- it runs more than once or the booking spans a job restart.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT FALSE;

-- One slot per service can't be double-booked — but a PARTIAL index
-- (WHERE status != 'cancelled') rather than a plain table constraint, so
-- cancelling a booking actually frees the slot back up. A plain UNIQUE
-- constraint here would keep the cancelled row counted forever, silently
-- blocking that exact (service, date, time) from ever being booked again
-- even though the "available slots" endpoint would show it as open —
-- customers would hit a false "already taken" error on a genuinely free
-- slot. Drops the old constraint first in case this runs against a
-- database that was migrated before this fix.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_service_id_booked_date_booked_time_key;
CREATE UNIQUE INDEX IF NOT EXISTS bookings_active_slot_unique
  ON bookings (service_id, booked_date, booked_time)
  WHERE status != 'cancelled';

-- ---------------------------------------------------------------------
-- Product reviews & ratings. Only a customer who actually bought the
-- product (a 'paid'/'shipped'/'completed' order containing this product
-- id) may post one — checked in reviews.routes.js against orders.items
-- the same way UNITS_SOLD_SUBQUERY does in products.routes.js, since
-- there's no separate order_items table. is_verified_purchase is stored
-- on the row (not recomputed on every read) so it stays accurate even
-- if the order is later cancelled/refunded after the review was posted.
CREATE TABLE IF NOT EXISTS reviews (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id           UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id             UUID REFERENCES orders(id) ON DELETE SET NULL,
  rating               INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title                TEXT,
  comment              TEXT,
  is_verified_purchase BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews (product_id);

CREATE TABLE IF NOT EXISTS invoices (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id  UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  pdf_url   TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Logs (audit = 30-day retention, activity = 15-day retention)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at);

CREATE TABLE IF NOT EXISTS activity_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log (created_at);

-- ---------------------------------------------------------------------
-- Fraud detection (rule-based — see src/lib/fraud.js). Every check runs
-- automatically when an order is created; a row here means one rule
-- tripped, not that fraud is confirmed. Admins clear flags manually
-- once reviewed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refund_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type                  TEXT NOT NULL CHECK (type IN ('cancellation', 'return')),
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note            TEXT,
  -- Nullable for guest checkouts — requested_by_email is always set
  -- (for both guests and logged-in customers) so there's always a
  -- contact address for the resolution email regardless of which case
  -- this is, without needing to re-join back to orders/users for it.
  requested_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_by_email    TEXT NOT NULL,
  resolved_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refund_requests_order ON refund_requests (order_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_pending ON refund_requests (status, created_at);
-- Only one open request per order at a time — same partial-unique-index
-- pattern as bookings' "no double-booking a cancelled slot" fix (see
-- SETUP-AND-DEPLOYMENT.md's audit notes): a rejected/approved request
-- doesn't block a future one on the same order, only a still-pending one does.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_requests_one_pending_per_order
  ON refund_requests (order_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS fraud_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  severity    TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  code        TEXT NOT NULL, -- e.g. 'order_velocity', 'disposable_email'
  message     TEXT NOT NULL, -- human-readable, shown directly in the admin panel
  resolved    BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_order ON fraud_flags (order_id);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_unresolved ON fraud_flags (resolved, created_at);

-- ---------------------------------------------------------------------
-- Maintenance mode & outage calendar (Section 10)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outage_windows (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  reason     TEXT,
  status     TEXT NOT NULL DEFAULT 'scheduled'
             CHECK (status IN ('scheduled', 'in_progress', 'completed')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
INSERT INTO site_settings (key, value) VALUES ('maintenance_mode', 'false')
  ON CONFLICT (key) DO NOTHING;

-- Admin on/off switch for the day-before booking reminder email job
-- (src/lib/bookingReminders.js). Defaults to on; an admin can flip it off
-- from Settings without touching code or redeploying.
INSERT INTO site_settings (key, value) VALUES ('booking_reminders', '{"enabled": true}')
  ON CONFLICT (key) DO NOTHING;

INSERT INTO site_settings (key, value) VALUES ('business_info', '{
  "phone": "+94 XX XXX XXXX",
  "email": "hello@shaniz.lk",
  "address": "Colombo, Sri Lanka",
  "facebook_url": "https://www.facebook.com/share/r/18w79k89Zo/"
}')
  ON CONFLICT (key) DO NOTHING;

-- Basic CMS (spec Section 2: "Page customization UI — edit homepage
-- banners/sections without touching code"). Deliberately scoped to the
-- text content of the three main homepage sections (Hero, About, the
-- Ritual/shop intro) rather than a full drag-and-drop layout builder —
-- that would be a much larger, more fragile undertaking for a site this
-- size. Images/hover-media are already editable via the Products/
-- Services admin pages. Seeded with the exact current hardcoded copy,
-- so nothing on the live site changes until an admin actually edits it.
INSERT INTO site_settings (key, value) VALUES ('homepage_content', '{
  "hero_eyebrow": "Small-batch · Sri Lankan grown",
  "hero_headline": "Herbal hair care from Sri Lanka, bottled by hand.",
  "hero_subtext": "Amla, curry leaf, neem and rosemary, blended the way our grandmothers did, for hair that gets the care it deserves.",
  "hero_cta1_label": "Shop Now",
  "hero_cta2_label": "Watch It Being Made",
  "about_eyebrow": "Our story",
  "about_headline": "Rooted in the same soil\nas ayurveda itself.",
  "about_paragraph1": "Shani''z started at a kitchen table, boiling curry leaf and rosemary the way our family had done for three generations. It was a habit of care long before it was a trend. Every batch is still small enough to stir by hand, so the herbs stay whole and the oils stay honest.",
  "about_paragraph2": "We keep ingredient lists short and use the ones that work: amla for strength, neem for the scalp, curry leaf for shine, rosemary for growth. Nothing else goes in the jar.",
  "ritual_eyebrow": "The Ritual",
  "ritual_headline": "Shop what''s in the jar.",
  "ritual_subtext": "Two staples to start with: an oil for the scalp and a mask for the strands. Hover a product to see what''s inside."
}')
  ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- UI translations (buttons, labels, static page copy — NOT product/
-- service content, which lives on those tables directly as _si/_ta
-- columns instead). Admin-editable from Admin -> Translations.
--
-- Seeded from scripts/seed-translations.js, which mirrors (and must be
-- kept in sync with) shaniz-site/src/i18n/translations.js — the two
-- projects are separate deploys, so this is a deliberate one-time copy,
-- not a live link. After the FIRST deploy, this table is the source of
-- truth: re-running the seed script only adds brand-new keys (ON
-- CONFLICT DO NOTHING), it never overwrites an admin's edits.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS translations (
  key        TEXT PRIMARY KEY,
  en         TEXT NOT NULL,
  si         TEXT,
  ta         TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Auto-purge old logs. Requires the `pg_cron` extension (available on
-- Neon/Supabase and most managed Postgres). If pg_cron isn't available,
-- run the two DELETE statements below on a schedule from the app instead
-- (see src/lib/logPurge.js).
-- ---------------------------------------------------------------------
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('purge-audit-log', '0 3 * * *',
--   $$DELETE FROM audit_log WHERE created_at < now() - interval '30 days'$$);
-- SELECT cron.schedule('purge-activity-log', '0 3 * * *',
--   $$DELETE FROM activity_log WHERE created_at < now() - interval '15 days'$$);

-- ---------------------------------------------------------------------
-- Delivery regions & fees (admin-editable). Previously hardcoded in
-- src/lib/delivery.js; moved into the database so admins can add,
-- rename, re-price, or remove delivery zones from the admin panel
-- without a code deploy. Seeded once from the original hardcoded
-- values below — ON CONFLICT DO NOTHING means re-running this file
-- (npm run db:migrate) never overwrites an admin's later edits.
-- `id` is a short slug (e.g. 'colombo_main') because it's stored on
-- each order's delivery_region column as a stable reference — renaming
-- a region's label/fee later never breaks historical orders.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_regions (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  fee_lkr     NUMERIC(10,2) NOT NULL DEFAULT 0,
  example     TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO delivery_regions (id, label, fee_lkr, example, sort_order) VALUES
  ('colombo_main', 'Colombo (Main City — Colombo 1–15)', 350, 'Colombo Fort, Bambalapitiya, Wellawatte, Borella', 1),
  ('colombo_suburbs', 'Colombo Suburbs', 450, 'Dehiwala, Nugegoda, Kotte, Maharagama, Rajagiriya', 2),
  ('outer_suburbs', 'Outer Suburbs', 550, 'Kaduwela, Homagama, Ja-Ela, Wattala, Kesbewa', 3),
  ('outside_colombo', 'Outside Colombo (Island-wide)', 750, 'Kandy, Galle, Jaffna, Negombo, and everywhere else', 4)
ON CONFLICT (id) DO NOTHING;

-- Fills in Sinhala/Tamil for the homepage content above, for anyone
-- upgrading from before per-language homepage content existed. AI-
-- assisted starting translations (same as the admin's own "Auto-
-- translate" button) — worth a native-speaker read-through, same as
-- that button's own on-screen disclaimer says. Merged in with the
-- existing keys taking priority (value on the right of ||), so this
-- is safe to re-run and never overwrites an admin's own edits, even
-- if they've since changed these translations themselves.
UPDATE site_settings
SET value = ('{
  "hero_eyebrow_si": "සුළු තොග වශයෙන් · ශ්‍රී ලාංකික වගාව",
  "hero_eyebrow_ta": "சிறு தொகுதி · இலங்கையில் விளைந்தது",
  "hero_headline_si": "Ceylon හි ශාක චාරිත්‍රය, අතින් බෝතල් කළා.",
  "hero_headline_ta": "Ceylon-இன் மூலிகை சடங்கு, கையால் பாட்டிலிடப்பட்டது.",
  "hero_subtext_si": "නෙල්ලි, කරපිංචා, කොහොඹ සහ රෝස්මරී — අපේ ආච්චිලා කළ ආකාරයටම මිශ්‍ර කර ඇත, රැකවරණය දැනෙන කෙස් සඳහා.",
  "hero_subtext_ta": "நெல்லிக்காய், கறிவேப்பிலை, வேம்பு மற்றும் ரோஸ்மேரி — எங்கள் பாட்டிமார் செய்த முறையிலேயே கலக்கப்பட்டது, கவனிப்பு உணரும் முடிக்காக.",
  "hero_cta1_label_si": "චාරිත්‍රය මිලදී ගන්න",
  "hero_cta1_label_ta": "சடங்கை வாங்குங்கள்",
  "hero_cta2_label_si": "සාදන ආකාරය බලන්න",
  "hero_cta2_label_ta": "இது தயாரிக்கப்படுவதைப் பாருங்கள்",
  "about_eyebrow_si": "අපේ කතාව",
  "about_eyebrow_ta": "எங்கள் கதை",
  "about_headline_si": "ආයුර්වේදයට ම අයත්\nඑම පසෙහිම මුල් හැදුනා.",
  "about_headline_ta": "ஆயுர்வேதம் வேரூன்றிய\nஅதே மண்ணிலேயே நாங்களும் வேரூன்றினோம்.",
  "about_paragraph1_si": "Shani''z ආරම්භ වුණේ කුස්සියේ මේසයක සිටයි, කරපිංචා සහ රෝස්මරී අපේ පවුලේ පරම්පරා තුනක් තිස්සේ පිසින ලද ආකාරයටම තම්බමින් — එය ප්‍රවණතාවක් නොව, රැකවරණයේ පුරුද්දක් ලෙසයි. සෑම තොගයක්ම තවමත් අතින් කැළැඹිය හැකි තරම් කුඩාය, එබැවින් ශාක සම්පූර්ණව සහ තෙල් අවංකව පවතී.",
  "about_paragraph1_ta": "Shani''z ஒரு சமையலறை மேசையில் தொடங்கியது, எங்கள் குடும்பத்தில் மூன்று தலைமுறைகளாகச் செய்யப்பட்ட முறையிலேயே கறிவேப்பிலையையும் ரோஸ்மேரியையும் கொதிக்க வைத்து — இது ஒரு பாணி அல்ல, ஒரு பராமரிப்பு பழக்கம். ஒவ்வொரு தொகுதியும் இன்னும் கையால் கிளற முடிந்தளவு சிறியது, எனவே மூலிகைகள் முழுமையாகவும் எண்ணெய் நேர்மையாகவும் இருக்கும்.",
  "about_paragraph2_si": "අපි දිගු අමුද්‍රව්‍ය ලැයිස්තු පසුපස නොයමු. අපි ක්‍රියා කරන ඒවා පසුපස යමු: ශක්තිය සඳහා නෙල්ලි, හිසකබල සඳහා කොහොඹ, දිලිසීම සඳහා කරපිංචා, වර්ධනය සඳහා රෝස්මරී. බඳුනේ තවත් කිසිවක් තිබිය යුතු නැත.",
  "about_paragraph2_ta": "நாங்கள் நீண்ட பொருட்பட்டியல்களைப் பின்தொடர மாட்டோம். வேலை செய்பவற்றைத்தான் பின்தொடர்கிறோம்: வலிமைக்கு நெல்லிக்காய், தலைமண்டைக்கு வேம்பு, பொலிவுக்கு கறிவேப்பிலை, வளர்ச்சிக்கு ரோஸ்மேரி. ஜாடியில் வேறு எதுவும் தேவையில்லை.",
  "ritual_eyebrow_si": "චාරිත්‍රය",
  "ritual_eyebrow_ta": "சடங்கு",
  "ritual_headline_si": "බඳුනේ ඇති දේ මිලදී ගන්න.",
  "ritual_headline_ta": "ஜாடியில் இருப்பதை வாங்குங்கள்.",
  "ritual_subtext_si": "ආරම්භ කිරීමට මූලික දේවල් දෙකක් — හිසකබල සඳහා තෙලක් සහ කෙස් සඳහා මාස්ක් එකක්. අඩංගු දේ බැලීමට නිෂ්පාදනය මත මූසිකය තබන්න.",
  "ritual_subtext_ta": "தொடங்க இரண்டு அடிப்படைப் பொருட்கள் — தலைமண்டைக்கு ஒரு எண்ணெய், முடிக்கு ஒரு மாஸ்க். உள்ளே என்ன இருக்கிறது என்று பார்க்க பொருளின் மேல் சுட்டியை வையுங்கள்."
}'::jsonb) || value
WHERE key = 'homepage_content';

-- Payment gateway switch: PayHere replaces the earlier Dialog Genie
-- placeholder behind the "Credit / Debit Card" checkout option. Widens
-- (never narrows) the allowed gateway values so this is safe to run
-- against a database that already has real 'dialog_genie' rows sitting
-- in payment_methods/orders from before the switch — those keep
-- meaning exactly what they always meant (a payment actually taken
-- through the old placeholder path), they just can't be created fresh
-- anymore now that checkout only ever sends 'koko'/'intpay'/'payhere'.
DO $$ BEGIN
  ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_gateway_check;
  ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_gateway_check
    CHECK (gateway IN ('koko', 'intpay', 'dialog_genie', 'payhere'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_gateway_used_check;
  ALTER TABLE orders ADD CONSTRAINT orders_gateway_used_check
    CHECK (gateway_used IN ('koko', 'intpay', 'dialog_genie', 'payhere'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- "See It Made" section text (RitualVideo.jsx) was hardcoded in English
-- directly in that component until now — it had no homepage_content
-- fields at all before this pass, English or otherwise, so this both
-- adds the base English text AND its Sinhala/Tamil translations in one
-- go. Same safe merge pattern as the block above: existing keys in
-- `value` always win, so this never overwrites anything an admin has
-- since customized via Settings → Page Content → See It Made.
UPDATE site_settings
SET value = ('{
  "ritual_video_eyebrow": "See it made",
  "ritual_video_eyebrow_si": "සාදන ආකාරය",
  "ritual_video_eyebrow_ta": "தயாரிப்பு முறை",
  "ritual_video_headline": "How each batch is made.",
  "ritual_video_headline_si": "චාරිත්‍රය, ආරම්භයේ සිට අවසානය දක්වා.",
  "ritual_video_headline_ta": "சடங்கு, தொடக்கம் முதல் முடிவு வரை.",
  "ritual_video_subtext": "A short look at how each batch is blended, from fresh leaf to finished bottle.",
  "ritual_video_subtext_si": "සෑම තොගයක්ම මිශ්‍ර කරන ආකාරය පිළිබඳ කෙටි දසුනක් — නැවුම් කොළයේ සිට නිමි බෝතලය දක්වා.",
  "ritual_video_subtext_ta": "ஒவ்வொரு தொகுதியும் எவ்வாறு கலக்கப்படுகிறது என்பதற்கான சுருக்கமான காட்சி — புதிய இலையிலிருந்து முடிக்கப்பட்ட பாட்டில் வரை."
}'::jsonb) || value
WHERE key = 'homepage_content';


-- ======================================================================
-- Discounts, editable ingredients, and services offered at several branches
-- (with pay-upfront bookings). Every statement is safe to re-run.
-- ======================================================================

-- One-time data changes are remembered here so re-running the migration
-- never redoes (or undoes) something an admin has since changed.
CREATE TABLE IF NOT EXISTS schema_seeds (
  name   TEXT PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Discounts (products and services) ----
-- discount_type 'percent' (value 1-95) or 'fixed' (rupees off). Optional
-- start/end dates; blank = always on until removed.
ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_type TEXT CHECK (discount_type IN ('percent', 'fixed'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12, 2) CHECK (discount_value IS NULL OR discount_value > 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_starts_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_ends_at TIMESTAMPTZ;
ALTER TABLE services ADD COLUMN IF NOT EXISTS discount_type TEXT CHECK (discount_type IN ('percent', 'fixed'));
ALTER TABLE services ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12, 2) CHECK (discount_value IS NULL OR discount_value > 0);
ALTER TABLE services ADD COLUMN IF NOT EXISTS discount_starts_at TIMESTAMPTZ;
ALTER TABLE services ADD COLUMN IF NOT EXISTS discount_ends_at TIMESTAMPTZ;

-- ---- "Inside the jar" ingredients, now editable per product ----
ALTER TABLE products ADD COLUMN IF NOT EXISTS ingredients TEXT[] NOT NULL DEFAULT '{}';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_seeds WHERE name = 'prebuilt-product-details-v1') THEN
    -- These two demo products used to have their ingredient list and badge
    -- hard-coded in the website, which made them impossible to edit. Copy
    -- them into the database once, so they can now be changed or removed.
    UPDATE products SET ingredients = ARRAY['Coconut Oil', 'Neem & Dill', 'Curry Leaves', 'Rosemary', 'Natural preservatives'],
                        badges = CASE WHEN COALESCE(array_length(badges, 1), 0) = 0 THEN ARRAY['100% Herbal'] ELSE badges END
      WHERE name = 'Aangraa Hair Oil';
    UPDATE products SET ingredients = ARRAY['Amla', 'Rosemary', 'Curry Leaf', 'Mint & Bay', 'Dried whole herbs'],
                        badges = CASE WHEN COALESCE(array_length(badges, 1), 0) = 0 THEN ARRAY['100% Natural'] ELSE badges END
      WHERE name = 'Premium Herbal Hair Mask';
    INSERT INTO schema_seeds (name) VALUES ('prebuilt-product-details-v1');
  END IF;
END $$;

-- ---- Which branches offer which service ----
CREATE TABLE IF NOT EXISTS service_branches (
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  branch_id  UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, branch_id)
);
CREATE INDEX IF NOT EXISTS idx_service_branches_branch ON service_branches (branch_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_seeds WHERE name = 'service-branches-from-single-branch-v1') THEN
    -- Copy the old "one branch per service" setting across, once.
    INSERT INTO service_branches (service_id, branch_id)
      SELECT id, branch_id FROM services WHERE branch_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    INSERT INTO schema_seeds (name) VALUES ('service-branches-from-single-branch-v1');
  END IF;
END $$;

-- ---- Bookings: which branch, and "held while the customer pays" ----
-- A booking is 'held' (slot reserved) while the customer is in checkout /
-- paying, and becomes 'confirmed' only once payment succeeds. A hold that
-- runs out is cancelled automatically so the slot frees up again.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS held_until TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_token TEXT;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('held', 'confirmed', 'completed', 'cancelled'));
-- The same service can now run at the same time in two different branches,
-- so the "one booking per slot" rule is per service AND branch.
DROP INDEX IF EXISTS bookings_active_slot_unique;
CREATE UNIQUE INDEX IF NOT EXISTS bookings_active_slot_unique_v2
  ON bookings (service_id, (COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)), booked_date, booked_time)
  WHERE status != 'cancelled';
CREATE INDEX IF NOT EXISTS idx_bookings_held ON bookings (held_until) WHERE status = 'held';


-- ======================================================================
-- Service provider (the subsidiary that delivers all services).
-- One row, edited from Admin -> Services. "{name}" inside a wording line
-- is replaced with the name. ON CONFLICT DO NOTHING = re-running the
-- migration never overwrites what an admin has since changed.
-- Branches (above) are the provider's branches: every appointment is
-- shown as "<provider name> - <branch name>".
-- ======================================================================
INSERT INTO site_settings (key, value) VALUES ('service_provider', '{
  "name": "Miracles Hair and Skin Clinic",
  "logo_url": "",
  "wording_en": "Provided by {name}",
  "wording_si": "{name} විසින් සපයනු ලබන සේවාවකි",
  "wording_ta": "{name} வழங்கும் சேவை"
}')
  ON CONFLICT (key) DO NOTHING;

-- ======================================================================
-- Backfill: products from before the categories feature existed (or
-- created by db:seed-catalog, which only ever wrote the old free-text
-- products.category column, never category_id) have a category that
-- displays fine on the product list, but was never a real row in the
-- categories table -- so it never showed up as something selectable
-- in Admin -> Products/Services' category picker or its "Manage
-- categories" list. This looked like previously-saved categories had
-- vanished, when really they had just never been "promoted" into the
-- categories table added later. Runs once (schema_seeds guard, see
-- above): after this, an admin renaming or deleting the resulting
-- category is a normal edit, not something a later db:migrate undoes.
-- Services never had a free-text category column (category_id was the
-- only mechanism from the start), so there is nothing to backfill there.
-- ======================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_seeds WHERE name = 'backfill-legacy-product-categories-v1') THEN
    -- One category row per distinct legacy name still in use by a
    -- product with no category_id yet. NOT EXISTS (rather than a
    -- unique-constraint ON CONFLICT, since categories.name isn't
    -- unique) keeps this re-run-safe on its own even without the
    -- schema_seeds guard above.
    INSERT INTO categories (kind, name)
      SELECT DISTINCT 'product', p.category
      FROM products p
      WHERE p.category_id IS NULL
        AND p.category IS NOT NULL
        AND btrim(p.category) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM categories c WHERE c.kind = 'product' AND c.name = p.category
        );

    -- Point each such product at the (now-existing) matching category.
    UPDATE products p
    SET category_id = c.id
    FROM categories c
    WHERE p.category_id IS NULL
      AND c.kind = 'product'
      AND c.name = p.category;

    INSERT INTO schema_seeds (name) VALUES ('backfill-legacy-product-categories-v1');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Discount codes. A customer types a code at checkout; the server (never
-- the browser) checks it and works out the discount. Stacks with the VIP
-- discount and, like it, never applies to the delivery fee.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discount_codes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code               TEXT NOT NULL CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),
  description        TEXT,
  discount_type      TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value     NUMERIC(12,2) NOT NULL CHECK (discount_value > 0),
  min_subtotal_lkr   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (min_subtotal_lkr >= 0),
  expires_at         TIMESTAMPTZ,            -- NULL = never expires
  max_total_uses     INTEGER CHECK (max_total_uses IS NULL OR max_total_uses > 0),
  one_per_customer   BOOLEAN NOT NULL DEFAULT TRUE,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (discount_type <> 'percent' OR discount_value <= 100)
);
CREATE UNIQUE INDEX IF NOT EXISTS discount_codes_code_unique ON discount_codes (upper(code));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_code_id UUID REFERENCES discount_codes(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS code_discount_lkr NUMERIC(12,2) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS orders_discount_code_idx ON orders (discount_code_id) WHERE discount_code_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Wishlist: one row per saved product/service per customer. Guests keep
-- theirs in their own browser; it is merged in here when they sign in.
-- (No foreign key on item_id because it points at two different tables;
-- the routes only ever return items that still exist and are active.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wishlist_items (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type  TEXT NOT NULL CHECK (item_type IN ('product', 'service')),
  item_id    UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS wishlist_items_item_idx ON wishlist_items (item_type, item_id);

-- Which wishlist items have already been mentioned in a reminder email, so
-- the same item is never emailed about twice.
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
