ALTER TABLE calendar_event_details ADD COLUMN recurrence_rules text[] NOT NULL DEFAULT '{}';
CREATE INDEX calendar_parent ON calendar_event_details(recurrence_id);
