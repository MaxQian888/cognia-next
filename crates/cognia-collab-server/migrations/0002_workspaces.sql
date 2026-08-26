-- Workspace metadata on the collaboration plane — ADR-0149 §6.
--
-- `workspace_memberships` already carried a `workspace_id`, but nothing
-- carried a workspace's NAME, so a person invited into somebody else's
-- workspace had only an opaque id to look at: they have no local `projects`
-- row for a workspace they did not create. A guest is exactly that person, so
-- the state §4 exists for was also the state with the worst affordance.
--
-- Deliberately thin. A workspace's roots, its trust decisions and its
-- provisioning stay local (ADR-0144 / ADR-0147) — those describe one machine's
-- relationship to a checkout, and shipping them across the plane would invite a
-- client to act on somebody else's paths. What travels is what a roster page
-- needs: which workspaces exist in this org, and what they are called.
--
-- The id is the local `projectId`, unchanged. ADR-0149 §1 froze that on
-- purpose: two id spaces for one concept is the thing that makes a federation
-- unreadable.

CREATE TABLE IF NOT EXISTS workspaces (
    id         text   NOT NULL,
    org_id     text   NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name       text   NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (org_id, id)
);

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspaces_tenant_isolation ON workspaces;
CREATE POLICY workspaces_tenant_isolation ON workspaces
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));
