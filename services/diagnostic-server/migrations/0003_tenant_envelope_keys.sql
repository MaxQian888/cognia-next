CREATE TABLE tenant_keys (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_version integer NOT NULL CHECK (key_version > 0),
    wrapped_dek bytea NOT NULL,
    kms_key_id text NOT NULL,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired', 'destroyed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    retired_at timestamptz,
    destroyed_at timestamptz,
    PRIMARY KEY (tenant_id, key_version)
);

CREATE UNIQUE INDEX tenant_keys_one_active_idx
    ON tenant_keys (tenant_id) WHERE state = 'active';

ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_envelope_keys ON tenant_keys
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
