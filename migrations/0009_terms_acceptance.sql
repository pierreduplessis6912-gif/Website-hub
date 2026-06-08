-- Terms acceptance tracking
ALTER TABLE clients ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE clients ADD COLUMN terms_accepted_ip TEXT;
