ALTER TABLE classification_runs ADD COLUMN started_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX classification_latest_run ON classification_runs(record_id,revision_id,context_version,started_at DESC);
