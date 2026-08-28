-- Stable operation ids and optimistic concurrency for collaboration writes.
-- Existing rows receive synthetic immutable ids so the new NOT NULL columns
-- can be introduced without making an older deployment unreadable.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS created_operation_id text;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS last_operation_id text;
UPDATE issues
SET created_operation_id = COALESCE(created_operation_id, 'legacy:create:' || id),
    last_operation_id = COALESCE(last_operation_id, 'legacy:last:' || id);
ALTER TABLE issues ALTER COLUMN created_operation_id SET NOT NULL;
ALTER TABLE issues ALTER COLUMN last_operation_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS issues_org_created_operation
    ON issues (org_id, created_operation_id);

ALTER TABLE issue_events ADD COLUMN IF NOT EXISTS operation_id text;
UPDATE issue_events
SET operation_id = COALESCE(operation_id, 'legacy:event:' || id);
ALTER TABLE issue_events ALTER COLUMN operation_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS issue_events_org_operation
    ON issue_events (org_id, operation_id);

ALTER TABLE plans ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS created_operation_id text;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS last_operation_id text;
UPDATE plans
SET created_operation_id = COALESCE(created_operation_id, 'legacy:create:' || id),
    last_operation_id = COALESCE(last_operation_id, 'legacy:last:' || id);
ALTER TABLE plans ALTER COLUMN created_operation_id SET NOT NULL;
ALTER TABLE plans ALTER COLUMN last_operation_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS plans_org_created_operation
    ON plans (org_id, created_operation_id);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS created_operation_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS last_operation_id text;
UPDATE runs
SET created_operation_id = COALESCE(created_operation_id, 'legacy:create:' || id),
    last_operation_id = COALESCE(last_operation_id, 'legacy:last:' || id);
ALTER TABLE runs ALTER COLUMN created_operation_id SET NOT NULL;
ALTER TABLE runs ALTER COLUMN last_operation_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS runs_org_created_operation
    ON runs (org_id, created_operation_id);
