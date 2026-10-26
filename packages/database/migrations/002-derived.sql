CREATE TABLE media_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES records(id), sha256 text NOT NULL,
 mime_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0), bytes bytea NOT NULL,
 acquired_at timestamptz NOT NULL DEFAULT now(), UNIQUE(record_id,sha256), UNIQUE(id,record_id), CHECK(octet_length(bytes)=byte_size)
);
ALTER TABLE photo_details ADD FOREIGN KEY(media_asset_id,record_id) REFERENCES media_assets(id,record_id);
CREATE TABLE derived_content (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision_id uuid NOT NULL REFERENCES record_revisions(id),
 kind text NOT NULL CHECK(kind IN ('ocr','description','structured')), text text NOT NULL, model_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,revision_id)
);
CREATE TABLE classification_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision_id uuid NOT NULL, record_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','done','failed')), classifier_version text NOT NULL, rules_version text NOT NULL,
 evidence jsonb NOT NULL DEFAULT '[]', confidence double precision CHECK(confidence>=0 AND confidence<=1),
 classified_at timestamptz, error_code text, FOREIGN KEY(revision_id,record_id) REFERENCES record_revisions(id,record_id), UNIQUE(id,record_id)
);
CREATE TABLE record_labels (
 record_id uuid NOT NULL REFERENCES records(id), label text NOT NULL CHECK(label IN ('personal','background','blocking','update','unorganized')),
 classification_run_id uuid NOT NULL, reason text NOT NULL, assigned_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(record_id,label), FOREIGN KEY(classification_run_id,record_id) REFERENCES classification_runs(id,record_id)
);
CREATE INDEX labels_lookup ON record_labels(label,record_id);
CREATE TABLE conversation_activity_daily (
 conversation_id uuid NOT NULL REFERENCES conversations(id), activity_date date NOT NULL,
 self_message_count integer NOT NULL CHECK(self_message_count>=0), total_message_count integer NOT NULL CHECK(total_message_count>=self_message_count),
 coverage_complete boolean NOT NULL, PRIMARY KEY(conversation_id,activity_date)
);
CREATE TABLE tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES source_accounts(id),
 title text NOT NULL, description text NOT NULL, status text NOT NULL CHECK(status IN ('open','done','uncertain')),
 requested_at timestamptz, due_at timestamptz, resolved_at timestamptz, resolution_evidence_record_id uuid,
 UNIQUE(id,account_id), FOREIGN KEY(resolution_evidence_record_id,account_id) REFERENCES records(id,account_id),
 CHECK(status<>'done' OR (resolved_at IS NOT NULL AND resolution_evidence_record_id IS NOT NULL))
);
CREATE TABLE task_records (
 task_id uuid NOT NULL, account_id uuid NOT NULL, record_id uuid NOT NULL, revision_id uuid NOT NULL,
 relationship text NOT NULL CHECK(relationship IN ('request','follow-up','resolution')),
 PRIMARY KEY(task_id,record_id,revision_id,relationship), FOREIGN KEY(task_id,account_id) REFERENCES tasks(id,account_id),
 FOREIGN KEY(record_id,account_id) REFERENCES records(id,account_id), FOREIGN KEY(revision_id,record_id) REFERENCES record_revisions(id,record_id)
);
CREATE INDEX tasks_status ON tasks(account_id,status,due_at);
CREATE TABLE record_chunks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision_id uuid NOT NULL REFERENCES record_revisions(id), derived_content_id uuid,
 chunk_index integer NOT NULL CHECK(chunk_index>=0), content text NOT NULL, start_offset integer NOT NULL CHECK(start_offset>=0),
 end_offset integer NOT NULL CHECK(end_offset>=start_offset),
 search_vector tsvector GENERATED ALWAYS AS(to_tsvector('english',content)) STORED,
 FOREIGN KEY(derived_content_id,revision_id) REFERENCES derived_content(id,revision_id), UNIQUE(revision_id,chunk_index)
);
CREATE INDEX chunks_keywords ON record_chunks USING gin(search_vector);
CREATE TABLE embedding_models (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, model_name text NOT NULL, dimensions integer NOT NULL CHECK(dimensions BETWEEN 1 AND 2000),
 version text NOT NULL, UNIQUE(provider,model_name,version), UNIQUE(id,dimensions)
);
CREATE TABLE chunk_embeddings (
 chunk_id uuid NOT NULL REFERENCES record_chunks(id), embedding_model_id uuid NOT NULL, dimensions integer NOT NULL,
 embedding vector NOT NULL, embedded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(chunk_id,embedding_model_id),
 FOREIGN KEY(embedding_model_id,dimensions) REFERENCES embedding_models(id,dimensions), CHECK(vector_dims(embedding)=dimensions)
);
-- Model-specific HNSW indexes are created only after a model/dimension is pinned.
CREATE TABLE agent_clients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, credential_digest text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE access_grants (client_id uuid NOT NULL REFERENCES agent_clients(id), account_id uuid NOT NULL REFERENCES source_accounts(id), PRIMARY KEY(client_id,account_id));
CREATE TABLE retrieval_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES agent_clients(id), tool text NOT NULL,
 access_decision text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), returned_record_ids uuid[] NOT NULL DEFAULT '{}'
);
CREATE TABLE photo_import_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES source_accounts(id),
 provider_session_ref text NOT NULL, status text NOT NULL CHECK(status IN ('selecting','selected','importing','done','failed','expired')),
 expires_at timestamptz NOT NULL, counts jsonb NOT NULL DEFAULT '{}', error_code text
);
