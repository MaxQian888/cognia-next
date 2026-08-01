ALTER TABLE upload_parts
    ADD COLUMN artifact_kind text NOT NULL DEFAULT 'attachment'
        CHECK (artifact_kind IN ('manifest', 'events', 'attachment', 'minidump', 'screenshot'));

ALTER TABLE incidents
    ADD COLUMN processing_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN next_processing_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN failure_code text,
    ADD COLUMN grouping_basis jsonb,
    ADD COLUMN raw_stack jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN symbolized_stack jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN missing_symbols text[] NOT NULL DEFAULT '{}',
    ADD COLUMN accepted_at timestamptz;

ALTER TABLE incident_groups
    ADD COLUMN fingerprint_version text NOT NULL DEFAULT 'fingerprint-v1',
    ADD COLUMN compatible_build_family text NOT NULL DEFAULT '',
    ADD COLUMN platform text NOT NULL DEFAULT '',
    ADD COLUMN exception text NOT NULL DEFAULT '',
    ADD COLUMN module text NOT NULL DEFAULT '',
    ADD COLUMN top_frames jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN incident_count bigint NOT NULL DEFAULT 0,
    ADD COLUMN first_seen_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incidents
    ADD COLUMN group_id uuid REFERENCES incident_groups(id) ON DELETE SET NULL;

ALTER TABLE symbols
    ADD COLUMN relative_path text NOT NULL DEFAULT '',
    ADD COLUMN symbol_type text NOT NULL DEFAULT 'breakpad'
        CHECK (symbol_type IN ('breakpad', 'pdb', 'dsym', 'elf', 'android_mapping', 'android_native', 'source_map')),
    ADD COLUMN indexed_at timestamptz;

CREATE TABLE alert_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
    group_id uuid REFERENCES incident_groups(id) ON DELETE CASCADE,
    alert_kind text NOT NULL CHECK (alert_kind IN (
        'new_regression', 'crash_spike', 'missing_symbols', 'upload_failure',
        'storage_failure', 'processing_backlog'
    )),
    transport text NOT NULL CHECK (transport IN ('webhook', 'smtp', 'otel')),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error_code text,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX incidents_processing_due_idx
    ON incidents (tenant_id, next_processing_at, created_at)
    WHERE processing_state IN ('received', 'retryable_failure');
CREATE INDEX incidents_group_idx ON incidents (tenant_id, project_id, group_id);
CREATE INDEX alert_deliveries_due_idx
    ON alert_deliveries (tenant_id, next_attempt_at)
    WHERE state IN ('pending', 'failed');

ALTER TABLE alert_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_alert_deliveries ON alert_deliveries
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
