-- ── TENDER LOGIX v2 SCHEMA — separated tender entity + independent products ──
-- Replaces the tier-ladder model on tl_submissions with two cleaner concepts:
--   tl_tenders       — the uploaded document set, its own entity (R20/doc)
--   tl_product_runs  — one row per product execution (gonogo/pricing/bidpack)
--                      against a tender. A single tender can have multiple
--                      product runs, all independent of each other.

CREATE TABLE IF NOT EXISTS tl_tenders (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  tender_ref TEXT,           -- client-provided OR Claude-extracted on first product run
  tender_title TEXT,         -- Claude-extracted on first product run
  doc_r2_keys TEXT NOT NULL, -- JSON array of R2 keys, one per uploaded PDF
  document_count INTEGER NOT NULL DEFAULT 1,
  amount_paid INTEGER NOT NULL DEFAULT 0, -- R20 × document_count, charged on upload
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES tl_companies(id)
);

CREATE TABLE IF NOT EXISTS tl_product_runs (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL,
  company_id TEXT NOT NULL,  -- denormalised for easier per-company queries
  product TEXT NOT NULL,     -- 'gonogo' | 'pricing' | 'bidpack'
  status TEXT NOT NULL DEFAULT 'queued', -- queued | processing | complete | failed
  is_free_trial INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  verdict TEXT,               -- only ever set by a 'gonogo' run; null for pricing/bidpack
  report_r2_key TEXT,
  report_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tender_id) REFERENCES tl_tenders(id),
  FOREIGN KEY (company_id) REFERENCES tl_companies(id)
);

-- Per-company, per-product-type free trial tracking. One row inserted the
-- moment a free trial is consumed for that product type — absence of a row
-- means the free trial is still available.
CREATE TABLE IF NOT EXISTS tl_free_trials_used (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  product TEXT NOT NULL,     -- 'upload' | 'gonogo' | 'pricing' | 'bidpack'
  used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  product_run_id TEXT,       -- which run consumed it, for audit trail
  FOREIGN KEY (company_id) REFERENCES tl_companies(id),
  UNIQUE(company_id, product)
);

CREATE INDEX IF NOT EXISTS idx_product_runs_tender ON tl_product_runs(tender_id);
CREATE INDEX IF NOT EXISTS idx_product_runs_company ON tl_product_runs(company_id);
CREATE INDEX IF NOT EXISTS idx_tenders_company ON tl_tenders(company_id);
CREATE INDEX IF NOT EXISTS idx_free_trials_company ON tl_free_trials_used(company_id);

-- Pricing reference (kept in code as the source of truth, this is just documentation):
--   Upload:   R20 per PDF document — FIRST tender upload free, capped at 5 documents.
--             Beyond 5 docs on that first tender, or any tender after it, full R20/doc applies.
--   Go/No-Go: R100 per run — first run free, lifetime, per company
--   Pricing:  R750 per run — first run free, lifetime, per company
--   Bid Pack: R2,500 per run — first run free, lifetime, per company
-- Each of the four product types (upload/gonogo/pricing/bidpack) gets exactly
-- ONE free use per company, lifetime, tracked independently via
-- tl_free_trials_used. A company could in principle get one tender fully
-- free end-to-end (upload + all 3 products) if they use each free trial on
-- the same tender — this is intentional, the "R3,000 of value, ~R30 real
-- cost" acquisition hook discussed during design.
