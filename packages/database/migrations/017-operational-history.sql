-- Legacy dates are approximate: scheduling and expiry were the available dates.
ALTER TABLE sync_jobs ADD COLUMN created_at timestamptz;
UPDATE sync_jobs SET created_at=scheduled_at;
ALTER TABLE sync_jobs ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE photo_import_sessions ADD COLUMN created_at timestamptz;
UPDATE photo_import_sessions SET created_at=expires_at;
ALTER TABLE photo_import_sessions ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN created_at SET DEFAULT now();
CREATE INDEX jobs_history ON sync_jobs(created_at DESC,id DESC);
CREATE INDEX jobs_history_source ON sync_jobs(account_id,created_at DESC,id DESC);
CREATE INDEX jobs_history_status ON sync_jobs(status,created_at DESC,id DESC);
CREATE INDEX imports_history ON photo_import_sessions(created_at DESC,id DESC);
CREATE INDEX imports_history_source ON photo_import_sessions(account_id,created_at DESC,id DESC);
CREATE INDEX imports_history_status ON photo_import_sessions(status,created_at DESC,id DESC);
CREATE FUNCTION preserve_history_created_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'History creation time is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER jobs_created_at_immutable BEFORE UPDATE OF created_at ON sync_jobs FOR EACH ROW EXECUTE FUNCTION preserve_history_created_at();
CREATE TRIGGER imports_created_at_immutable BEFORE UPDATE OF created_at ON photo_import_sessions FOR EACH ROW EXECUTE FUNCTION preserve_history_created_at();
