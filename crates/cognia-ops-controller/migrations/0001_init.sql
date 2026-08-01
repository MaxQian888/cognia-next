CREATE TABLE IF NOT EXISTS deployment_targets (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    config JSONB NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    production_certified BOOLEAN NOT NULL DEFAULT FALSE,
    certification_issues TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS operations (
    id UUID PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    request JSONB NOT NULL DEFAULT '{}',
    result JSONB,
    error JSONB,
    created_by TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS operations_queue_idx
    ON operations (state, created_at);
CREATE INDEX IF NOT EXISTS operations_target_idx
    ON operations (tenant_id, target_id, state);

CREATE TABLE IF NOT EXISTS target_operation_locks (
    tenant_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    lease_owner TEXT NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, target_id)
);

CREATE TABLE IF NOT EXISTS operation_events (
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL,
    state TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_leases (
    token_hash TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    target_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS server_reports (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    topology TEXT NOT NULL,
    public_url TEXT NOT NULL,
    health TEXT NOT NULL DEFAULT 'unknown',
    release_digest TEXT,
    last_seen_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS recovery_points (
    tenant_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, target_id, id)
);

CREATE TABLE IF NOT EXISTS log_entries (
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    level TEXT NOT NULL,
    component TEXT NOT NULL,
    message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS log_entries_target_idx
    ON log_entries (tenant_id, target_id, id DESC);

CREATE TABLE IF NOT EXISTS audit_events (
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT,
    operation_id UUID,
    detail JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_enrollment_tokens (
    token_hash TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deploy_agents (
    agent_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    certificate_fingerprint TEXT NOT NULL UNIQUE,
    certificate_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, target_id, agent_id)
);

CREATE OR REPLACE FUNCTION append_operation_event() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state THEN
        INSERT INTO operation_events (tenant_id, operation_id, target_id, state, message)
        VALUES (NEW.tenant_id, NEW.id, NEW.target_id, NEW.state, 'operation ' || NEW.state);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operations_append_event ON operations;
CREATE TRIGGER operations_append_event
AFTER INSERT OR UPDATE OF state ON operations
FOR EACH ROW EXECUTE FUNCTION append_operation_event();
