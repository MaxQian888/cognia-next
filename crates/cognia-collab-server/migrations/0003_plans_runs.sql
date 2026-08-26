-- Plans and Runs on the collaboration plane — ADR-0149 §6, Batch 7c.
--
-- Issues answer "what should happen". These answer "what is happening, and who
-- is doing it" — the two questions a board cannot answer on its own once more
-- than one person works in the same workspace.
--
-- ## What travels, and what deliberately does not
--
-- A local `AgentPlan` (ADR-0045) carries its execution machinery: step params
-- with absolute paths, tool inputs, MCP server ids, a `sessionId`, a
-- `generationId` race guard, an unbounded `metadata` bag. None of that is here.
-- `0002_workspaces.sql` refused the same class of field for the same reason —
-- shipping one machine's paths across the plane invites a client to act on
-- somebody else's checkout — and a race guard for a driver running on another
-- laptop is meaningless to a reader besides.
--
-- What travels is what a colleague can read and act on: the title, the ordered
-- steps, how far along it is, and who started it.
--
-- ## Runs attach to something, or to nothing
--
-- `issue_id` and `plan_id` are both nullable and neither is required. A run
-- with no subject is a real state — an ad-hoc dispatch in a workspace — and it
-- still answers the question the workspace-wide "N agents working" pill asks.
-- That is why `title` is NOT nullable instead: a dispatcher who cannot name
-- what they dispatched has published a row no colleague can read.
--
-- Deliberately absent: the engine-native `target_id`. An AgentTask id on Ada's
-- laptop names nothing on Bob's, so mirroring it would ship a column that is
-- unresolvable the moment it arrives.

CREATE TABLE IF NOT EXISTS plans (
    id              text   PRIMARY KEY,
    org_id          text   NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id    text   NOT NULL,
    title           text   NOT NULL,
    description     text,
    status          text   NOT NULL,
    -- Denormalised, and recomputed by the server from `plan_steps` on every
    -- write. Two clients reporting different progress for the same steps is a
    -- disagreement with no tiebreak, so the client's numbers are never stored.
    total_steps     integer NOT NULL DEFAULT 0,
    completed_steps integer NOT NULL DEFAULT 0,
    created_by_kind text   NOT NULL CHECK (created_by_kind IN ('human', 'agent', 'team')),
    created_by_id   text   NOT NULL,
    created_at      bigint NOT NULL,
    updated_at      bigint NOT NULL,
    ended_at        bigint
);
CREATE INDEX IF NOT EXISTS plans_org_workspace ON plans (org_id, workspace_id);

CREATE TABLE IF NOT EXISTS plan_steps (
    id           text   PRIMARY KEY,
    org_id       text   NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    plan_id      text   NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    step_order   integer NOT NULL,
    title        text   NOT NULL,
    description  text,
    kind         text   NOT NULL,
    status       text   NOT NULL,
    -- The short human-readable outcome, the same field the local step carries.
    -- Its raw `output` does not travel: an arbitrary structured blob has no
    -- redaction boundary anybody can state.
    result       text,
    error        text,
    started_at   bigint,
    completed_at bigint
);
CREATE INDEX IF NOT EXISTS plan_steps_plan ON plan_steps (plan_id, step_order);

CREATE TABLE IF NOT EXISTS runs (
    id              text   PRIMARY KEY,
    org_id          text   NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workspace_id    text   NOT NULL,
    -- Both optional; see the header note. `plan_id` cascades because a deleted
    -- plan's runs describe a thing that no longer exists, while `issue_id` is
    -- left as a plain column so a run outlives an issue that was tidied away.
    issue_id        text,
    plan_id         text   REFERENCES plans(id) ON DELETE CASCADE,
    title           text   NOT NULL,
    kind            text   NOT NULL,
    status          text   NOT NULL,
    started_by_kind text   NOT NULL CHECK (started_by_kind IN ('human', 'agent', 'team')),
    started_by_id   text   NOT NULL,
    started_at      bigint NOT NULL,
    updated_at      bigint NOT NULL,
    ended_at        bigint,
    summary         text,
    error           text
);
CREATE INDEX IF NOT EXISTS runs_org_workspace ON runs (org_id, workspace_id, started_at);
CREATE INDEX IF NOT EXISTS runs_issue         ON runs (org_id, issue_id);
CREATE INDEX IF NOT EXISTS runs_plan          ON runs (org_id, plan_id);

-- A produced thing worth linking: a PR, a branch, a build.
--
-- Its own table rather than a jsonb column so the one rule that matters here is
-- a database constraint instead of a comment: only http(s) links travel. A
-- `file:///Users/ada/…` href is broken on a colleague's screen at best, and at
-- worst it publishes the shape of Ada's home directory to everyone in the org.
CREATE TABLE IF NOT EXISTS run_artifacts (
    id       text   PRIMARY KEY,
    org_id   text   NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    run_id   text   NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    label    text   NOT NULL,
    href     text   NOT NULL,
    CONSTRAINT run_artifacts_href_is_web
        CHECK (href LIKE 'http://%' OR href LIKE 'https://%')
);
CREATE INDEX IF NOT EXISTS run_artifacts_run ON run_artifacts (run_id);

-- ── Row-level security ───────────────────────────────────────────────────────
--
-- FORCE so the table owner is not exempt, exactly as in 0001 and 0002: the
-- application connects as the owner, and ENABLE alone would leave every policy
-- below silently inert.

ALTER TABLE plans         ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans         FORCE  ROW LEVEL SECURITY;
ALTER TABLE plan_steps    ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_steps    FORCE  ROW LEVEL SECURITY;
ALTER TABLE runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs          FORCE  ROW LEVEL SECURITY;
ALTER TABLE run_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_artifacts FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plans_tenant_isolation ON plans;
CREATE POLICY plans_tenant_isolation ON plans
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));

-- `plan_steps` and `run_artifacts` carry their own `org_id` rather than
-- reaching through their parent. A policy that joined to the parent would be
-- correct and slower, and it would also stop being correct the day somebody
-- adds a child row before its parent inside one transaction.
DROP POLICY IF EXISTS plan_steps_tenant_isolation ON plan_steps;
CREATE POLICY plan_steps_tenant_isolation ON plan_steps
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));

DROP POLICY IF EXISTS runs_tenant_isolation ON runs;
CREATE POLICY runs_tenant_isolation ON runs
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));

DROP POLICY IF EXISTS run_artifacts_tenant_isolation ON run_artifacts;
CREATE POLICY run_artifacts_tenant_isolation ON run_artifacts
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));
