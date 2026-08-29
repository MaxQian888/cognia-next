-- Server-authoritative shared chat, the second collaboration-plane cut.

CREATE TABLE IF NOT EXISTS chat_sessions (
    id                   text PRIMARY KEY,
    org_id               text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id         text NOT NULL,
    title                text NOT NULL,
    status               text NOT NULL CHECK (status IN ('importing', 'active', 'archived', 'deleting')),
    created_by_user_id   text NOT NULL REFERENCES users(id),
    created_at           bigint NOT NULL,
    updated_at           bigint NOT NULL,
    revision             bigint NOT NULL DEFAULT 1,
    policy_revision      bigint NOT NULL DEFAULT 1,
    next_sequence        bigint NOT NULL DEFAULT 1,
    created_operation_id text NOT NULL,
    last_operation_id    text NOT NULL,
    UNIQUE (org_id, created_operation_id),
    UNIQUE (org_id, id, workspace_id)
);
CREATE INDEX IF NOT EXISTS chat_sessions_workspace ON chat_sessions (org_id, workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_session_memberships (
    org_id       text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id text NOT NULL,
    session_id   text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         text NOT NULL CHECK (role IN ('owner', 'maintainer', 'member', 'viewer')),
    approver     boolean NOT NULL DEFAULT false,
    guest        boolean NOT NULL DEFAULT false,
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL,
    PRIMARY KEY (session_id, user_id),
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE,
    CONSTRAINT chat_guest_ceiling CHECK (NOT guest OR (role IN ('member', 'viewer') AND NOT approver))
);
CREATE INDEX IF NOT EXISTS chat_memberships_user ON chat_session_memberships (org_id, user_id, session_id);

CREATE TABLE IF NOT EXISTS chat_session_invites (
    id                 text PRIMARY KEY,
    org_id             text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id       text NOT NULL,
    session_id         text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    token_hash         text NOT NULL UNIQUE,
    target_user_id     text REFERENCES users(id) ON DELETE CASCADE,
    target_email       text,
    role               text NOT NULL CHECK (role IN ('maintainer', 'member', 'viewer')),
    approver           boolean NOT NULL DEFAULT false,
    guest              boolean NOT NULL DEFAULT false,
    status             text NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
    created_by_user_id text NOT NULL REFERENCES users(id),
    accepted_by_user_id text REFERENCES users(id),
    accepted_at        bigint,
    expires_at         bigint NOT NULL,
    created_at         bigint NOT NULL,
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE,
    CONSTRAINT chat_invite_target CHECK (target_user_id IS NOT NULL OR target_email IS NOT NULL OR guest),
    CONSTRAINT chat_invite_guest_ceiling CHECK (NOT guest OR (role IN ('member', 'viewer') AND NOT approver))
);
CREATE INDEX IF NOT EXISTS chat_invites_session ON chat_session_invites (org_id, session_id, status, expires_at);

CREATE TABLE IF NOT EXISTS chat_session_events (
    id           text PRIMARY KEY,
    org_id       text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id text NOT NULL,
    session_id   text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    sequence     bigint NOT NULL,
    kind         text NOT NULL,
    actor_kind   text NOT NULL CHECK (actor_kind IN ('human', 'guest', 'agent', 'app', 'connector', 'system')),
    actor_id     text NOT NULL,
    actor_label  text,
    payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   bigint NOT NULL,
    operation_id text NOT NULL,
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE,
    UNIQUE (session_id, sequence),
    UNIQUE (session_id, operation_id)
);
CREATE INDEX IF NOT EXISTS chat_events_cursor ON chat_session_events (org_id, session_id, sequence);

CREATE TABLE IF NOT EXISTS chat_run_leases (
    id                   text PRIMARY KEY,
    org_id               text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id         text NOT NULL,
    session_id           text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    run_id               text NOT NULL,
    holder_user_id       text NOT NULL REFERENCES users(id),
    holder_device_id     text NOT NULL,
    status               text NOT NULL CHECK (status IN ('active', 'paused', 'released', 'expired', 'failed')),
    token_hash           text NOT NULL,
    token_expires_at     bigint NOT NULL,
    heartbeat_expires_at bigint NOT NULL,
    created_at           bigint NOT NULL,
    updated_at           bigint NOT NULL,
    operation_id         text NOT NULL,
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE,
    UNIQUE (session_id, operation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_one_active_lease
    ON chat_run_leases (session_id) WHERE status IN ('active', 'paused');

CREATE TABLE IF NOT EXISTS chat_run_queue (
    id             text PRIMARY KEY,
    org_id         text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id   text NOT NULL,
    session_id     text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    requested_by_user_id text NOT NULL REFERENCES users(id),
    payload        jsonb NOT NULL,
    status         text NOT NULL CHECK (status IN ('queued', 'claimed', 'cancelled')),
    position       bigint NOT NULL,
    created_at     bigint NOT NULL,
    operation_id   text NOT NULL,
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE,
    UNIQUE (session_id, operation_id),
    UNIQUE (session_id, position)
);

CREATE TABLE IF NOT EXISTS chat_approval_requests (
    id                   text PRIMARY KEY,
    org_id               text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id         text NOT NULL,
    session_id           text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    run_id               text NOT NULL,
    action               text NOT NULL,
    risk                 text NOT NULL CHECK (risk IN ('ordinary', 'high')),
    requested_by_user_id text NOT NULL REFERENCES users(id),
    status               text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
    resolved_by_user_id  text REFERENCES users(id),
    resolved_at          bigint,
    expires_at           bigint NOT NULL,
    created_at           bigint NOT NULL,
    revision             bigint NOT NULL DEFAULT 1,
    operation_id         text NOT NULL,
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE,
    UNIQUE (session_id, operation_id)
);

CREATE TABLE IF NOT EXISTS chat_attachments (
    id             text PRIMARY KEY,
    org_id         text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id   text NOT NULL,
    session_id     text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    event_id       text REFERENCES chat_session_events(id) ON DELETE SET NULL,
    object_key     text NOT NULL UNIQUE,
    file_name      text NOT NULL,
    media_type     text NOT NULL,
    byte_length    bigint NOT NULL CHECK (byte_length >= 0 AND byte_length <= 52428800),
    sha256         text NOT NULL,
    status         text NOT NULL CHECK (status IN ('pending', 'available', 'deleted')),
    created_by_user_id text NOT NULL REFERENCES users(id),
    created_at     bigint NOT NULL,
    updated_at     bigint NOT NULL,
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS break_glass_grants (
    id                 text PRIMARY KEY,
    org_id             text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id       text NOT NULL,
    session_id         text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    granted_to_user_id text NOT NULL REFERENCES users(id),
    reason             text NOT NULL CHECK (length(trim(reason)) >= 8),
    expires_at         bigint NOT NULL,
    revoked_at         bigint,
    created_at         bigint NOT NULL,
    FOREIGN KEY (org_id, session_id, workspace_id)
        REFERENCES chat_sessions(org_id, id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS authorization_audit_events (
    id              text PRIMARY KEY,
    org_id          text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id    text,
    session_id      text,
    actor_user_id   text NOT NULL,
    action          text NOT NULL,
    resource_type   text NOT NULL,
    resource_id     text NOT NULL,
    allowed         boolean NOT NULL,
    reason          text NOT NULL,
    policy_revision bigint NOT NULL,
    created_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS authz_audit_session ON authorization_audit_events (org_id, session_id, created_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'chat_sessions', 'chat_session_memberships', 'chat_session_invites',
    'chat_session_events', 'chat_run_leases', 'chat_run_queue',
    'chat_approval_requests', 'chat_attachments', 'break_glass_grants',
    'authorization_audit_events'
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
