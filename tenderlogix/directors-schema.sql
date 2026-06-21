-- ── TENDER LOGIX — DIRECTORS & ADDRESS FIELDS ────────────────────────────
-- Closes the real gap identified during bidpack form-filling testing:
-- MBD 4, MBD 15, and MBD 7.2 all require director/shareholder names, ID
-- numbers, and physical/postal addresses — none of which existed anywhere
-- in the system. Without this, those forms stay mostly "(TO COMPLETE)"
-- regardless of how good the form templates themselves are.

-- Address + a few missing single-value fields, added directly to tl_companies
ALTER TABLE tl_companies ADD COLUMN street_address TEXT;
ALTER TABLE tl_companies ADD COLUMN postal_address TEXT;
ALTER TABLE tl_companies ADD COLUMN city TEXT;
ALTER TABLE tl_companies ADD COLUMN postal_code TEXT;
ALTER TABLE tl_companies ADD COLUMN tax_reference_number TEXT;
ALTER TABLE tl_companies ADD COLUMN vat_number TEXT;
ALTER TABLE tl_companies ADD COLUMN municipal_account_number TEXT;

-- Directors are a real one-to-many relationship — a company can have
-- multiple directors/shareholders/members, each needing their own row on
-- MBD 4 (paragraph 4 table) and MBD 15 (director details table).
CREATE TABLE IF NOT EXISTS tl_company_directors (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  id_number TEXT,
  tax_number TEXT,
  residential_address TEXT,
  is_state_employee INTEGER DEFAULT 0,
  display_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES tl_companies(id)
);

CREATE INDEX IF NOT EXISTS idx_directors_company ON tl_company_directors(company_id);
