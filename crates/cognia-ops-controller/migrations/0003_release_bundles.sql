-- ADR-0183 — the agent bundles each target has run.
--
-- A release names one agent bundle. A project may pin an older one while the
-- deployment still retains it, so the controller signs the retained bundles
-- into every release it dispatches. This table is where it finds them.
--
-- One row per distinct image, bumped each time a release carrying it becomes
-- the target's current release (deploy, upgrade or rollback). The store prunes
-- a target down to its newest rows after every bump, so the table holds only
-- what the next release could retain.
--
-- Row-level security in the same file as the table, so the table never exists
-- without its policy. The predicate is `ops_tenant_visible` from 0002.

CREATE TABLE IF NOT EXISTS release_bundles (
    tenant_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    image TEXT NOT NULL,
    first_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, target_id, image)
);

CREATE INDEX IF NOT EXISTS release_bundles_recent_idx
    ON release_bundles (tenant_id, target_id, last_active_at DESC);

ALTER TABLE release_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_bundles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_release_bundles ON release_bundles;
CREATE POLICY tenant_release_bundles ON release_bundles
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));
