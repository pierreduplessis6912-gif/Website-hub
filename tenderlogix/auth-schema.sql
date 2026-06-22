-- ── TENDERLOGIX AUTH SCHEMA ──────────────────────────────────────────────
-- OTP-based auth via WhatsApp. Customer initiates by sending "LOGIN" to
-- the TenderLogix WhatsApp number. System replies with a 6-digit OTP.
-- Customer enters OTP on the login page. Session token created on success.

-- One-time passwords — short TTL (5 minutes), single use
CREATE TABLE IF NOT EXISTS tl_otp (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  otp_hash TEXT NOT NULL,          -- bcrypt-style: SHA256(otp + salt)
  salt TEXT NOT NULL,
  expires_at DATETIME NOT NULL,    -- 5 minutes from creation
  used INTEGER NOT NULL DEFAULT 0, -- 1 once consumed
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES tl_companies(id)
);

-- Active sessions — 30 day TTL, refreshed on activity
CREATE TABLE IF NOT EXISTS tl_sessions (
  id TEXT PRIMARY KEY,             -- session token (UUID v4, sent as cookie)
  company_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  expires_at DATETIME NOT NULL,    -- 30 days from creation/last refresh
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES tl_companies(id)
);

-- Rate limiting for OTP requests — max 3 per phone per hour
CREATE TABLE IF NOT EXISTS tl_otp_rate (
  phone TEXT NOT NULL,
  window_start DATETIME NOT NULL,  -- start of current 1-hour window
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (phone, window_start)
);

CREATE INDEX IF NOT EXISTS idx_otp_phone ON tl_otp(phone);
CREATE INDEX IF NOT EXISTS idx_otp_expires ON tl_otp(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_company ON tl_sessions(company_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON tl_sessions(expires_at);
