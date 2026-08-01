CREATE TYPE incident_state AS ENUM (
    'detected', 'packaged', 'awaiting_consent', 'queued', 'uploading',
    'processing', 'accepted', 'rejected', 'cancelled', 'deleted'
);

CREATE TYPE processing_state AS ENUM (
    'received', 'scanning', 'symbolicating', 'grouping', 'accepted',
    'retryable_failure', 'permanent_failure', 'deleted'
);

CREATE TABLE tenants (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    retention_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
    raw_minidump_access_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name text NOT NULL,
    installation_quota_bytes bigint NOT NULL DEFAULT 10737418240,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);

CREATE TABLE incidents (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    installation_id text NOT NULL,
    artifact_hash char(64) NOT NULL,
    build_id text NOT NULL,
    platform text NOT NULL,
    module text NOT NULL,
    exception text NOT NULL,
    client_state incident_state NOT NULL DEFAULT 'queued',
    processing_state processing_state NOT NULL DEFAULT 'received',
    support_code text NOT NULL DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
    fingerprint text,
    deletion_credential_hash char(64),
    consent_withdrawn_at timestamptz,
    deletion_scheduled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
    UNIQUE (tenant_id, project_id, artifact_hash),
    UNIQUE (tenant_id, support_code)
);

CREATE TABLE upload_parts (
    tenant_id uuid NOT NULL,
    incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
    object_key text NOT NULL,
    source_sha256 char(64) NOT NULL,
    stored_sha256 char(64) NOT NULL,
    stored_bytes bigint NOT NULL CHECK (stored_bytes >= 0),
    redaction_version text NOT NULL,
    removed_fields text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, incident_id, part_number)
);

CREATE TABLE anonymous_nonces (
    tenant_id uuid NOT NULL,
    nonce text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, nonce)
);

CREATE TABLE incident_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    fingerprint text NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'suppressed', 'resolved')),
    assigned_to text,
    regression_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, project_id, fingerprint),
    FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE symbols (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    build_id text NOT NULL,
    platform text NOT NULL,
    object_key text NOT NULL,
    sha256 char(64) NOT NULL,
    status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'indexed', 'rejected')),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, project_id, build_id, platform, sha256),
    FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE retention_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
    object_key text,
    execute_after timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'complete', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    action text NOT NULL,
    incident_id uuid,
    actor_id text,
    reason text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit events are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE INDEX incidents_processing_idx ON incidents (tenant_id, processing_state, updated_at);
CREATE INDEX incidents_fingerprint_idx ON incidents (tenant_id, project_id, fingerprint);
CREATE INDEX retention_due_idx ON retention_jobs (state, execute_after) WHERE state = 'pending';
CREATE INDEX symbols_build_idx ON symbols (tenant_id, project_id, build_id, platform);
CREATE INDEX anonymous_nonces_expiry_idx ON anonymous_nonces (expires_at);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE anonymous_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE symbols ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE projects FORCE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
ALTER TABLE upload_parts FORCE ROW LEVEL SECURITY;
ALTER TABLE anonymous_nonces FORCE ROW LEVEL SECURITY;
ALTER TABLE incident_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE symbols FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_projects ON projects
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_incidents ON incidents
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_upload_parts ON upload_parts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_anonymous_nonces ON anonymous_nonces
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_groups ON incident_groups
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_symbols ON symbols
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_retention ON retention_jobs
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_audit ON audit_events
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
