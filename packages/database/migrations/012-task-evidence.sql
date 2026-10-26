ALTER TABLE tasks ADD COLUMN extraction_key text;
CREATE UNIQUE INDEX task_extraction_identity ON tasks(account_id,extraction_key);
ALTER TABLE task_records ADD COLUMN quote text;
CREATE INDEX task_evidence_records ON task_records(record_id,task_id);
ALTER TABLE task_records ADD COLUMN derived_content_id uuid;
ALTER TABLE task_records ADD FOREIGN KEY(derived_content_id,revision_id) REFERENCES derived_content(id,revision_id);
