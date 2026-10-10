-- ADR-0222 §6: the members of a shared conversation reach the files a host
-- shares with them, through requests the host answers.
--
-- session_file_hosts   the device holding a shared conversation's files: one
--                      per conversation, registered by a member who may share
--                      them (`files.share`) and authenticated afterwards by a
--                      host token the server keeps only as a SHA-256.
-- session_file_grants  the host's live grants with a `collab` audience, as the
--                      host mirrors them: what members may list and ask for.
--                      The host's own row stays authoritative for serving;
--                      it re-checks every request against it.
-- host_file_requests   one member's request (list, stat, read, write, mkdir,
--                      delete, rename) and its answer. Bytes travel through
--                      the attachment object store under request-scoped keys
--                      that only the requester and the host can reach, and
--                      expire with the request.

CREATE TABLE IF NOT EXISTS session_file_hosts (
    session_id      text    PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
    org_id          text    NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id    text    NOT NULL,
    registered_by   text    NOT NULL REFERENCES users(id),
    host_token_hash text    NOT NULL UNIQUE,
    host_label      text    NOT NULL,
    registered_at   bigint  NOT NULL,
    last_seen_at    bigint,
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE
);

-- A grant's id is chosen by its host, so it is unique within its org only:
-- an id another org already holds must not collide (or reveal itself).
CREATE TABLE IF NOT EXISTS session_file_grants (
    id              text    NOT NULL,
    org_id          text    NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id    text    NOT NULL,
    session_id      text    NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    label           text,
    -- NULL: every member whose role is at least min_role.
    user_ids        text[],
    min_role        text    NOT NULL CHECK (min_role IN ('viewer', 'member', 'maintainer', 'owner')),
    permissions     text[]  NOT NULL,
    -- [{"path": "/workspace/src", "isDir": true}, ...]
    paths           jsonb   NOT NULL,
    status          text    NOT NULL CHECK (status IN ('active', 'suspended', 'stale', 'expired', 'revoked')),
    expires_at      bigint  NOT NULL,
    revoked_at      bigint,
    policy_revision bigint  NOT NULL,
    created_by      text    NOT NULL REFERENCES users(id),
    created_at      bigint  NOT NULL,
    updated_at      bigint  NOT NULL,
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_file_grants_session
    ON session_file_grants (org_id, session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS host_file_requests (
    id                  text    PRIMARY KEY,
    org_id              text    NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id        text    NOT NULL,
    session_id          text    NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    grant_id            text    NOT NULL,
    requester_user_id   text    NOT NULL REFERENCES users(id),
    requester_role      text    NOT NULL CHECK (requester_role IN ('viewer', 'member', 'maintainer', 'owner')),
    op                  text    NOT NULL CHECK (op IN ('list', 'stat', 'read', 'write', 'mkdir', 'delete', 'rename')),
    path                text    NOT NULL,
    dest_path           text,
    upload_byte_length  bigint  CHECK (upload_byte_length IS NULL OR (upload_byte_length >= 0 AND upload_byte_length <= 52428800)),
    upload_sha256       text,
    upload_object_key   text,
    status              text    NOT NULL CHECK (status IN ('awaiting_upload', 'pending', 'claimed', 'done', 'failed', 'expired')),
    result              jsonb,
    result_object_key   text,
    result_byte_length  bigint,
    result_media_type   text,
    error               text,
    created_at          bigint  NOT NULL,
    claimed_at          bigint,
    completed_at        bigint,
    -- Unclaimed: when it stops waiting. Answered: when its bytes are dropped.
    expires_at          bigint  NOT NULL,
    FOREIGN KEY (org_id, grant_id)
        REFERENCES session_file_grants(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS host_file_requests_queue
    ON host_file_requests (org_id, session_id, status, created_at);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'session_file_hosts', 'session_file_grants', 'host_file_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
        AND tablename = table_name AND policyname = table_name || '_tenant'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (org_id = current_setting(''app.tenant_id'', true)) WITH CHECK (org_id = current_setting(''app.tenant_id'', true))',
        table_name || '_tenant', table_name
      );
    END IF;
  END LOOP;
END $$;
