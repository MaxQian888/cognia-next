-- Deployment configuration, deliberately outside tenant RLS. The migrator
-- revokes application writes after its blanket grants on every boot.
CREATE TABLE IF NOT EXISTS deployment_feature_policies (
    feature_key text PRIMARY KEY,
    revision bigint NOT NULL CHECK (revision > 0),
    document jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text NOT NULL,
    reason text NOT NULL,
    operation_id text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS deployment_feature_policy_audit (
    id uuid PRIMARY KEY,
    feature_key text NOT NULL,
    old_revision bigint NOT NULL,
    new_revision bigint NOT NULL CHECK (new_revision = old_revision + 1),
    operation_id text NOT NULL UNIQUE,
    principal text NOT NULL,
    reason text NOT NULL,
    summary jsonb NOT NULL CHECK (octet_length(summary::text) <= 4096),
    -- Retain the applied configuration so a replay after later revisions
    -- returns the original result. The summary contains only changed field
    -- names and a request digest, never unbounded allow/deny-list diffs.
    document jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION deployment_feature_audit_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'deployment_feature_policy_audit is append-only';
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'deployment_feature_policy_audit'::regclass
          AND tgname = 'deployment_feature_audit_append_only') THEN
        CREATE TRIGGER deployment_feature_audit_append_only
        BEFORE UPDATE OR DELETE OR TRUNCATE ON deployment_feature_policy_audit
        FOR EACH STATEMENT EXECUTE FUNCTION deployment_feature_audit_append_only();
    END IF;
END $$;
