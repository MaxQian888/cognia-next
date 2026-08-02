ALTER TABLE retention_jobs
    ADD COLUMN resource_kind text NOT NULL DEFAULT 'incident_artifact'
        CHECK (resource_kind IN ('incident_artifact', 'incident_metadata', 'symbol')),
    ADD COLUMN dedupe_key text,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN completed_at timestamptz;

UPDATE retention_jobs
SET dedupe_key = resource_kind || ':' || COALESCE(object_key, incident_id::text, id::text);
ALTER TABLE retention_jobs ALTER COLUMN dedupe_key SET NOT NULL;
CREATE UNIQUE INDEX retention_jobs_dedupe_idx ON retention_jobs (tenant_id, dedupe_key);

DROP INDEX retention_due_idx;
CREATE INDEX retention_due_idx
    ON retention_jobs (tenant_id, execute_after, created_at)
    WHERE state IN ('pending', 'failed', 'running');
