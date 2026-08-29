-- Shared-chat control-plane corrections discovered while wiring invitations.
-- Expiry is persisted so every reader observes the same terminal state.

ALTER TABLE chat_session_invites
    DROP CONSTRAINT IF EXISTS chat_session_invites_status_check;
ALTER TABLE chat_session_invites
    ADD CONSTRAINT chat_session_invites_status_check
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired'));

ALTER TABLE break_glass_grants
    ADD COLUMN IF NOT EXISTS operation_id text;
UPDATE break_glass_grants SET operation_id = id WHERE operation_id IS NULL;
ALTER TABLE break_glass_grants ALTER COLUMN operation_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS break_glass_grants_operation
    ON break_glass_grants (org_id, session_id, operation_id);
