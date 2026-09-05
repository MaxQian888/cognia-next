-- Server-authoritative Canvas documents, the third collaboration-plane cut.
--
-- # This service does not understand Yjs, and does not need to
--
-- Every byte in `canvas_document_updates.payload` and `canvas_documents.snapshot`
-- is an opaque Yjs update produced by a client. The server relays and orders
-- them; it never decodes one. That is what keeps `yrs` out of the build, and it
-- is sound because a Yjs update is commutative and idempotent against a
-- document: a joiner that applies the snapshot and then every update recorded
-- after it arrives at the same state as everyone else, whatever order the
-- writes landed in.
--
-- Compaction is therefore a client act too. A peer that holds the whole
-- document posts `Y.encodeStateAsUpdate` as a new snapshot naming the sequence
-- it covers, and the rows at or below it become redundant.
--
-- # Membership is the workspace's, not the document's
--
-- Shared chat carries `chat_session_memberships` because a session is invited
-- to individually. A Canvas document is not: it belongs to a workspace, and
-- whoever may write in that workspace may edit it. There is deliberately no
-- per-document member table and no per-document invite — a second membership
-- system next to `workspace_memberships` is two answers to one question, and
-- the drift between them would be the security bug.

CREATE TABLE IF NOT EXISTS canvas_documents (
    id                   text PRIMARY KEY,
    org_id               text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id         text NOT NULL,
    title                text NOT NULL,
    language             text NOT NULL,
    created_by_user_id   text NOT NULL REFERENCES users(id),
    created_at           bigint NOT NULL,
    updated_at           bigint NOT NULL,
    revision             bigint NOT NULL DEFAULT 1,
    -- The baseline every joiner starts from. NULL until the first compaction,
    -- which is legitimate: a young document is its update log.
    snapshot             bytea,
    -- Updates at or below this sequence are already folded into `snapshot`.
    snapshot_sequence    bigint NOT NULL DEFAULT 0,
    next_sequence        bigint NOT NULL DEFAULT 1,
    created_operation_id text NOT NULL,
    last_operation_id    text NOT NULL,
    UNIQUE (org_id, created_operation_id),
    -- Lets the child tables prove org, document and workspace agree with one
    -- foreign key, rather than trusting a workspace id copied onto each row.
    UNIQUE (org_id, id, workspace_id)
);
CREATE INDEX IF NOT EXISTS canvas_documents_workspace
    ON canvas_documents (org_id, workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS canvas_document_updates (
    org_id         text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id   text NOT NULL,
    document_id    text NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
    sequence       bigint NOT NULL,
    payload        bytea NOT NULL,
    author_user_id text NOT NULL REFERENCES users(id),
    created_at     bigint NOT NULL,
    operation_id   text NOT NULL,
    PRIMARY KEY (document_id, sequence),
    -- What makes the offline replay queue safe to drain more than once: a
    -- client that reconnects mid-flush replays the same operation ids and the
    -- second attempt collides here instead of duplicating the edit.
    UNIQUE (document_id, operation_id),
    CONSTRAINT canvas_update_size CHECK (octet_length(payload) BETWEEN 1 AND 1048576),
    FOREIGN KEY (org_id, document_id, workspace_id)
        REFERENCES canvas_documents(org_id, id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canvas_comments (
    id             text PRIMARY KEY,
    org_id         text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id   text NOT NULL,
    document_id    text NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
    -- A Yjs relative position, base64. Stored as text because it is opaque
    -- here and never compared, only handed back. Line numbers were the old
    -- anchor and they move under every concurrent edit above them.
    anchor         text NOT NULL,
    head           text,
    body           text NOT NULL,
    author_user_id text NOT NULL REFERENCES users(id),
    resolved       boolean NOT NULL DEFAULT false,
    created_at     bigint NOT NULL,
    updated_at     bigint NOT NULL,
    operation_id   text NOT NULL,
    UNIQUE (document_id, operation_id),
    FOREIGN KEY (org_id, document_id, workspace_id)
        REFERENCES canvas_documents(org_id, id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS canvas_comments_document
    ON canvas_comments (org_id, document_id, resolved, created_at);

CREATE TABLE IF NOT EXISTS canvas_versions (
    id             text PRIMARY KEY,
    org_id         text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id   text NOT NULL,
    document_id    text NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
    label          text NOT NULL,
    content        text NOT NULL,
    author_user_id text NOT NULL REFERENCES users(id),
    created_at     bigint NOT NULL,
    operation_id   text NOT NULL,
    UNIQUE (document_id, operation_id),
    FOREIGN KEY (org_id, document_id, workspace_id)
        REFERENCES canvas_documents(org_id, id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS canvas_versions_document
    ON canvas_versions (org_id, document_id, created_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canvas_documents', 'canvas_document_updates', 'canvas_comments', 'canvas_versions'
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
