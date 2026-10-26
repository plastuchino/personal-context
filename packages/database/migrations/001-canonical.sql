CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE source_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL CHECK(provider IN ('gmail','slack','calendar','capital-one','google-photos')),
 external_account_id text NOT NULL, display_name text NOT NULL, credential_ref uuid,
 status text NOT NULL DEFAULT 'disabled' CHECK(status IN ('disabled','active','reauthorize','unavailable')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider,external_account_id)
);
CREATE TABLE sync_state (
 account_id uuid NOT NULL REFERENCES source_accounts(id), stream_key text NOT NULL,
 cursor jsonb, coverage_start timestamptz, coverage_end timestamptz, coverage_complete boolean NOT NULL DEFAULT false,
 last_attempt_at timestamptz, last_success_at timestamptz, source_watermark_at timestamptz,
 next_check_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,stream_key)
);
CREATE TABLE sync_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES source_accounts(id), stream_key text NOT NULL,
 stage text NOT NULL CHECK(stage IN ('ingest','classify','embed','photo','reclassify')), payload jsonb NOT NULL DEFAULT '{}',
 dedupe_key text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
 scheduled_at timestamptz NOT NULL DEFAULT now(), attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
 max_attempts integer NOT NULL DEFAULT 5 CHECK(max_attempts>0), lease_until timestamptz, lease_token uuid,
 started_at timestamptz, finished_at timestamptz, counts jsonb NOT NULL DEFAULT '{}', error_code text,
 FOREIGN KEY(account_id,stream_key) REFERENCES sync_state(account_id,stream_key)
);
CREATE UNIQUE INDEX active_job_dedupe ON sync_jobs(dedupe_key) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX active_stream_lease ON sync_jobs(account_id,stream_key) WHERE status='running';
CREATE INDEX jobs_due ON sync_jobs(scheduled_at) WHERE status='queued';
CREATE TABLE conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES source_accounts(id), external_id text NOT NULL,
 kind text NOT NULL, title text, personal_override boolean NOT NULL DEFAULT false,
 UNIQUE(account_id,external_id), UNIQUE(id,account_id)
);
CREATE TABLE identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES source_accounts(id), external_id text NOT NULL,
 email text, display_name text, is_self boolean NOT NULL DEFAULT false, UNIQUE(account_id,external_id), UNIQUE(id,account_id)
);
CREATE TABLE records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES source_accounts(id), conversation_id uuid,
 external_id text NOT NULL, kind text NOT NULL, source_url text, source_created_at timestamptz, source_updated_at timestamptz,
 first_ingested_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 current_revision_id uuid, UNIQUE(account_id,kind,external_id), UNIQUE(id,account_id),
 FOREIGN KEY(conversation_id,account_id) REFERENCES conversations(id,account_id)
);
CREATE TABLE record_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES records(id), revision_number integer NOT NULL CHECK(revision_number>0),
 title text NOT NULL DEFAULT '', body_text text NOT NULL, raw_payload jsonb NOT NULL, content_hash text NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now(), UNIQUE(record_id,revision_number), UNIQUE(id,record_id)
);
ALTER TABLE records ADD CONSTRAINT current_revision_belongs_to_record FOREIGN KEY(current_revision_id,id) REFERENCES record_revisions(id,record_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION protect_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Source revisions are immutable'; END $$;
CREATE TRIGGER immutable_revision BEFORE UPDATE OR DELETE ON record_revisions FOR EACH ROW EXECUTE FUNCTION protect_revision();
CREATE TABLE record_participants (
 record_id uuid NOT NULL, account_id uuid NOT NULL, identity_id uuid NOT NULL, role text NOT NULL,
 PRIMARY KEY(record_id,identity_id,role),
 FOREIGN KEY(record_id,account_id) REFERENCES records(id,account_id),
 FOREIGN KEY(identity_id,account_id) REFERENCES identities(id,account_id)
);
CREATE TABLE email_details (record_id uuid PRIMARY KEY REFERENCES records(id), message_id_header text, in_reply_to text, provider_labels text[] NOT NULL DEFAULT '{}');
CREATE TABLE slack_message_details (record_id uuid PRIMARY KEY REFERENCES records(id), channel_id text NOT NULL, provider_message_ts text NOT NULL, provider_thread_ts text);
CREATE TABLE calendar_event_details (
 record_id uuid PRIMARY KEY REFERENCES records(id), starts_at timestamptz, ends_at timestamptz, timezone text,
 start_date date, end_date date, all_day boolean NOT NULL, recurrence_id text, original_start text, status text NOT NULL,
 CHECK((all_day AND start_date IS NOT NULL AND end_date IS NOT NULL AND starts_at IS NULL AND ends_at IS NULL) OR (NOT all_day AND start_date IS NULL AND end_date IS NULL AND starts_at IS NOT NULL AND ends_at IS NOT NULL)),
 CHECK(end_date>start_date), CHECK(ends_at>=starts_at)
);
CREATE TABLE financial_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_account_id uuid NOT NULL REFERENCES source_accounts(id), external_id text NOT NULL,
 type text NOT NULL, currency text, balance numeric, balance_observed_at timestamptz,
 UNIQUE(source_account_id,external_id), UNIQUE(id,source_account_id)
);
CREATE TABLE financial_transaction_details (
 record_id uuid PRIMARY KEY, source_account_id uuid NOT NULL, financial_account_id uuid NOT NULL,
 amount numeric NOT NULL, currency text NOT NULL, merchant text, pending boolean NOT NULL, pending_external_id text,
 FOREIGN KEY(record_id,source_account_id) REFERENCES records(id,account_id),
 FOREIGN KEY(financial_account_id,source_account_id) REFERENCES financial_accounts(id,source_account_id)
);
CREATE TABLE photo_details (
 record_id uuid PRIMARY KEY REFERENCES records(id), captured_at timestamptz, mime_type text NOT NULL,
 width integer CHECK(width>0), height integer CHECK(height>0), available_location jsonb, filename text, media_asset_id uuid
);
CREATE INDEX records_account_date ON records(account_id,source_created_at,id);
CREATE INDEX participants_identity ON record_participants(identity_id,record_id);
CREATE INDEX identities_email ON identities(email);
CREATE INDEX financial_exact_amount ON financial_transaction_details(amount,currency);
CREATE INDEX calendar_starts ON calendar_event_details(starts_at);
