-- ── TENDER LOGIX — DOCUMENT VAULT SUBSCRIPTION ───────────────────────────
-- R99/month gate on the entire compliance-document feature (upload, verify,
-- store, retrieve, expiry tracking). Free tier still gets fully honest
-- Go/No-Go/Pricing/Bid Pack verdicts using self-reported data — never
-- artificially degraded — but the compliance vault itself, and the real
-- attached-certificate experience in Bid Pack, requires an active
-- subscription. The sell: "your Bid Pack, one click, your real certificates
-- already attached" — proven value at the moment it matters most.

CREATE TABLE IF NOT EXISTS tl_vault_subscriptions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'inactive', -- inactive | active | cancelled | past_due
  price_cents INTEGER NOT NULL DEFAULT 9900, -- R99.00, stored in cents for precision
  current_period_end DATETIME,             -- when current paid period expires
  payfast_token TEXT,                       -- PayFast recurring billing token, once wired
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES tl_companies(id)
);

CREATE INDEX IF NOT EXISTS idx_vault_subs_company ON tl_vault_subscriptions(company_id);
CREATE INDEX IF NOT EXISTS idx_vault_subs_status ON tl_vault_subscriptions(status);
