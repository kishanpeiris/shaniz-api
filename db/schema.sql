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
  gateway    TEXT NOT NULL CHECK (gateway IN ('koko', 'intpay', 'dialog_genie')),
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

CREATE TABLE IF NOT EXISTS services (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  price_lkr    NUMERIC(12,2) NOT NULL CHECK (price_lkr >= 0),
  service_type TEXT NOT NULL CHECK (service_type IN ('bookable', 'purchasable')),
  duration_minutes INTEGER, -- required for bookable services
  images       TEXT[] DEFAULT '{}',
  hover_video_url TEXT, -- same hover treatment as products: video first
  hover_webp_url  TEXT, -- then animated webp
  hover_gif_url   TEXT, -- then legacy gif, then falls back to images[0]
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  gateway_used   TEXT CHECK (gateway_used IN ('koko', 'intpay', 'dialog_genie')),
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
  delivery_region TEXT CHECK (delivery_region IN ('colombo_main', 'colombo_suburbs', 'outer_suburbs', 'outside_colombo')),
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
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_delivery_region_check CHECK (delivery_region IN ('colombo_main', 'colombo_suburbs', 'outer_suburbs', 'outside_colombo'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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

INSERT INTO site_settings (key, value) VALUES ('business_info', '{
  "phone": "+94 XX XXX XXXX",
  "email": "hello@shaniz.lk",
  "address": "Colombo, Sri Lanka",
  "facebook_url": "https://www.facebook.com/share/r/18w79k89Zo/"
}')
  ON CONFLICT (key) DO NOTHING;

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
