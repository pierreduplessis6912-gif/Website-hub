-- ═══════════════════════════════════════════════════════════════
-- WEBSITE HUB — MIGRATION 0002
-- Adds: config table, referral_credits table
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- TABLE: config
-- System configuration. Single source of truth for all settings.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  description  TEXT,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by   TEXT DEFAULT 'admin'
);

-- Default config values
INSERT OR IGNORE INTO config (key, value, description) VALUES
  ('outbound_enabled',    'false',  'Master outbound switch'),
  ('daily_scrape_limit',  '20',     'Max prospects scraped per cron run'),
  ('daily_send_limit',    '10',     'Max WhatsApps sent per day'),
  ('send_window_start',   '09:00',  'Earliest send time SAST'),
  ('send_window_end',     '17:00',  'Latest send time SAST'),
  ('outbound_mode',       'manual', 'manual = you approve | auto = fire and forget'),
  ('target_provinces',    '["KZN","GP","WC"]', 'Active scrape provinces'),
  ('target_industries',   '["plumber","electrician","builder","painter","salon","barber","nails","restaurant","cleaning","landscaping","mechanic"]', 'Active scrape industries');

-- ─────────────────────────────────────────────────────────────────
-- TABLE: referral_credits
-- Vested promo codes from the referral programme.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_credits (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,           -- the referrer who earned this
  referral_id     INTEGER,                 -- links to referrals table
  promo_code      TEXT UNIQUE NOT NULL,    -- e.g. REF-JIMMY-A3K9
  credit_amount   INTEGER NOT NULL,        -- rand value (their retainer)
  status          TEXT DEFAULT 'vested',   -- vested / redeemed / expired
  vested_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  used_at         DATETIME,
  expires_at      DATETIME,                -- 90 days after vesting
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE INDEX IF NOT EXISTS idx_config_key           ON config(key);
CREATE INDEX IF NOT EXISTS idx_ref_credits_client   ON referral_credits(client_id);
CREATE INDEX IF NOT EXISTS idx_ref_credits_code     ON referral_credits(promo_code);
CREATE INDEX IF NOT EXISTS idx_ref_credits_status   ON referral_credits(status);

-- Also add missing columns to invoices table
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS slug           TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_num    TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS description    TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS credit_applied INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS promo_code_used TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payfast_id     TEXT;

-- Add payfast_payment_id column to clients if missing
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'payfast';
