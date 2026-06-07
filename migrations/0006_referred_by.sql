ALTER TABLE clients ADD COLUMN referred_by TEXT;
CREATE INDEX IF NOT EXISTS idx_clients_referred_by ON clients(referred_by);
