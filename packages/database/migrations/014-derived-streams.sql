INSERT INTO sync_state(account_id,stream_key,enabled)
 SELECT DISTINCT r.account_id,'derived:'||r.id::text,false FROM records r JOIN sync_jobs j ON j.account_id=r.account_id AND j.payload->>'recordId'=r.id::text WHERE j.stage IN ('classify','embed') ON CONFLICT DO NOTHING;
UPDATE sync_jobs j SET stream_key='derived:'||r.id::text FROM records r WHERE j.account_id=r.account_id AND j.payload->>'recordId'=r.id::text AND j.stage IN ('classify','embed') AND j.status<>'running';
