-- 0004: workflow step runs record which registered operation executed and
-- its version, so a resumed run can prove it is replaying the same code path
-- (and history shows which registry version produced a result).
ALTER TABLE workflow_steps ADD COLUMN operation_id TEXT;
ALTER TABLE workflow_steps ADD COLUMN operation_version INTEGER;
ALTER TABLE workflows ADD COLUMN definition_version INTEGER NOT NULL DEFAULT 1;
