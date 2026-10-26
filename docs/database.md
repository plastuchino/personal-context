# Database and queue operations

Run `npm run db:up`, `npm run db:migrate`, and `npm run db:check` from the repository root after copying `.env.example` to `.env`. PostgreSQL 17 and pgvector run through Compose on loopback port 55439 with a persistent named volume. Use `npm run db:stop` to stop without deleting data. The bundled password is for local development only.

Migrations are ordered SQL files under `packages/database/migrations`. The runner records applied names in `schema_migrations`, serializes runners with an advisory lock, and commits each migration atomically. Re-running applies only missing files. Applied SQL files must not be edited for deployed databases; add a migration instead. Source revisions reject updates and deletes to protect citations. Destructive schema rollback is not an automatic recovery mechanism.

Canonical identities are unique within account/kind/provider ID. Ingestion preserves stable record IDs and creates a new immutable revision only when normalized content or provenance changes. JSON object key order does not cause false revisions. Revision metadata stores historical source links and timestamps; missing values remain null. Observed deletions tombstone canonical records. No retrieval implementation should treat a tombstoned item as current content.

Composite foreign keys prevent cross-account participants, conversations, financial account links, and task evidence. Financial amounts use numeric, not floating point. Calendar all-day dates use date columns, not fabricated midnight instants. Media bytes remain in PostgreSQL and are checked against the declared size. Embedding dimensions must match the registered model. Model-specific vector indexes are created when the search implementation pins a model.

## Coverage and freshness

A stream tracks initial coverage bounds and completeness separately from its cursor. `last_attempt_at` is a check attempt; `last_success_at` records completion of a sync; `source_watermark_at` describes provider data advancement. An empty successful poll must not imply newer bank data. Providers can have retention, access, or refresh limits. Photos enters via owner-selected import jobs and is excluded from periodic source checks.

## Queue recovery

`schedule` creates deduplicated ingestion jobs for enabled due streams and advances the due time by 15 minutes. `claim` leases a job while serializing claims by stream; only one running job can own a stream. Workers must renew leases with `heartbeat` during long calls. A claim returns a unique lease token. `commitPage` rejects stale tokens and commits records, downstream classification/embedding jobs, and the page cursor together. A final page completes the job and successful-sync timestamp.

Expired leases are reclaimed with a new token. Bounded attempts become failed jobs when exhausted. `failJob` accepts only a redacted error code and observes the larger of backoff or provider retry delay. Do not pass raw provider bodies into errors. Owner retries must use `retryJob`, which refuses to duplicate active stream work. Cursor reset logic belongs to connectors; do not clear records when an incomplete provider listing fails.

## Verification

`npm test` runs unit checks; database tests explicitly skip without `TEST_DATABASE_URL`. `npm run test:db:isolated` creates a uniquely named temporary database on the configured local server, migrates it, runs integration tests, and drops only that database. It requires CREATE DATABASE privileges. This verifies clean migrations without deleting or truncating personal records. API and worker startup validate configuration before doing any work.

## Scheduled ingestion worker

`npm run dev:worker` runs the four scheduled connector types. Configure the credential encryption key first; provider secrets remain server-only settings. Google/Slack credentials refresh under an account lock. Financial Items carry an explicit provider environment; the worker rejects mismatches rather than sending Sandbox tokens to Production.

Discovery creates independent channel/calendar streams. Disabled streams are excluded from scheduling. Google cursor resets record a coverage gap and keep previous source evidence; a successful bounded rebuild does not claim complete recovery of unavailable history. Source check timestamps and upstream watermarks remain distinct. Model stages are queued independently and are not falsely marked complete by the ingestion worker.
