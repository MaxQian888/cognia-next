-- Invitations and membership administration.

CREATE TABLE IF NOT EXISTS organization_invitations (
    id               text PRIMARY KEY,
    org_id           text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id     text,
    org_role         text CHECK (org_role IN ('owner', 'admin', 'member')),
    workspace_role   text CHECK (workspace_role IN ('maintainer', 'member', 'viewer')),
    token_hash       text NOT NULL UNIQUE,
    created_by       text NOT NULL REFERENCES users(id),
    expires_at       bigint NOT NULL,
    redeemed_at      bigint,
    redeemed_by      text REFERENCES users(id),
    revoked_at       bigint,
    revoked_by       text REFERENCES users(id),
    created_at       bigint NOT NULL,
    CONSTRAINT organization_invitation_scope CHECK (
        (org_role IS NOT NULL AND workspace_id IS NULL AND workspace_role IS NULL)
        OR
        (org_role IS NULL AND workspace_id IS NOT NULL AND workspace_role IS NOT NULL)
    ),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS organization_invitations_org
    ON organization_invitations (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS organization_invitations_active
    ON organization_invitations (org_id, expires_at)
    WHERE redeemed_at IS NULL AND revoked_at IS NULL;

ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_invitations_tenant ON organization_invitations;
CREATE POLICY organization_invitations_tenant ON organization_invitations
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));

-- User provisioning is necessarily the first write when a valid invitation is
-- accepted. Reads remain membership-gated, while inserts require a bound
-- tenant so an unscoped pooled connection still fails closed.
DROP POLICY IF EXISTS users_visible_to_their_orgs ON users;
CREATE POLICY users_visible_to_their_orgs ON users
    USING (belongs_to_current_tenant(users.id))
    WITH CHECK (nullif(current_setting('app.tenant_id', true), '') IS NOT NULL);

-- An invited subject must be resolvable before its first membership row exists.
-- The Logto tenant can safely bridge that bootstrap because 0006 makes the
-- tenant-to-org mapping unique and every caller is still scoped to one org.
DROP POLICY IF EXISTS external_identities_visible_with_their_user ON external_identities;
CREATE POLICY external_identities_visible_with_their_user ON external_identities
    USING (
        belongs_to_current_tenant(external_identities.user_id)
        OR external_identities.tenant = (
            SELECT logto_organization_id FROM orgs
             WHERE id = nullif(current_setting('app.tenant_id', true), '')
        )
    )
    WITH CHECK (
        belongs_to_current_tenant(external_identities.user_id)
        OR external_identities.tenant = (
            SELECT logto_organization_id FROM orgs
             WHERE id = nullif(current_setting('app.tenant_id', true), '')
        )
    );
