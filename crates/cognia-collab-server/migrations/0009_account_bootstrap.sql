-- Account bootstrap and generic invitation acceptance.
--
-- Everything before this migration assumed the caller already belonged to an
-- organization: every route is `/v1/orgs/{org_id}/...` and every policy reads
-- `app.tenant_id`. The first person on a deployment, and a person redeeming an
-- invitation they were handed out of band, belong to nothing yet. Three new
-- transaction-local settings scope those two moments without opening a
-- cross-tenant door:
--
--   app.account_provider / app.account_tenant / app.account_subject
--       "which organizations is THIS verified subject in". Read-only.
--   app.invitation_token_hash
--       "find the invitation this token names, whichever org owns it". Read-only.
--   app.provisioning_operation / app.bootstrap_credential_hash
--       the two tables below, each visible only to the request that owns
--       the row it is asking about.
--
-- Unset settings compare as NULL, so an unscoped pooled connection still sees
-- nothing. Every new policy is FOR SELECT except where a write is the whole
-- point, and those are keyed on the row's own identifier.

-- ── Provisioning saga ────────────────────────────────────────────────────────
--
-- A bootstrap or invitation acceptance touches Logto AND this database. The
-- operation row is written first (`pending`), advanced once Logto has been
-- mutated (`idp_applied`), and closed once the local rows exist (`committed`).
-- A retry with the same operation id resumes from the recorded state. The one
-- window it cannot close is a failure between Logto answering and the
-- `idp_applied` write landing: the server logs the orphaned organization id
-- at error level for the operator, because Logto organization names are not
-- unique and there is no idempotency key to lean on.

