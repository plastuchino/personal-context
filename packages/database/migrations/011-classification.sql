ALTER TABLE records ADD COLUMN context_version bigint NOT NULL DEFAULT 0;
ALTER TABLE classification_runs ADD COLUMN context_version bigint NOT NULL DEFAULT 0,
 ADD COLUMN job_id uuid REFERENCES sync_jobs(id), ADD COLUMN attempt integer, ADD COLUMN lease_token uuid;
CREATE UNIQUE INDEX classification_attempt ON classification_runs(job_id,lease_token);
CREATE INDEX classification_current ON classification_runs(record_id,revision_id,context_version,classified_at DESC);
CREATE FUNCTION invalidate_record_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.current_revision_id IS DISTINCT FROM NEW.current_revision_id OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
  UPDATE records SET context_version=context_version+1 WHERE id=NEW.id OR (NEW.conversation_id IS NOT NULL AND conversation_id=NEW.conversation_id);
  DELETE FROM record_labels WHERE record_id IN (SELECT id FROM records WHERE id=NEW.id OR (NEW.conversation_id IS NOT NULL AND conversation_id=NEW.conversation_id));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_context_changed AFTER UPDATE OF current_revision_id,deleted_at ON records FOR EACH ROW EXECUTE FUNCTION invalidate_record_context();
CREATE FUNCTION invalidate_derived_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE records SET context_version=context_version+1 WHERE current_revision_id=NEW.revision_id;
 DELETE FROM record_labels WHERE record_id IN (SELECT id FROM records WHERE current_revision_id=NEW.revision_id);
 RETURN NEW;
END $$;
CREATE TRIGGER derived_context_changed AFTER INSERT ON derived_content FOR EACH ROW EXECUTE FUNCTION invalidate_derived_context();
CREATE FUNCTION invalidate_personal_setting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.personal_override IS DISTINCT FROM OLD.personal_override THEN
  UPDATE records SET context_version=context_version+1 WHERE conversation_id=NEW.id;
  DELETE FROM record_labels WHERE record_id IN (SELECT id FROM records WHERE conversation_id=NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER personal_setting_changed AFTER UPDATE OF personal_override ON conversations FOR EACH ROW EXECUTE FUNCTION invalidate_personal_setting();
ALTER TABLE conversations ADD COLUMN relevance_check_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX conversation_relevance_due ON conversations(relevance_check_at) WHERE kind IN ('group','channel');
CREATE FUNCTION expedite_personal_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.conversation_id IS NOT NULL THEN
  UPDATE conversations SET relevance_check_at=least(relevance_check_at,coalesce(NEW.source_created_at+interval '7 days',now())) WHERE id=NEW.conversation_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER personal_expiry AFTER INSERT OR UPDATE OF source_created_at,current_revision_id ON records FOR EACH ROW EXECUTE FUNCTION expedite_personal_expiry();
