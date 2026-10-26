-- Overview performs one latest-ingestion-job lookup per enabled stream.
-- Account-only history indexes scan unrelated streams during large backfills.
CREATE INDEX IF NOT EXISTS jobs_stream_latest_ingest
 ON sync_jobs(account_id,stream_key,created_at DESC,id DESC)
 WHERE stage='ingest';
