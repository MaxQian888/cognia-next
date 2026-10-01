-- ADR-0207: one row per person something was addressed to.
--
-- `seq` is per recipient and allocated from `collab_notification_cursors`
-- under that row's lock, so a recipient's rows commit in `seq` order and a
-- client paging `after_seq` never skips one that committed late.

CREATE TABLE IF NOT EXISTS collab_notifications (
    id                text   PRIMARY KEY,
    org_id            text   NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    recipient_user_id text   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id      text,
    kind              text   NOT NULL CHECK (kind IN (
                                 'issue.assigned', 'issue.mentioned',
                                 'chat.approval_requested', 'chat.invited')),
    subject_entity    text   NOT NULL,
    subject_id        text   NOT NULL,
    actor_user_id     text   REFERENCES users(id) ON DELETE SET NULL,
    dedupe_key        text   NOT NULL,
    seq               bigint NOT NULL,
    created_at        bigint NOT NULL,
    read_at           bigint,
    UNIQUE (org_id, recipient_user_id, dedupe_key),
    UNIQUE (org_id, recipient_user_id, seq)
);
CREATE INDEX IF NOT EXISTS collab_notifications_recipient_seq
    ON collab_notifications (org_id, recipient_user_id, seq);
-- Reads are pulled by `(read_at, seq)` so a device learns what another one
-- marked read; one "mark all read" stamps many rows with the same instant.
CREATE INDEX IF NOT EXISTS collab_notifications_recipient_read
    ON collab_notifications (org_id, recipient_user_id, read_at, seq)
    WHERE read_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS collab_notification_cursors (
    org_id            text   NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    recipient_user_id text   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_seq          bigint NOT NULL,
    PRIMARY KEY (org_id, recipient_user_id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['collab_notifications', 'collab_notification_cursors'] LOOP
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
