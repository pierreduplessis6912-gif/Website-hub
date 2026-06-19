-- ── COMPLIANCE DOCUMENT SYSTEM ───────────────────────────────────
-- Self-extending reference table of compliance document types, mapped
-- to industries, with per-company verified document tracking.
-- See conversation 2026-06-19 for full design rationale.

-- The canonical list of compliance document TYPES that exist in the system.
-- Grows over time as new industries are encountered — see tl_industry_doc_requirements.
CREATE TABLE IF NOT EXISTS tl_doc_types (
  id TEXT PRIMARY KEY,              -- short slug e.g. 'cidb', 'bee', 'psira', 'bargaining_council'
  name TEXT NOT NULL,               -- display name e.g. 'CIDB Registration'
  description TEXT,                 -- short explainer shown on the dashboard card
  is_universal INTEGER DEFAULT 0,   -- 1 = applies to virtually everyone regardless of industry
  has_expiry INTEGER DEFAULT 1,     -- 0 for binary registered/not-registered types (e.g. CSD)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Which industries typically require which document type — many-to-many.
-- Populated by a one-time Claude suggestion call the first time an industry
-- is encountered with no existing rows, OR manually corrected by admin,
-- OR added by a client flagging a gap (source='user').
CREATE TABLE IF NOT EXISTS tl_industry_doc_requirements (
  id TEXT PRIMARY KEY,
  industry TEXT NOT NULL,           -- matches the industry value from company profile (lowercase, normalised)
  doc_type_id TEXT NOT NULL,
  source TEXT DEFAULT 'claude',     -- 'claude' | 'manual' | 'user'
  confidence TEXT DEFAULT 'medium', -- 'high' | 'medium' | 'low'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (doc_type_id) REFERENCES tl_doc_types(id)
);

-- The actual uploaded/verified documents per company.
CREATE TABLE IF NOT EXISTS tl_compliance_documents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  doc_type_id TEXT NOT NULL,
  r2_key TEXT,                      -- the certificate PDF/photo in R2, tenant-namespaced path
  extracted_value TEXT,             -- e.g. 'Grade 3GB', 'Level 2', 'Active', 'Registered'
  expiry_date DATE,                 -- null if has_expiry=0 on the doc type, or not extractable
  status TEXT DEFAULT 'pending',    -- 'green' | 'amber' | 'red' | 'pending'
  extraction_confidence TEXT,       -- 'high' | 'medium' | 'low' — how confident Claude was reading it
  extraction_notes TEXT,            -- free text — anything Claude flagged while reading (e.g. illegible, mismatched name)
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  verified_at DATETIME,
  FOREIGN KEY (company_id) REFERENCES tl_companies(id),
  FOREIGN KEY (doc_type_id) REFERENCES tl_doc_types(id)
);

CREATE INDEX IF NOT EXISTS idx_compliance_company ON tl_compliance_documents(company_id);
CREATE INDEX IF NOT EXISTS idx_industry_reqs ON tl_industry_doc_requirements(industry);
CREATE INDEX IF NOT EXISTS idx_compliance_doctype ON tl_compliance_documents(doc_type_id);

-- ── SEED: universal document types — apply to virtually all government tendering ──
INSERT OR IGNORE INTO tl_doc_types (id, name, description, is_universal, has_expiry) VALUES
  ('cidb',    'CIDB Registration',              'Construction Industry Development Board grading — required for most construction-related tenders.', 1, 1),
  ('bee',     'B-BBEE Certificate',              'Broad-Based Black Economic Empowerment status — affects preference points scoring under PPPFA.', 1, 1),
  ('tax',     'Tax Clearance / TCS PIN',          'SARS Tax Compliance Status — confirms good standing with tax obligations.', 1, 1),
  ('coida',   'COIDA Letter of Good Standing',    'Compensation for Occupational Injuries and Diseases Act — proof of valid workplace injury cover.', 1, 1),
  ('csd',     'CSD Registration',                 'Central Supplier Database registration — mandatory for bidding on most government tenders.', 1, 0),
  ('pli',     'Public Liability Insurance',        'Minimum cover (commonly R2 million) confirming insurance against third-party claims.', 1, 1);
