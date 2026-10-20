-- A18: pin stored resources independently of later rollout decisions.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS contract_version INTEGER NOT NULL DEFAULT 2;
ALTER TABLE canvas_documents ADD COLUMN IF NOT EXISTS contract_version INTEGER NOT NULL DEFAULT 2;
