CREATE TABLE index_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),revision_id uuid NOT NULL REFERENCES record_revisions(id),
 source_key text NOT NULL,kind text NOT NULL CHECK(kind IN ('source','structured','ocr','description')),
 derived_content_id uuid,content text NOT NULL,model_version text,
 FOREIGN KEY(derived_content_id,revision_id) REFERENCES derived_content(id,revision_id),
 UNIQUE(revision_id,source_key),UNIQUE(id,revision_id)
);
ALTER TABLE record_chunks ADD COLUMN source_id uuid;
ALTER TABLE record_chunks ADD FOREIGN KEY(source_id,revision_id) REFERENCES index_sources(id,revision_id);
CREATE INDEX indexed_source_chunks ON record_chunks(source_id,start_offset);
ALTER TABLE index_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_read ON index_sources FOR SELECT TO personal_context_reader USING(EXISTS(SELECT 1 FROM record_revisions r WHERE r.id=index_sources.revision_id));
GRANT SELECT ON index_sources TO personal_context_reader;
CREATE INDEX revisions_record ON record_revisions(record_id);
CREATE INDEX records_current_revision ON records(current_revision_id) WHERE deleted_at IS NULL;
CREATE INDEX jobs_record_stage ON sync_jobs((payload->>'recordId'),stage,status);
