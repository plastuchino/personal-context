ALTER TABLE photo_import_sessions ADD COLUMN picker_uri text, ADD COLUMN poll_interval_ms integer NOT NULL DEFAULT 5000, ADD COLUMN polling_deadline_at timestamptz;
CREATE TABLE photo_import_items (
 session_id uuid NOT NULL REFERENCES photo_import_sessions(id), record_id uuid NOT NULL REFERENCES records(id), revision_id uuid NOT NULL,
 media_asset_id uuid, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','downloaded','done','failed')), error_code text,
 PRIMARY KEY(session_id,record_id), FOREIGN KEY(revision_id,record_id) REFERENCES record_revisions(id,record_id),
 FOREIGN KEY(media_asset_id,record_id) REFERENCES media_assets(id,record_id)
);
CREATE UNIQUE INDEX derived_content_model ON derived_content(revision_id,kind,model_version);
