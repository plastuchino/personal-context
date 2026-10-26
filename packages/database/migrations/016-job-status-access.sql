ALTER TABLE sync_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_read ON sync_jobs FOR SELECT TO personal_context_reader USING(can_read_account(account_id));
-- Classification freshness needs only these fields, never source-bearing job payloads.
GRANT SELECT(id,account_id,status) ON sync_jobs TO personal_context_reader;
