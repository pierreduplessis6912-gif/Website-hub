-- ═══════════════════════════════════════════════════════════════
-- WEBSITE HUB — D1 INITIAL SCHEMA
-- Migration: 0001_initial_schema.sql
-- Database:  website-hub-db (9c422081-af06-4c1b-b59e-f40e0d08fefa)
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- TABLE 1: clients
-- One row per client. The master record. Everything links back here.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (

  -- Identity
  id                    TEXT PRIMARY KEY,        -- UUID generated at intake
  business_name         TEXT NOT NULL,
  client_name           TEXT,                    -- owner's actual name (used for WhatsApp personalisation)
  slug                  TEXT UNIQUE NOT NULL,    -- URL-safe, generated from business_name
  phone                 TEXT NOT NULL,           -- WhatsApp number, normalised to 27XXXXXXXXX
  email                 TEXT,

  -- Intake form fields
  industry              TEXT NOT NULL,
  area                  TEXT NOT NULL,
  vibe                  TEXT NOT NULL,           -- bold_confident / warm_friendly / premium_minimal / earthy_natural / modern_tech
  services              TEXT,                    -- JSON array of strings
  primary_cta           TEXT,                    -- call_us / whatsapp_us / get_quote / book_online / visit_us
  target_audience       TEXT,                    -- homeowners / businesses / everyone / families
  about                 TEXT,                    -- 200 char max
  differentiator        TEXT,                    -- 150 char max
  testimonial           TEXT,
  instagram             TEXT,
  facebook              TEXT,
  tiktok                TEXT,
  referral_code_used    TEXT,                    -- referral code entered at intake

  -- Lifecycle
  status                TEXT DEFAULT 'lead',
  -- lead / building / preview_ready / qa_ready / live / suspended / cancelled
  qa_status             TEXT DEFAULT 'pending',  -- pending / passed / failed
  source                TEXT DEFAULT 'website',  -- website / whatsapp / outbound / referral
  hosting               TEXT DEFAULT 'hosted',   -- hosted / self_hosted
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Package & billing
  package               TEXT,                    -- express / standard / premium
  retainer              INTEGER,                 -- 699 / 999 / 1499
  go_live_date          DATETIME,
  next_invoice_date     DATETIME,
  monthly_retainer_active INTEGER DEFAULT 0,

  -- Domain & hosting (RegisterDomain.co.za)
  domain                TEXT,                    -- e.g. zululand-flooring.co.za
  domain_status         TEXT DEFAULT 'pending',  -- pending / available / registered / propagating / live
  registerdomain_order_id TEXT,                  -- reference ID from RegisterDomain API
  hosting_status        TEXT DEFAULT 'pending',  -- pending / active
  hosting_provisioned_at DATETIME,
  email_provisioned_at  DATETIME,
  preview_url           TEXT,
  live_url              TEXT,

  -- Auth
  manage_token          TEXT UNIQUE,             -- UUID written at go-live

  -- Communication
  channel               TEXT DEFAULT 'whatsapp', -- whatsapp / email / both
  opted_out             INTEGER DEFAULT 0,       -- boolean
  opted_out_at          DATETIME,
  conversation_state    TEXT,                    -- PROSPECT / PREVIEW_SENT / LIVE (WhatsApp routing)

  -- Referral programme
  referral_slug         TEXT UNIQUE,             -- this client's own referral code
  referral_display_name TEXT,
  referral_conversions  INTEGER DEFAULT 0,
  free_months_earned    INTEGER DEFAULT 0,
  free_months_used      INTEGER DEFAULT 0,

  -- Analytics
  monthly_visits        INTEGER DEFAULT 0,
  monthly_wa_taps       INTEGER DEFAULT 0,
  data_deletion_requested INTEGER DEFAULT 0,

  -- Build
  template_id           TEXT,                    -- express / standard / premium
  palette               TEXT,                    -- bold_confident / warm_friendly / premium_minimal / earthy_natural / modern_tech
  logo_url              TEXT,                    -- R2 URL of uploaded logo
  voice_profile         TEXT,                    -- JSON: Claude's extracted voice profile
  revision_count        INTEGER DEFAULT 0,       -- current month
  revision_reset_date   DATETIME,

  -- Google Business Profile
  gbp_status            TEXT,                    -- pending / created / claimed / verified
  gbp_url               TEXT,

  -- Cancellation
  cancellation_date     DATETIME,
  cancellation_option   TEXT,                    -- archive / file / domain
  cancellation_reason   TEXT,

  -- Zoho Books (invoicing only — email provisioning moved to RegisterDomain)
  zoho_contact_id       TEXT
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 2: messages
-- Every outbound touch. One row per message sent. Never deleted.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL,
  touchpoint  TEXT NOT NULL,
  -- build_complete / go_live / domain_live / email_provisioned / gbp_created /
  -- gallery_added / revision_submitted / revision_complete / paid_revision_link /
  -- d0_dunning / d3_dunning / d7_dunning / d14_dunning /
  -- post_live_d1 / post_live_d7 / post_live_d30 /
  -- monthly_summary / referral_vesting / win_back_d90 / cancellation / reactivation /
  -- prospect_initial / prospect_followup
  channel     TEXT NOT NULL,              -- whatsapp / email
  status      TEXT DEFAULT 'pending',     -- pending / sent / delivered / failed / opted_out
  sent_at     DATETIME,
  delivered_at DATETIME,
  error       TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 3: events
-- Every system operation by every worker. The health check backbone.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT,                       -- nullable: some events are system-wide
  worker      TEXT NOT NULL,              -- build / patch / launch / pulse / reactivate
  event_type  TEXT NOT NULL,
  -- build_started / build_complete / build_failed / build_qa_passed / build_qa_failed /
  -- payment_received / payment_failed / payment_duplicate /
  -- go_live / hostname_bound / email_provisioned / gbp_created /
  -- cron_run / cron_complete / cron_sequence_error /
  -- revision_processed / suspension / reactivation /
  -- domain_registered / hosting_provisioned / opt_out /
  -- outbound_run / prospect_contacted / prospect_converted
  status      TEXT NOT NULL,              -- success / failure / warning
  duration_ms INTEGER,
  error       TEXT,
  metadata    TEXT,                       -- JSON for any extra context
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 4: builds
-- Every build attempt. Full history preserved across rebuilds.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS builds (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id         TEXT NOT NULL,
  template_id       TEXT,                 -- express / standard / premium
  palette           TEXT,
  voice_profile     TEXT,                 -- JSON: Claude's extracted voice profile for this build
  unsplash_queries  TEXT,                 -- JSON array of editorial queries Claude generated
  status            TEXT DEFAULT 'building',
  -- building / complete / failed / qa_passed / qa_failed
  build_time_ms     INTEGER,
  error             TEXT,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 5: revisions
-- Every revision request through its full lifecycle.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revisions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id           TEXT NOT NULL,
  type                TEXT NOT NULL,      -- free / paid
  request             TEXT,              -- what the client asked for
  status              TEXT DEFAULT 'pending',
  -- pending / processing / complete / failed
  payfast_payment_id  TEXT,              -- null if free
  completed_at        DATETIME,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 6: invoices
-- Every invoice ever created. One row per billing event.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id           TEXT NOT NULL,
  zoho_invoice_id     TEXT,              -- reference back to Zoho Books
  payfast_payment_id  TEXT UNIQUE,       -- unique: used for PayFast idempotency lock
  amount              INTEGER NOT NULL,
  type                TEXT NOT NULL,     -- go_live / monthly_retainer / paid_revision / upgrade
  status              TEXT DEFAULT 'pending',
  -- pending / paid / overdue / void
  invoice_date        DATETIME DEFAULT CURRENT_TIMESTAMP,
  due_date            DATETIME,
  paid_at             DATETIME,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 7: prospects
-- Google Places scrape results. Pre-client pipeline.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prospects (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name       TEXT NOT NULL,
  slug                TEXT,
  phone               TEXT,
  industry            TEXT,
  area                TEXT,
  about               TEXT,
  services            TEXT,
  google_place_id     TEXT,
  status              TEXT DEFAULT 'pending',
  -- pending / approved / rejected / built / opted_out / cooldown
  scrape_date         DATE,
  province_scraped    TEXT,
  contacted_at        DATETIME,
  followup_sent_at    DATETIME,
  cooldown_until      DATETIME,
  client_id           TEXT,              -- populated once they convert to a client
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 8: photos
-- The self-building Africa-wide Unsplash image library.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  unsplash_id   TEXT UNIQUE NOT NULL,
  url           TEXT NOT NULL,
  thumb_url     TEXT,
  query_used    TEXT,                    -- the editorial query that found this photo
  industry      TEXT,
  vibe          TEXT,
  slot          TEXT,                    -- hero / gallery / about / services
  usage_count   INTEGER DEFAULT 1,
  market        TEXT DEFAULT 'africa',
  first_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 9: email_accounts
-- One row per provisioned email address. Multiple per client.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT NOT NULL,
  address       TEXT NOT NULL,           -- info@theirdomain.co.za
  status        TEXT DEFAULT 'pending',  -- pending / active / suspended / deleted
  is_primary    INTEGER DEFAULT 0,       -- boolean: first account = 1
  provisioned_at DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 10: gallery_photos
-- Client-uploaded R2 images. Multiple per client.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gallery_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL,
  r2_key      TEXT NOT NULL,             -- path in R2 bucket
  url         TEXT NOT NULL,             -- public CDN URL
  caption     TEXT,
  sort_order  INTEGER DEFAULT 0,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 11: referrals
-- Individual referral relationships. One row per referral event.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_client_id  TEXT NOT NULL,     -- the client who referred
  referred_client_id  TEXT NOT NULL,     -- the client who was referred
  referred_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  vested_at           DATETIME,          -- set when 30-day mark passes
  status              TEXT DEFAULT 'pending',
  -- pending / vested / voided
  credit_amount       INTEGER,           -- retainer amount credited to referrer
  FOREIGN KEY (referrer_client_id) REFERENCES clients(id),
  FOREIGN KEY (referred_client_id) REFERENCES clients(id)
);

-- ─────────────────────────────────────────────────────────────────
-- TABLE 12: visits
-- Daily page-level visit counts. Never expires. Fully queryable.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL,
  date        DATE NOT NULL,
  page        TEXT NOT NULL,             -- index / services / about / contact / gallery
  count       INTEGER DEFAULT 1,
  UNIQUE(client_id, date, page),         -- upsert-safe
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- ─────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_clients_slug         ON clients(slug);
CREATE INDEX IF NOT EXISTS idx_clients_phone        ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_clients_manage_token ON clients(manage_token);
CREATE INDEX IF NOT EXISTS idx_clients_status       ON clients(status);
CREATE INDEX IF NOT EXISTS idx_clients_next_invoice ON clients(next_invoice_date);
CREATE INDEX IF NOT EXISTS idx_clients_domain       ON clients(domain);
CREATE INDEX IF NOT EXISTS idx_clients_go_live_date ON clients(go_live_date);
CREATE INDEX IF NOT EXISTS idx_clients_cancel_date  ON clients(cancellation_date);
CREATE INDEX IF NOT EXISTS idx_messages_client      ON messages(client_id);
CREATE INDEX IF NOT EXISTS idx_messages_touchpoint  ON messages(client_id, touchpoint);
CREATE INDEX IF NOT EXISTS idx_events_client        ON events(client_id);
CREATE INDEX IF NOT EXISTS idx_events_created       ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_type          ON events(event_type, status);
CREATE INDEX IF NOT EXISTS idx_builds_client        ON builds(client_id);
CREATE INDEX IF NOT EXISTS idx_revisions_client     ON revisions(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_client      ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_payfast     ON invoices(payfast_payment_id);
CREATE INDEX IF NOT EXISTS idx_prospects_phone      ON prospects(phone);
CREATE INDEX IF NOT EXISTS idx_prospects_status     ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_photos_industry_vibe ON photos(industry, vibe, slot);
CREATE INDEX IF NOT EXISTS idx_gallery_client       ON gallery_photos(client_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer   ON referrals(referrer_client_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred   ON referrals(referred_client_id, status);
CREATE INDEX IF NOT EXISTS idx_visits_client_date   ON visits(client_id, date);
