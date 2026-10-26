ALTER TABLE sync_jobs DROP CONSTRAINT sync_jobs_stage_check;
ALTER TABLE sync_jobs ADD CONSTRAINT sync_jobs_stage_check CHECK(stage IN ('ingest','classify','embed','photo','reclassify','slack-event'));
CREATE TABLE slack_connection_state (
 account_id uuid PRIMARY KEY REFERENCES source_accounts(id), app_id text NOT NULL, team_id text NOT NULL, authorized_user_id text NOT NULL,
 app_credential_ref uuid REFERENCES encrypted_credentials(id), status text NOT NULL DEFAULT 'not_configured'
 CHECK(status IN ('not_configured','connecting','connected','disconnected','reauthorize','failed')),
 connected_at timestamptz, last_event_received_at timestamptz, last_event_processed_at timestamptz,
 gap_started_at timestamptz, last_reconciled_at timestamptz, coverage_complete boolean NOT NULL DEFAULT false,
 worker_lease_until timestamptz, worker_lease_token uuid, error_code text,
 UNIQUE(app_id,team_id,authorized_user_id)
);
CREATE TABLE slack_event_inbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES slack_connection_state(account_id),
 team_id text NOT NULL, event_id text NOT NULL, envelope_id text NOT NULL, event_ts text NOT NULL,
 channel_id text NOT NULL, message_ts text NOT NULL, payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','done','failed')), error_code text,
 UNIQUE(account_id,event_id), UNIQUE(id,account_id)
);
CREATE INDEX slack_inbox_pending ON slack_event_inbox(account_id,received_at) WHERE status='queued';
CREATE TABLE slack_message_versions (
 account_id uuid NOT NULL REFERENCES source_accounts(id), channel_id text NOT NULL, message_ts text NOT NULL,
 version numeric NOT NULL, deleted boolean NOT NULL, record_id uuid,
 PRIMARY KEY(account_id,channel_id,message_ts), FOREIGN KEY(record_id,account_id) REFERENCES records(id,account_id)
);
CREATE TABLE slack_threads (
 account_id uuid NOT NULL REFERENCES source_accounts(id), channel_id text NOT NULL, thread_ts text NOT NULL,
 last_reconciled_at timestamptz, PRIMARY KEY(account_id,channel_id,thread_ts)
);
ALTER TABLE slack_connection_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_read ON slack_connection_state FOR SELECT TO personal_context_reader USING(can_read_account(account_id));
GRANT SELECT(account_id,status,connected_at,last_event_received_at,last_event_processed_at,gap_started_at,last_reconciled_at,coverage_complete,error_code) ON slack_connection_state TO personal_context_reader;
