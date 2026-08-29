-- Tenant relationship hardening.
--
-- This migration deliberately refuses to guess when historical rows disagree.
-- Operators get the exact offending identifiers from the preflight exception
-- and can repair them before retrying the idempotent migration.

DO $$
DECLARE offending text;
BEGIN
    SELECT string_agg(logto_organization_id, ', ' ORDER BY logto_organization_id)
      INTO offending
      FROM (
        SELECT logto_organization_id
          FROM orgs
         WHERE logto_organization_id IS NOT NULL
         GROUP BY logto_organization_id
        HAVING count(*) > 1
      ) duplicates;
    IF offending IS NOT NULL THEN
        RAISE EXCEPTION 'duplicate Logto organization mappings: %', offending;
    END IF;

    SELECT string_agg(wm.org_id || '/' || wm.workspace_id || '/' || wm.user_id, ', ')
      INTO offending
      FROM workspace_memberships wm
      LEFT JOIN workspaces w
        ON w.org_id = wm.org_id AND w.id = wm.workspace_id
     WHERE w.id IS NULL;
    IF offending IS NOT NULL THEN
        RAISE EXCEPTION 'workspace memberships without a same-tenant workspace: %', offending;
    END IF;

    SELECT string_agg(resource, ', ')
      INTO offending
      FROM (
        SELECT 'issue:' || i.org_id || '/' || i.id AS resource
          FROM issues i LEFT JOIN workspaces w
            ON w.org_id = i.org_id AND w.id = i.workspace_id
         WHERE w.id IS NULL
        UNION ALL
        SELECT 'plan:' || p.org_id || '/' || p.id
          FROM plans p LEFT JOIN workspaces w
            ON w.org_id = p.org_id AND w.id = p.workspace_id
         WHERE w.id IS NULL
        UNION ALL
        SELECT 'run:' || r.org_id || '/' || r.id
          FROM runs r LEFT JOIN workspaces w
            ON w.org_id = r.org_id AND w.id = r.workspace_id
         WHERE w.id IS NULL
        UNION ALL
        SELECT 'chat:' || c.org_id || '/' || c.id
          FROM chat_sessions c LEFT JOIN workspaces w
            ON w.org_id = c.org_id AND w.id = c.workspace_id
         WHERE w.id IS NULL
      ) invalid_resources;
    IF offending IS NOT NULL THEN
        RAISE EXCEPTION 'tenant resources without a same-tenant workspace: %', offending;
    END IF;

    SELECT string_agg('event:' || e.org_id || '/' || e.id, ', ')
      INTO offending
      FROM issue_events e
      JOIN issues i ON i.id = e.issue_id
     WHERE i.org_id <> e.org_id;
    IF offending IS NOT NULL THEN
        RAISE EXCEPTION 'cross-tenant issue event relationships: %', offending;
    END IF;

    SELECT string_agg('step:' || s.org_id || '/' || s.id, ', ')
      INTO offending
      FROM plan_steps s
      JOIN plans p ON p.id = s.plan_id
     WHERE p.org_id <> s.org_id;
    IF offending IS NOT NULL THEN
        RAISE EXCEPTION 'cross-tenant plan step relationships: %', offending;
    END IF;

    SELECT string_agg('artifact:' || a.org_id || '/' || a.id, ', ')
      INTO offending
      FROM run_artifacts a
      JOIN runs r ON r.id = a.run_id
     WHERE r.org_id <> a.org_id;
    IF offending IS NOT NULL THEN
        RAISE EXCEPTION 'cross-tenant run artifact relationships: %', offending;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS orgs_logto_organization_unique
    ON orgs (logto_organization_id)
    WHERE logto_organization_id IS NOT NULL;

-- The old key allowed the same workspace id in two orgs to collide. Carry the
-- tenant in both the key and every conflict target.
ALTER TABLE workspace_memberships DROP CONSTRAINT IF EXISTS workspace_memberships_pkey;
ALTER TABLE workspace_memberships
    ADD CONSTRAINT workspace_memberships_pkey
    PRIMARY KEY (org_id, workspace_id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS issues_org_id_unique ON issues (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS plans_org_id_unique ON plans (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS runs_org_id_unique ON runs (org_id, id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_memberships_workspace_fk') THEN
        ALTER TABLE workspace_memberships
            ADD CONSTRAINT workspace_memberships_workspace_fk
            FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces(org_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issues_workspace_fk') THEN
        ALTER TABLE issues
            ADD CONSTRAINT issues_workspace_fk
            FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces(org_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_events_issue_fk') THEN
        ALTER TABLE issue_events DROP CONSTRAINT IF EXISTS issue_events_issue_id_fkey;
        ALTER TABLE issue_events
            ADD CONSTRAINT issue_events_issue_fk
            FOREIGN KEY (org_id, issue_id) REFERENCES issues(org_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_workspace_fk') THEN
        ALTER TABLE plans
            ADD CONSTRAINT plans_workspace_fk
            FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces(org_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_steps_plan_fk') THEN
        ALTER TABLE plan_steps DROP CONSTRAINT IF EXISTS plan_steps_plan_id_fkey;
        ALTER TABLE plan_steps
            ADD CONSTRAINT plan_steps_plan_fk
            FOREIGN KEY (org_id, plan_id) REFERENCES plans(org_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_workspace_fk') THEN
        ALTER TABLE runs
            ADD CONSTRAINT runs_workspace_fk
            FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces(org_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_plan_fk') THEN
        ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_plan_id_fkey;
        ALTER TABLE runs
            ADD CONSTRAINT runs_plan_fk
            FOREIGN KEY (org_id, plan_id) REFERENCES plans(org_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_artifacts_run_fk') THEN
        ALTER TABLE run_artifacts DROP CONSTRAINT IF EXISTS run_artifacts_run_id_fkey;
        ALTER TABLE run_artifacts
            ADD CONSTRAINT run_artifacts_run_fk
            FOREIGN KEY (org_id, run_id) REFERENCES runs(org_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_sessions_workspace_fk') THEN
        ALTER TABLE chat_sessions
            ADD CONSTRAINT chat_sessions_workspace_fk
            FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces(org_id, id) ON DELETE CASCADE;
    END IF;
END $$;

-- The shared-chat cut introduced the append-only authorization audit table.
-- Extend it so org/workspace administration can retain the full decision
-- context without creating a second audit stream.
ALTER TABLE authorization_audit_events
    ADD COLUMN IF NOT EXISTS target_user_id text,
    ADD COLUMN IF NOT EXISTS invitation_id text,
    ADD COLUMN IF NOT EXISTS old_role text,
    ADD COLUMN IF NOT EXISTS new_role text,
    ADD COLUMN IF NOT EXISTS request_id text,
    ADD COLUMN IF NOT EXISTS grant_id text,
    ADD COLUMN IF NOT EXISTS source jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS authz_audit_org_time
    ON authorization_audit_events (org_id, created_at DESC, id DESC);
