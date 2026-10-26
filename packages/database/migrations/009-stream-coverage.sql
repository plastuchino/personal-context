ALTER TABLE sync_state ADD COLUMN enabled boolean NOT NULL DEFAULT true, ADD COLUMN coverage_gap_at timestamptz;
