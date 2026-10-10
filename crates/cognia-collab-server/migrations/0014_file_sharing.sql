-- ADR-0222: an organization's file-sharing policy.
--
-- One row per org, absent until an owner or admin first saves one; until then
-- the defaults in `file_sharing.rs` apply. A client intersects this with its
-- own local policy field by field (most restrictive wins), and the server
-- re-checks it before authorizing a file share from a shared conversation.
-- `revision` increases on every save so a client caches by it and a stale
-- save is refused rather than silently overwriting a newer one.

CREATE TABLE IF NOT EXISTS org_file_sharing_policies (
    org_id                     text    PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    allow_public_snapshots     boolean NOT NULL,
    allow_live_grants          boolean NOT NULL,
    allow_protocol_credentials boolean NOT NULL,
    allow_live_write           boolean NOT NULL,
    allow_agent_sharing        boolean NOT NULL,
    max_snapshot_ttl_seconds   bigint  NOT NULL CHECK (max_snapshot_ttl_seconds > 0),
    max_live_ttl_seconds       bigint  NOT NULL CHECK (max_live_ttl_seconds > 0),
    revision                   bigint  NOT NULL CHECK (revision > 0),
    updated_by                 text    NOT NULL,
    updated_at                 bigint  NOT NULL
);

ALTER TABLE org_file_sharing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_file_sharing_policies FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
      AND tablename = 'org_file_sharing_policies'
      AND policyname = 'org_file_sharing_policies_tenant'
  ) THEN
    CREATE POLICY org_file_sharing_policies_tenant ON org_file_sharing_policies
      USING (org_id = current_setting('app.tenant_id', true))
      WITH CHECK (org_id = current_setting('app.tenant_id', true));
  END IF;
END $$;
