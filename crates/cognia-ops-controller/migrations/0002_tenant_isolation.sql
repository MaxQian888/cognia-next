-- ADR-0149 §8 — row-level security for the operations controller.
--
-- Every table already carried `tenant_id`, and every query already filtered on
-- it. That is the problem this migration fixes: isolation depended entirely on
-- application code being correct, so one forgotten `WHERE tenant_id = $1` in
-- any of ~30 statements served another tenant's servers, logs and operations.
-- After this, the database refuses rather than the reviewer.
--
-- FORCE, not just ENABLE. Without it the table owner is exempt, and the
-- controller connects as the owner — every policy below would be silently off
-- and this file would be theatre.
--
-- `tenant_id` here is TEXT, not a UUID. Do not add a `::uuid` cast copied from
-- `services/diagnostic-server`: a non-UUID tenant would raise per row, which
-- turns a clean deny into a 500.
--
-- The `app.cross_tenant` escape exists for the three places RLS cannot answer,
-- each named at its call site in `store.rs`:
--
--   * `consume_enrollment` and `authenticate_agent` are credential lookups —
--     the caller presents a secret and the ROW tells it which tenant it is in,
--     so the tenant is the output of the query, not an input to it.
--   * `requeue_expired_leases` is a global sweep whose whole job is to be
--     cross-tenant.
--
-- Everything else runs inside `tenant_transaction`, which binds
-- `app.tenant_id` transaction-locally. Transaction-locally is load-bearing: a
-- session-level setting on a pooled connection outlives the request and leaks
-- the previous caller's tenant into the next one — and it fails OPEN.

ALTER TABLE deployment_targets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_registrations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_operation_locks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_leases            ENABLE ROW LEVEL SECURITY;
ALTER TABLE server_reports          ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_points         ENABLE ROW LEVEL SECURITY;
ALTER TABLE log_entries             ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_enrollment_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE deploy_agents           ENABLE ROW LEVEL SECURITY;

ALTER TABLE deployment_targets      FORCE ROW LEVEL SECURITY;
ALTER TABLE target_registrations    FORCE ROW LEVEL SECURITY;
ALTER TABLE operations              FORCE ROW LEVEL SECURITY;
ALTER TABLE target_operation_locks  FORCE ROW LEVEL SECURITY;
ALTER TABLE operation_events        FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_leases            FORCE ROW LEVEL SECURITY;
ALTER TABLE server_reports          FORCE ROW LEVEL SECURITY;
ALTER TABLE recovery_points         FORCE ROW LEVEL SECURITY;
ALTER TABLE log_entries             FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events            FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_enrollment_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE deploy_agents           FORCE ROW LEVEL SECURITY;

-- One predicate, repeated. `current_setting(…, true)` returns NULL when the
-- setting was never bound, and `tenant_id = NULL` is NULL — so a statement that
-- forgot to open a scoped transaction sees nothing rather than everything.
CREATE OR REPLACE FUNCTION ops_tenant_visible(candidate text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT candidate = nullif(current_setting('app.tenant_id', true), '')
        OR nullif(current_setting('app.cross_tenant', true), '') = 'on'
$$;

DROP POLICY IF EXISTS tenant_deployment_targets ON deployment_targets;
CREATE POLICY tenant_deployment_targets ON deployment_targets
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_target_registrations ON target_registrations;
CREATE POLICY tenant_target_registrations ON target_registrations
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_operations ON operations;
CREATE POLICY tenant_operations ON operations
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_target_operation_locks ON target_operation_locks;
CREATE POLICY tenant_target_operation_locks ON target_operation_locks
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_operation_events ON operation_events;
CREATE POLICY tenant_operation_events ON operation_events
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_admin_leases ON admin_leases;
CREATE POLICY tenant_admin_leases ON admin_leases
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_server_reports ON server_reports;
CREATE POLICY tenant_server_reports ON server_reports
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_recovery_points ON recovery_points;
CREATE POLICY tenant_recovery_points ON recovery_points
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_log_entries ON log_entries;
CREATE POLICY tenant_log_entries ON log_entries
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_audit_events ON audit_events;
CREATE POLICY tenant_audit_events ON audit_events
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_agent_enrollment_tokens ON agent_enrollment_tokens;
CREATE POLICY tenant_agent_enrollment_tokens ON agent_enrollment_tokens
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));

DROP POLICY IF EXISTS tenant_deploy_agents ON deploy_agents;
CREATE POLICY tenant_deploy_agents ON deploy_agents
    USING (ops_tenant_visible(tenant_id))
    WITH CHECK (ops_tenant_visible(tenant_id));
