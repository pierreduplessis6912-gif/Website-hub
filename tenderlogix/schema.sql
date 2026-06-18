-- ── TENDER LOGIX D1 SCHEMA ───────────────────────────────────

-- Company profiles
CREATE TABLE IF NOT EXISTS tl_companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  reg_number TEXT,
  tax_number TEXT,
  vat_number TEXT,
  csd_maaa TEXT,
  bee_level INTEGER,
  bee_certificate_url TEXT,
  cidb_grade TEXT,
  cidb_number TEXT,
  industries TEXT, -- JSON array: ["cleaning","construction","catering"]
  provinces TEXT,  -- JSON array: ["WC","KZN","GP"]
  years_experience INTEGER,
  annual_turnover INTEGER,
  employees INTEGER,
  phone TEXT,
  email TEXT,
  address TEXT,
  banking_details TEXT, -- JSON
  client_name TEXT,
  credits INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Submissions
CREATE TABLE IF NOT EXISTS tl_submissions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  tender_ref TEXT,
  tender_title TEXT,
  department TEXT,
  province TEXT,
  category TEXT,
  doc_r2_key TEXT,        -- R2 key for uploaded PDF
  status TEXT DEFAULT 'pending', -- pending/processing/complete/failed
  verdict TEXT,           -- go/no_go/conditional_go
  report_r2_key TEXT,     -- R2 key for generated report
  report_json TEXT,       -- Full report as JSON
  credits_used INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES tl_companies(id)
);

-- References (for company profiles)
CREATE TABLE IF NOT EXISTS tl_references (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  contact_person TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  contract_value INTEGER,
  start_date TEXT,
  end_date TEXT,
  industry TEXT,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES tl_companies(id)
);

-- Credit transactions
CREATE TABLE IF NOT EXISTS tl_credits (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL, -- purchase/used/refund
  payfast_id TEXT,
  submission_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES tl_companies(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tl_submissions_company ON tl_submissions(company_id);
CREATE INDEX IF NOT EXISTS idx_tl_submissions_status ON tl_submissions(status);
CREATE INDEX IF NOT EXISTS idx_tl_credits_company ON tl_credits(company_id);
