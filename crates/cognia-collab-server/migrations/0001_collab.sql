-- Collaboration plane, first cut — ADR-0149 §6.
--
-- Scope: Issues. Workspace metadata, Plans and Runs follow in Batch 7; sessions
-- and messages are a second cut and are deliberately absent.
--
-- Idempotent throughout: this file is applied with `batch_execute` on every
-- boot, matching `crates/cognia-ops-controller/migrations/0001_init.sql`.
--
-- ## Tenancy
--
-- The Org is the tenant boundary. Every org-scoped table carries `org_id` and
-- an RLS policy reading `app.tenant_id`, which the request path binds per
-- transaction (see `cognia_tenant_auth::rls` for why the bind must be
-- transaction-local).
--
-- `users` is deliberately NOT org-scoped — one person belongs to many orgs —
-- so its policy is a membership join instead: a tenant sees exactly the people
-- who are members of it. Without that, every tenant could enumerate every user
-- in the deployment.
--
-- ## Ids are text, not uuid
--
-- ADR-0149 §1 froze `usr_…` / `org_…`. `services/diagnostic-server` uses uuid
-- tenants and casts its RLS predicate with `::uuid`; this schema cannot, which
-- is why `cognia_tenant_auth::rls` carries both predicate spellings.

CREATE TABLE IF NOT EXISTS users (
    id           text PRIMARY KEY,
    display_name text        NOT NULL,
    email        text,
    avatar_url   text,
    created_at   bigint      NOT NULL,
    updated_at   bigint      NOT NULL
);

CREATE TABLE IF NOT EXISTS orgs (
    id                     text PRIMARY KEY,
    display_name           text   NOT NULL,
    logto_organization_id  text,
    created_at             bigint NOT NULL,
    updated_at             bigint NOT NULL
);

-- One external subject bound to one user. ADR-0149 §3: the id is ours, the
-- subject is theirs, so re-linking an IdP touches this table and no other.
CREATE TABLE IF NOT EXISTS external_identities (
    id         text PRIMARY KEY,
    user_id    text   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider   text   NOT NULL,
    subject    text   NOT NULL,
    tenant     text,
    label      text,
    linked_at  bigint NOT NULL,
    UNIQUE (provider, tenant, subject)
);
CREATE INDEX IF NOT EXISTS external_identities_user ON external_identities (user_id);

CREATE TABLE IF NOT EXISTS org_memberships (
    org_id     text   NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
    user_id    text   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       text   NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS org_memberships_user ON org_memberships (user_id);

CREATE TABLE IF NOT EXISTS workspace_memberships (
    workspace_id text   NOT NULL,
    user_id      text   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id       text   NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    role         text   NOT NULL CHECK (role IN ('maintainer', 'member', 'viewer')),
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_memberships_user ON workspace_memberships (user_id, org_id);

-- `assignee_id` and `created_by_id` are NOT NULL. That is the ADR-0149 §10
-- supersession of ADR-0132's optional actor id: on the collaboration plane an
-- anonymous human is unresolvable, because "the local user" names nobody once
-- there is more than one.
CREATE TABLE IF NOT EXISTS issues (
    id               text   PRIMARY KEY,
    org_id           text   NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id     text   NOT NULL,
    issue_project_id text   NOT NULL,
    title            text   NOT NULL,
    body             text,
    status           text   NOT NULL,
    priority         text   NOT NULL,
    board_order      double precision NOT NULL DEFAULT 0,
    assignee_kind    text   CHECK (assignee_kind IN ('human', 'agent', 'team')),
    assignee_id      text,
    created_by_kind  text   NOT NULL CHECK (created_by_kind IN ('human', 'agent', 'team')),
    created_by_id    text   NOT NULL,
    created_at       bigint NOT NULL,
    updated_at       bigint NOT NULL,
    -- An assignee is either wholly present or wholly absent. A kind without an
    -- id is precisely the shape this plane exists to reject.
    CONSTRAINT issues_assignee_complete
        CHECK ((assignee_kind IS NULL) = (assignee_id IS NULL))
);
CREATE INDEX IF NOT EXISTS issues_org_workspace ON issues (org_id, workspace_id);
CREATE INDEX IF NOT EXISTS issues_org_project   ON issues (org_id, issue_project_id);
CREATE INDEX IF NOT EXISTS issues_assignee      ON issues (org_id, assignee_kind, assignee_id);

CREATE TABLE IF NOT EXISTS issue_events (
    id         text   PRIMARY KEY,
    org_id     text   NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    issue_id   text   NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind       text   NOT NULL,
    ts         bigint NOT NULL,
    actor_kind text   NOT NULL CHECK (actor_kind IN ('human', 'agent', 'team')),
    actor_id   text   NOT NULL,
    payload    jsonb  NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS issue_events_issue ON issue_events (issue_id, ts);

-- ── Row-level security ───────────────────────────────────────────────────────
--
-- FORCE so the table owner is not exempt: without it, the application role
-- being the owner silently disables every policy below.

ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE orgs                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE external_identities   ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_identities   FORCE  ROW LEVEL SECURITY;
ALTER TABLE org_memberships       ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_memberships       FORCE  ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships FORCE  ROW LEVEL SECURITY;
ALTER TABLE issues                ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues                FORCE  ROW LEVEL SECURITY;
ALTER TABLE issue_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_events          FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orgs_tenant_isolation ON orgs;
CREATE POLICY orgs_tenant_isolation ON orgs
    USING      (id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (id = nullif(current_setting('app.tenant_id', true), ''));

DROP POLICY IF EXISTS org_memberships_tenant_isolation ON org_memberships;
CREATE POLICY org_memberships_tenant_isolation ON org_memberships
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));

DROP POLICY IF EXISTS workspace_memberships_tenant_isolation ON workspace_memberships;
CREATE POLICY workspace_memberships_tenant_isolation ON workspace_memberships
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));

DROP POLICY IF EXISTS issues_tenant_isolation ON issues;
CREATE POLICY issues_tenant_isolation ON issues
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));

DROP POLICY IF EXISTS issue_events_tenant_isolation ON issue_events;
CREATE POLICY issue_events_tenant_isolation ON issue_events
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));

-- A person is visible to a tenant exactly when they are a member of it. Without
-- this, `users` would be a deployment-wide directory readable by any tenant.
DROP POLICY IF EXISTS users_visible_to_their_orgs ON users;
CREATE POLICY users_visible_to_their_orgs ON users
    USING (EXISTS (
        SELECT 1 FROM org_memberships m
        WHERE m.user_id = users.id
          AND m.org_id  = nullif(current_setting('app.tenant_id', true), '')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM org_memberships m
        WHERE m.user_id = users.id
          AND m.org_id  = nullif(current_setting('app.tenant_id', true), '')
    ));

-- Same reasoning one hop further: an identity is visible with its person.
DROP POLICY IF EXISTS external_identities_visible_with_their_user ON external_identities;
CREATE POLICY external_identities_visible_with_their_user ON external_identities
    USING (EXISTS (
        SELECT 1 FROM org_memberships m
        WHERE m.user_id = external_identities.user_id
          AND m.org_id  = nullif(current_setting('app.tenant_id', true), '')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM org_memberships m
        WHERE m.user_id = external_identities.user_id
          AND m.org_id  = nullif(current_setting('app.tenant_id', true), '')
    ));