CREATE TABLE IF NOT EXISTS identity_provisioning_operations (
    id                     text PRIMARY KEY,
    kind                   text NOT NULL CHECK (kind IN ('bootstrap', 'invitation-accept')),
    state                  text NOT NULL CHECK (state IN ('pending', 'idp_applied', 'committed')),
    identity_provider      text NOT NULL,
    identity_tenant        text,
    identity_subject       text NOT NULL,
    payload                jsonb NOT NULL DEFAULT '{}'::jsonb,
    logto_organization_id  text,
    result                 jsonb,
    created_at             bigint NOT NULL,
    updated_at             bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS identity_provisioning_operations_subject
    ON identity_provisioning_operations (identity_provider, identity_subject, created_at DESC);

-- Keyed on the operation id AND the subject: an operation id is a client-
-- supplied resume handle, and one subject must never be able to resume, or
-- even read, another's.
ALTER TABLE identity_provisioning_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_provisioning_operations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS identity_provisioning_operations_own ON identity_provisioning_operations;
CREATE POLICY identity_provisioning_operations_own ON identity_provisioning_operations
    USING (
        id = nullif(current_setting('app.provisioning_operation', true), '')
        AND identity_provider = nullif(current_setting('app.account_provider', true), '')
        AND identity_subject  = nullif(current_setting('app.account_subject', true), '')
    )
    WITH CHECK (
        id = nullif(current_setting('app.provisioning_operation', true), '')
        AND identity_provider = nullif(current_setting('app.account_provider', true), '')
        AND identity_subject  = nullif(current_setting('app.account_subject', true), '')
    );

-- ── Deployment bootstrap credential ──────────────────────────────────────────
--
-- "First visitor wins" is forbidden. The first owner presents a one-time
-- credential the operator minted, identified here by its SHA-256. A row is
-- reserved by the operation that starts the claim (so a second claimant is
-- refused before Logto is touched) and consumed when the claim commits.
-- Rotation is a new credential, hence a new row.

CREATE TABLE IF NOT EXISTS deployment_bootstrap_credentials (
    credential_hash        text PRIMARY KEY,
    reserved_by_operation  text NOT NULL,
    reserved_at            bigint NOT NULL,
    consumed_at            bigint,
    consumed_by_user_id    text,
    org_id                 text
);

ALTER TABLE deployment_bootstrap_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_bootstrap_credentials FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deployment_bootstrap_credentials_own ON deployment_bootstrap_credentials;
CREATE POLICY deployment_bootstrap_credentials_own ON deployment_bootstrap_credentials
    USING      (credential_hash = nullif(current_setting('app.bootstrap_credential_hash', true), ''))
    WITH CHECK (credential_hash = nullif(current_setting('app.bootstrap_credential_hash', true), ''));

-- ── Subject-scoped reads ─────────────────────────────────────────────────────
--
-- Two settings, bound by the server in one transaction:
--
--   1. `app.account_provider` / `app.account_subject` / `app.account_tenant`
--      open `external_identities` to the caller's own rows. That is the only
--      table a subject is looked up in.
--   2. `app.account_user_ids` carries the user ids that lookup returned, as a
--      comma-separated list, and every other subject policy compares against
--      it and NOTHING else.
--
-- Why the second setting exists instead of a function that reads
-- `external_identities`: policies are evaluated per row, permissive policies
-- are OR-ed, and migration 0007's `external_identities` policy already reads
-- `orgs`. A function that read `external_identities` from inside the
-- `org_memberships` policy closed a cycle (orgs → org_memberships → function →
-- external_identities → orgs …) that Postgres cannot see through a function
-- call and that recurses to the stack limit on the first foreign row. A
-- setting reads no table, so no policy can re-enter another.
--
-- `external_identities.tenant` holds the Logto ORGANIZATION the row was linked
-- under, while a plain (organization-less) token carries no tenant at all. So
-- an empty `app.account_tenant` means "this subject, in every organization",
-- which is precisely the question membership discovery asks. A set tenant
-- narrows to that organization.

CREATE OR REPLACE FUNCTION account_subject_user_ids()
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
    SELECT string_to_array(nullif(current_setting('app.account_user_ids', true), ''), ',');
$$;

DROP POLICY IF EXISTS external_identities_visible_to_account_subject ON external_identities;
CREATE POLICY external_identities_visible_to_account_subject ON external_identities
    FOR SELECT
    USING (
        provider = nullif(current_setting('app.account_provider', true), '')
        AND subject = nullif(current_setting('app.account_subject', true), '')
        AND (nullif(current_setting('app.account_tenant', true), '') IS NULL
             OR tenant = nullif(current_setting('app.account_tenant', true), ''))
    );

DROP POLICY IF EXISTS users_visible_to_account_subject ON users;
CREATE POLICY users_visible_to_account_subject ON users
    FOR SELECT
    USING (users.id = ANY (account_subject_user_ids()));

DROP POLICY IF EXISTS org_memberships_visible_to_account_subject ON org_memberships;
CREATE POLICY org_memberships_visible_to_account_subject ON org_memberships
    FOR SELECT
    USING (org_memberships.user_id = ANY (account_subject_user_ids()));

DROP POLICY IF EXISTS workspace_memberships_visible_to_account_subject ON workspace_memberships;
CREATE POLICY workspace_memberships_visible_to_account_subject ON workspace_memberships
    FOR SELECT
    USING (workspace_memberships.user_id = ANY (account_subject_user_ids()));

DROP POLICY IF EXISTS orgs_visible_to_account_subject ON orgs;
CREATE POLICY orgs_visible_to_account_subject ON orgs
    FOR SELECT
    USING (
        orgs.id IN (
            SELECT org_id FROM org_memberships
             WHERE user_id = ANY (account_subject_user_ids())
            UNION
            SELECT org_id FROM workspace_memberships
             WHERE user_id = ANY (account_subject_user_ids())
        )
    );

-- ── Invitation lookup by token ───────────────────────────────────────────────
--
-- The token is the only thing the invitee holds. Which org minted it is what
-- the lookup answers, so the row must be readable before the tenant is known.
-- Keyed on the hash, which the caller can only produce from the token itself.

DROP POLICY IF EXISTS organization_invitations_by_token ON organization_invitations;
CREATE POLICY organization_invitations_by_token ON organization_invitations
    FOR SELECT
    USING (token_hash = nullif(current_setting('app.invitation_token_hash', true), ''));
