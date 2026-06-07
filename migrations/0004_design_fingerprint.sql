-- Add design_fingerprint column to clients table
-- Format: ARCH-TYPO-MOOD-LAYOUT-FLOW e.g. ART-RTW-LIGHT-CIN-STR
ALTER TABLE clients ADD COLUMN design_fingerprint TEXT;
