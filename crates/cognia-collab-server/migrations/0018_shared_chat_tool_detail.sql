-- ADR-0241 D18: an explicit, revisioned session tool-input sharing policy.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS tool_detail TEXT NOT NULL DEFAULT 'summary' CHECK (tool_detail IN ('summary','full'));
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS tool_detail_revision BIGINT NOT NULL DEFAULT 0;
