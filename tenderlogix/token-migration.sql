-- Add token tracking columns to tl_product_runs
ALTER TABLE tl_product_runs ADD COLUMN input_tokens INTEGER DEFAULT 0;
ALTER TABLE tl_product_runs ADD COLUMN output_tokens INTEGER DEFAULT 0;
ALTER TABLE tl_product_runs ADD COLUMN estimated_cost_usd REAL DEFAULT 0;
ALTER TABLE tl_product_runs ADD COLUMN pdf_total_bytes INTEGER DEFAULT 0;
ALTER TABLE tl_product_runs ADD COLUMN pdf_estimated_tokens INTEGER DEFAULT 0;
