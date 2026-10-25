//! Admission only: cached standing expires no later than five seconds after
//! the lookup started, including negative results. Revocation lands at the
//! next admission past that bound; run fencing stays in the collab server.
#![allow(clippy::result_large_err)]

use std::{collections::HashMap, sync::Arc, time::{Duration, Instant}};

use axum::http::StatusCode;
use cognia_problem::Problem;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::{deployment::{deployment_mode, DeploymentMode}, middleware::DeviceContext};
use crate::host_surface_policy::{SurfaceClass, POLICY};
use cognia_external_agent::spawn_authority::{ExecutionAdmission, PlacementBinding};

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct Person { pub org: String, pub user: String }

#[derive(Clone, Debug)]
pub struct Refusal { pub status: StatusCode, pub code: &'static str }

fn forbidden(code: &'static str) -> Refusal { Refusal { status: StatusCode::FORBIDDEN, code } }
fn unavailable(code: &'static str) -> Refusal { Refusal { status: StatusCode::SERVICE_UNAVAILABLE, code } }

#[async_trait::async_trait]
pub trait StandingProvider: Send + Sync {
    fn person(&self, principal: &DeviceContext) -> Result<Person, Refusal>;
    async fn actions(&self, person: &Person, workspace: Option<&str>) -> Result<Vec<String>, Refusal>;
    /// P6d execution must see departures immediately, without the admission cache.
    async fn person_execution_actions(&self, person: &Person) -> Result<Vec<String>, Refusal> { self.actions(person, None).await }
}

type CacheKey = (Person, Option<String>);
type CacheValue = (Instant, Result<Vec<String>, Refusal>);
const CACHE_LIMIT: usize = 1024;
const CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Default)]
struct AdmissionCache { entries: HashMap<CacheKey, CacheValue> }

impl AdmissionCache {
    fn get(&self, key: &CacheKey, now: Instant) -> Option<Result<Vec<String>, Refusal>> {
        self.entries.get(key).filter(|(at, _)| now.saturating_duration_since(*at) < CACHE_TTL)
            .map(|(_, result)| result.clone())
    }

    fn insert(&mut self, key: CacheKey, started: Instant, now: Instant, result: Result<Vec<String>, Refusal>) {
        self.entries.retain(|_, (at, _)| now.saturating_duration_since(*at) < CACHE_TTL);
        // A slow lookup must neither extend the TTL nor overwrite fresher
        // standing from a concurrent admission for the same principal.
        if now.saturating_duration_since(started) >= CACHE_TTL
            || self.entries.get(&key).is_some_and(|(at, _)| *at > started) { return; }
        if self.entries.len() >= CACHE_LIMIT && !self.entries.contains_key(&key) {
            if let Some(oldest) = self.entries.iter().min_by_key(|(_, (at, _))| *at).map(|(key, _)| key.clone()) {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(key, (started, result));
    }
}

struct LiveStanding { cache: Mutex<AdmissionCache> }
static LIVE: Lazy<Arc<LiveStanding>> = Lazy::new(|| Arc::new(LiveStanding { cache: Mutex::new(AdmissionCache::default()) }));

#[async_trait::async_trait]
impl StandingProvider for LiveStanding {
    async fn person_execution_actions(&self, person: &Person) -> Result<Vec<String>, Refusal> {
        crate::workspace_access::standing_actions(&person.org, None, &person.user).await.map_err(map_authority_error)
    }
    fn person(&self, principal: &DeviceContext) -> Result<Person, Refusal> {
        let store = crate::security_store::security_store()
            .ok_or_else(|| forbidden("host_principal_unbound"))?;
        bound_device_person(&store, principal)
    }

    async fn actions(&self, person: &Person, workspace: Option<&str>) -> Result<Vec<String>, Refusal> {
        let key = (person.clone(), workspace.map(str::to_string));
        let started = Instant::now();
        if let Some(result) = self.cache.lock().get(&key, started) {
            return result;
        }
        let result = crate::workspace_access::standing_actions(&person.org, workspace, &person.user)
            .await.map_err(map_authority_error);
        // Measure from request START, so a slow upstream never extends stale
        // authority by its latency. In-flight requests are not single-flighted.
        self.cache.lock().insert(key, started, Instant::now(), result.clone());
        result
    }
}

fn bound_device_person(
    store: &crate::security_store::SecurityStore,
    principal: &DeviceContext,
) -> Result<Person, Refusal> {
    let unbound = || forbidden("host_principal_unbound");
    // Management routes label a DPoP-proved device as owner. That label does
    // not give it the loopback service principal's authority.
    if !matches!(principal.scope.as_str(), "device" | "owner") {
        return Err(unbound());
    }
    let binding = store
        .active_oidc_device_person(&principal.tenant_id, &principal.device_id)
        .map_err(|_| unbound())?
        .ok_or_else(unbound)?;
    Ok(Person {
        org: binding.org_id.to_string(),
        user: binding.user_id.to_string(),
    })
}

fn map_authority_error(error: crate::workspace_access::WorkspaceAccessError) -> Refusal {
    use crate::workspace_access::WorkspaceAccessError::*;
    match error {
        Unauthorized | Upstream { status: 400..=499 } => forbidden("host_surface_forbidden"),
        InvalidTarget(_) => forbidden("workspace_unresolved"),
        _ => unavailable("host_authority_unavailable"),
    }
}

/// The only exception to skipping new checks in single-user mode is an
/// operator explicitly disabling execution. Invalid settings also refuse.
pub fn execution_enabled() -> bool {
    let value = match std::env::var("COGNIA_EXECUTION") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => return false,
    };
    cognia_environment::policy::ExecutionSetting::parse(value.as_deref())
        .is_ok_and(|setting| setting == cognia_environment::policy::ExecutionSetting::Enabled)
}

pub fn execution_available() -> bool {
    availability(deployment_mode(), execution_enabled(), crate::environment_pool::installed().is_some())
}

/// P6d probes the local driver only; remote providers cannot attest mounts.
pub async fn person_execution_available() -> bool {
    if !execution_enabled() { return false; }
    let Some(pool) = crate::environment_pool::installed() else { return false; };
    let status = match pool.providers.as_ref() {
        Some(providers) => match providers.member("local") {
            Some(local) => local.status.clone(),
            None => return false,
        },
        None => pool.status.clone(),
    };
    let Ok(Ok(tiers)) = tokio::time::timeout(Duration::from_secs(10), status.available_tiers()).await else { return false; };
    if !person_execution_tiers(true, Some(&tiers)) { return false; }
    tokio::task::spawn_blocking(move || {
        use cognia_sandbox_pool::admission::SandboxAdmission;
        crate::environment_pool::person_environment_spec(&pool.admission).is_ok_and(|spec| pool.admission.recheck(&spec, &tiers).is_ok())
    }).await.unwrap_or(false)
}
pub fn person_execution_tiers(enabled: bool, tiers: Option<&[cognia_environment::spec::IsolationTier]>) -> bool {
    enabled && tiers.is_some_and(|tiers| tiers.iter().any(|tier| *tier >= cognia_environment::spec::IsolationTier::Gvisor))
}
pub async fn person_execution_standing(person: &crate::person_partition::PersonPartition) -> Result<(), Problem> {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(result) = person_standing_test_support::get(&person.org_id) { return result; }
    LIVE.person_execution_actions(&Person { org: person.org_id.clone(), user: person.user_id.clone() }).await
        .map(|_| ()).map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))
}

#[cfg(any(test, feature = "test-support"))]
pub mod person_standing_test_support {
    use super::*;
    static RESULTS: Lazy<Mutex<HashMap<String, Option<&'static str>>>> = Lazy::new(Default::default);
    pub struct Installed(String);
    impl Installed {
        pub fn new(org: &str) -> Self { RESULTS.lock().insert(org.into(), None); Self(org.into()) }
        pub fn refuse(&self, code: &'static str) { RESULTS.lock().insert(self.0.clone(), Some(code)); }
    }
    impl Drop for Installed { fn drop(&mut self) { RESULTS.lock().remove(&self.0); } }
    pub(super) fn get(org: &str) -> Option<Result<(), Problem>> {
        RESULTS.lock().get(org).map(|code| match code {
            Some(code) => Err(Problem::with_status(StatusCode::FORBIDDEN, *code, *code)), None => Ok(()),
        })
    }
}

/// P6e lifecycle hooks captured at spawn. The exact generation is compared
/// before renewal/revocation, so delayed exits cannot retire replacements.
struct PersonExecutionLease {
    binding: PlacementBinding,
    keep: Arc<dyn Fn() -> bool + Send + Sync>,
    revoke: Arc<dyn Fn() + Send + Sync>,
}
static PERSON_EXECUTION_LEASES: Lazy<Mutex<HashMap<String, PersonExecutionLease>>> = Lazy::new(Default::default);
pub fn person_execution_lease_bind(id: &str, binding: &PlacementBinding,
    keep: Arc<dyn Fn() -> bool + Send + Sync>, revoke: Arc<dyn Fn() + Send + Sync>) -> Result<(), &'static str> {
    let mut leases = PERSON_EXECUTION_LEASES.lock();
    if leases.contains_key(id) { return Err("credential_delivery_refused"); }
    leases.insert(id.into(), PersonExecutionLease { binding: binding.clone(), keep, revoke });
    Ok(())
}
pub fn person_execution_lease_refresh(id: &str, binding: &PlacementBinding) -> bool {
    let keep = PERSON_EXECUTION_LEASES.lock().get(id).filter(|lease| lease.binding == *binding).map(|lease| lease.keep.clone());
    keep.is_some_and(|keep| keep())
}
pub fn person_execution_lease_revoke(id: &str, binding: &PlacementBinding) {
    let lease = {
        let mut leases = PERSON_EXECUTION_LEASES.lock();
        if leases.get(id).is_some_and(|lease| lease.binding == *binding) { leases.remove(id) } else { None }
    };
    if let Some(lease) = lease { (lease.revoke)(); }
}

/// P6d ownership is derived from a Host binding, never from event/request ids.
pub fn person_execution_owner(binding: &PlacementBinding) -> Option<crate::person_partition::PersonPartition> {
    let person = crate::person_partition::PersonPartition::new(binding.org_id.clone(), binding.actor_user_id.clone());
    (binding.workspace_id == format!("person:{}", person.account_id)).then_some(person)
}
/// Serializes partition execution with purge. Weak slots do not retain accounts.
pub fn person_execution_lock(account: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: Lazy<Mutex<HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>> = Lazy::new(Default::default);
    let mut locks = LOCKS.lock();
    locks.retain(|_, lock| lock.strong_count() != 0);
    let lock = locks.get(account).and_then(std::sync::Weak::upgrade).unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
    locks.insert(account.into(), Arc::downgrade(&lock));
    lock
}

/// P6d purge and RPC controls share the same agent-id fence. A persisted
/// record alone cannot authorize killing a replacement owned by someone else.
pub fn person_execution_run_lock(id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: Lazy<Mutex<HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>> = Lazy::new(Default::default);
    let mut locks = LOCKS.lock();
    locks.retain(|_, lock| lock.strong_count() != 0);
    let lock = locks.get(id).and_then(std::sync::Weak::upgrade).unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
    locks.insert(id.into(), Arc::downgrade(&lock));
    lock
}

fn availability(mode: DeploymentMode, enabled: bool, sandboxes: bool) -> bool {
    enabled && (mode == DeploymentMode::SingleUser || sandboxes)
}

pub async fn authorize(capability: &str, arm: Option<&str>, principal: &DeviceContext, workspace: Option<&str>) -> Result<(), Problem> {
    authorize_entry(capability, arm, false, principal, workspace).await
}

/// Stream adapters can launch work without a manifest descriptor (PTY/ACP).
/// Their explicit execution flag does not make observation capabilities
/// execution-wide; the main events/RPC carrier stays available.
/// Direct browser/ACP execution has no Host-bound placement and is inert on
/// multi-tenant Hosts until a sandbox-aware socket adapter exists (Rule 7).
pub async fn authorize_channel(capability: &str, execution: bool, principal: &DeviceContext) -> Result<(), Problem> {
    authorize_entry(capability, None, execution, principal, None).await
}

async fn authorize_entry(capability: &str, arm: Option<&str>, execution_channel: bool,
    principal: &DeviceContext, workspace: Option<&str>) -> Result<(), Problem> {
    let enabled = execution_enabled();
    let result = if channel_execution_refused(deployment_mode(), enabled, execution_channel) {
        Err(unavailable("execution_isolation_unavailable"))
    } else {
        decide(deployment_mode(), enabled, crate::environment_pool::installed().is_some(),
            LIVE.as_ref(), capability, arm, principal, workspace).await
    };
    if let Err(refusal) = &result {
        crate::audit::record_async("host_surface_authorize", &principal.device_id, &principal.scope, "deny",
            json!({ "capability": capability, "arm": arm, "code": refusal.code })).await;
    }
    result.map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))
}

fn channel_execution_refused(mode: DeploymentMode, enabled: bool, execution: bool) -> bool {
    execution && (!enabled || mode == DeploymentMode::MultiTenant)
}

pub async fn decide(mode: DeploymentMode, execution: bool, sandboxes: bool, provider: &dyn StandingProvider,
    capability: &str, arm: Option<&str>, principal: &DeviceContext, workspace: Option<&str>) -> Result<(), Refusal> {
    if capability == crate::org_policy::CAPABILITY {
        return org_policy_standing(mode, provider, principal).await.map(|_| ());
    }
    // No policy parse, identity/store read or provider call on the legacy path.
    if mode == DeploymentMode::SingleUser && execution { return Ok(()); }
    decide_with_person_fleet(mode, execution, sandboxes, provider, capability, arm, principal, workspace,
        crate::person_partition::fleet().is_some()).await
}

async fn org_policy_standing(mode: DeploymentMode, provider: &dyn StandingProvider, principal: &DeviceContext) -> Result<Option<Person>, Refusal> {
    if mode != DeploymentMode::MultiTenant { return Err(Refusal { status: StatusCode::CONFLICT, code: "org_scope_unavailable" }); }
    if crate::jwt::is_service_scope(Some(&principal.scope)) { return Ok(None); }
    let person = provider.person(principal)?;
    let actions = provider.actions(&person, None).await?;
    if !actions.iter().any(|action| action == "org.policy.manage") { return Err(forbidden("host_surface_forbidden")); }
    Ok(Some(person))
}

pub async fn org_policy_person(principal: &DeviceContext) -> Result<Person, Problem> {
    org_policy_standing(deployment_mode(), LIVE.as_ref(), principal).await
        .and_then(|person| person.ok_or_else(|| forbidden("host_principal_unbound")))
        .map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))
}

#[allow(clippy::too_many_arguments)]
async fn decide_with_person_fleet(mode: DeploymentMode, execution: bool, sandboxes: bool, provider: &dyn StandingProvider,
    capability: &str, arm: Option<&str>, principal: &DeviceContext, workspace: Option<&str>, person_fleet: bool) -> Result<(), Refusal> {
    if principal.scope == "person-brain" {
        return crate::person_chat::person_caller(principal, arm.unwrap_or_default()).map(|_| ())
            .map_err(|_| forbidden("host_surface_forbidden"));
    }
    // No policy parse, identity/store read or provider call on the legacy path.
    if mode == DeploymentMode::SingleUser && execution { return Ok(()); }
    let policy = POLICY.as_ref().map_err(|_| forbidden("host_surface_forbidden"))?;
    let entry = policy.get(capability)
        .ok_or_else(|| forbidden("host_surface_forbidden"))?;
    if !execution && policy.command_executes(capability, arm) {
        return Err(unavailable("execution_isolation_unavailable"));
    }
    if mode == DeploymentMode::SingleUser { return Ok(()); }
    // P5d is deliberately separate from commandOverrides: this data standing
    // applies only to tenant devices on a Host that can actually partition it.
    if person_fleet && !crate::jwt::is_service_scope(Some(principal.scope.as_ref()))
        && arm.is_some_and(|arm| policy.person_host_state_capability(arm).is_some()) {
        person_data_standing(provider, principal).await?;
        return Ok(());
    }
    let entry = arm.and_then(|arm| policy.command_overrides.get(arm)).unwrap_or(entry);
    let (action, workspace) = match entry.class {
        SurfaceClass::Client => return Ok(()),
        SurfaceClass::HostData => {
            if crate::jwt::is_service_scope(Some(principal.scope.as_ref())) { return Ok(()); }
            if !person_fleet { return Err(forbidden("host_data_unpartitioned")); }
            person_data_standing(provider, principal).await?;
            if arm.is_some_and(|arm| policy.person_model_commands.iter().any(|entry| entry.arm == arm)) {
                return Err(unavailable("model_access_unavailable"));
            }
            return Ok(());
        },
        SurfaceClass::OperatorOnly => return if crate::jwt::is_service_scope(Some(principal.scope.as_ref())) { Ok(()) } else { Err(forbidden("host_surface_forbidden")) },
        SurfaceClass::OrgAction => (entry.action.as_deref(), None),
        // Raw workspace actions retain their org fallback; never use a renderer id here.
        SurfaceClass::WorkspaceAction => (entry.fallback_org_action.as_deref(), None),
        SurfaceClass::SandboxedExecution => {
            if !sandboxes { return Err(unavailable("execution_isolation_unavailable")); }
            let workspace = workspace.filter(|workspace| !workspace.trim().is_empty())
                .ok_or_else(|| forbidden("workspace_unresolved"))?;
            // P4 binds mounts/placement to this admitted workspace and actor.
            (Some("execution.request"), Some(workspace))
        }
    };
    let action = action.ok_or_else(|| forbidden("host_surface_forbidden"))?;
    let person = provider.person(principal)?;
    let actions = provider.actions(&person, workspace).await?;
    if actions.iter().any(|value| value == action) { Ok(()) } else { Err(forbidden("host_surface_forbidden")) }
}

/// A successful org-only lookup is live non-guest standing: the collaboration
/// authority refuses workspace/session-only guests. Members may have zero org
/// management actions; requiring an action here would exclude ordinary members.
async fn person_data_standing(provider: &dyn StandingProvider, principal: &DeviceContext) -> Result<Person, Refusal> {
    let person = provider.person(principal)?;
    provider.actions(&person, None).await?;
    Ok(person)
}

/// Operation reads have no command args. Re-resolve the current verified
/// person and standing rather than trusting the receipt's historical device.
pub(crate) async fn operation_person(principal: &DeviceContext) -> Result<Option<crate::person_partition::PersonPartition>, Problem> {
    if deployment_mode() == DeploymentMode::SingleUser || crate::jwt::is_service_scope(Some(principal.scope.as_ref())) { return Ok(None); }
    let person = person_data_standing(LIVE.as_ref(), principal).await
        .map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))?;
    Ok(Some(crate::person_partition::PersonPartition::new(person.org, person.user)))
}

pub async fn person_partition(capability: &str, command: &str, principal: &DeviceContext)
    -> Result<Option<crate::person_partition::PersonPartition>, Problem> {
    if principal.scope == "person-brain" {
        return crate::person_chat::person_caller(principal, command).map(Some);
    }
    if deployment_mode() == DeploymentMode::SingleUser || crate::jwt::is_service_scope(Some(principal.scope.as_ref())) { return Ok(None); }
    let policy = POLICY.as_ref().map_err(|_| Problem::with_status(StatusCode::FORBIDDEN, "host_surface_forbidden", "invalid Host policy"))?;
    let partition_host_state = crate::person_partition::fleet().is_some()
        && policy.person_host_state_capability(command).is_some();
    if policy.command_overrides.contains_key(command)
        || (!partition_host_state && !policy.get(capability).is_some_and(|entry| entry.class == SurfaceClass::HostData)) { return Ok(None); }
    // The normal gate already checked standing. Reuse its bounded cache and
    // derive authority only from the verified binding, never from args.
    let person = person_data_standing(LIVE.as_ref(), principal).await
        .map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))?;
    Ok(Some(crate::person_partition::PersonPartition::new(person.org, person.user)))
}

/// Legacy explicit browser scopes, retained for single-user compatibility.
/// Multi-tenant execution uses execution_workspace and Host record lookup;
/// a generic workspaceId on a later request never grants authority.
pub fn command_workspace<'a>(command: &str, args: &'a Value) -> Option<&'a str> {
    match command {
        // browser_gateway::dispatch reads this exact field for both commands.
        "browser_session_ensure" | "browser_profile_delete" => args.get("workspaceId")?.as_str(),
        _ => None,
    }
}

/// Host-owned execution records. Brain-owned sessions, workflow runs, goals,
/// rooms and tasks deliberately have no resolver here: their execution is
/// still in the Host process and remains inert in multi-tenant mode (Rule 7).
pub trait ExecutionBindingLookup: Send + Sync {
    fn binding(&self, id: &str) -> Result<Option<PlacementBinding>, Refusal>;
}

fn record_id<'a>(command: &str, args: &'a Value) -> Option<&'a str> {
    match command {
        "spawn_external_agent" => args.pointer("/config/id")?.as_str(),
        "environment_task_shell_exec" => args.get("owner")?.as_str(),
        "get_external_agent_status" | "send_to_external_agent" | "kill_external_agent" =>
            args.get("agent_id").or_else(|| args.get("agentId"))?.as_str(),
        _ => None,
    }
}

fn record_key(command: &str, id: &str) -> String {
    format!("{}:{id}", if command == "environment_task_shell_exec" { "task-shell" } else { "external-agent" })
}

fn record_command(command: &str) -> bool {
    matches!(command, "get_external_agent_status" | "send_to_external_agent" | "kill_external_agent")
}

/// Host-brain arms on a multi-tenant Host. Pool availability never makes Host
/// JS/sidecar code isolated, so an arm that launches work stays inert for every
/// principal; no client id can lift this. A non-executing arm
/// (`nonExecutionCommands`: ownership leases, settings, state flags) called by
/// the loopback service principal is the Host's own brain managing its own
/// runtime (the connector runtime lease is required for readiness). Tenant
/// callers have no workspace to resolve it against.
fn host_brain_refusal(executes: bool, service: bool) -> Option<Refusal> {
    if executes { return Some(unavailable("execution_isolation_unavailable")); }
    if service { return None; }
    Some(forbidden("workspace_unresolved"))
}

fn host_brain_execution(capability: &str, command: &str) -> bool {
    (POLICY.as_ref().ok().and_then(|policy| policy.get(capability))
        .is_some_and(|entry| entry.class == SurfaceClass::SandboxedExecution) && !record_command(command))
        || matches!(command, "external_agent_admit_run" | "external_agent_run_turn" | "external_agent_cancel_run"
            | "external_agent_release_run" | "external_agent_resolve_decision")
}

/// Pure resolution: creation alone consumes workspaceId; every subsequent
/// operation ignores it and reads the immutable Host record instead.
pub fn execution_workspace(command: &str, args: &Value, lookup: &dyn ExecutionBindingLookup)
    -> Result<Option<String>, Refusal> {
    if matches!(command, "spawn_external_agent" | "environment_task_shell_exec") {
        return Ok(args.get("workspaceId").and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty()).map(str::to_owned));
    }
    match record_id(command, args) {
        Some(id) => Ok(lookup.binding(&record_key(command, id))?.map(|binding| binding.workspace_id)),
        None => Ok(None),
    }
}

/// Stored beside the Host's other companion state. Only a successful Host
/// creation can replace an execution generation; controls never change it.
struct ExecutionBindings(std::path::PathBuf);
static BINDING_WRITER: Mutex<()> = Mutex::new(());
const EXECUTION_BINDING_LIMIT: usize = 1024;
const EXECUTION_BINDING_BYTES: u64 = 2 * 1024 * 1024;
impl ExecutionBindings {
    fn read(&self) -> Result<HashMap<String, PlacementBinding>, Refusal> {
        match std::fs::File::open(&self.0) {
            Ok(file) => {
                use std::io::Read;
                let mut bytes = Vec::new();
                file.take(EXECUTION_BINDING_BYTES + 1).read_to_end(&mut bytes)
                    .map_err(|_| unavailable("execution_binding_store_unavailable"))?;
                if bytes.len() as u64 > EXECUTION_BINDING_BYTES { return Err(unavailable("execution_binding_store_full")); }
                serde_json::from_slice(&bytes).map_err(|_| unavailable("execution_binding_store_unavailable"))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(_) => Err(unavailable("execution_binding_store_unavailable")),
        }
    }
    fn insert(&self, id: &str, binding: &PlacementBinding) -> Result<(), Refusal> {
        let _guard = BINDING_WRITER.lock();
        let mut records = self.read()?;
        if let Some(existing) = records.get(id) {
            if existing == binding { return Ok(()); }
            if existing.org_id != binding.org_id || existing.workspace_id != binding.workspace_id
                || existing.actor_user_id != binding.actor_user_id { return Err(forbidden("execution_binding_exists")); }
        } else if records.len() >= EXECUTION_BINDING_LIMIT {
            return Err(unavailable("execution_binding_store_full"));
        }
        records.insert(id.to_owned(), binding.clone());
        self.write(&records)
    }
    fn remove(&self, id: &str, expected: &PlacementBinding) -> Result<(), Refusal> {
        let _guard = BINDING_WRITER.lock();
        let mut records = self.read()?;
        // An old exit/kill must never remove a newer generation with this id.
        if records.get(id) != Some(expected) { return Ok(()); }
        records.remove(id);
        self.write(&records)
    }
    fn write(&self, records: &HashMap<String, PlacementBinding>) -> Result<(), Refusal> {
        let bytes = serde_json::to_vec(records).map_err(|_| unavailable("execution_binding_store_unavailable"))?;
        if bytes.len() as u64 > EXECUTION_BINDING_BYTES { return Err(unavailable("execution_binding_store_full")); }
        let parent = self.0.parent().ok_or_else(|| unavailable("execution_binding_store_unavailable"))?;
        std::fs::create_dir_all(parent).map_err(|_| unavailable("execution_binding_store_unavailable"))?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| unavailable("execution_binding_store_unavailable"))?;
        use std::io::Write;
        file.write_all(&bytes)
            .and_then(|_| file.as_file().sync_all()).map_err(|_| unavailable("execution_binding_store_unavailable"))?;
        file.persist(&self.0).map_err(|_| unavailable("execution_binding_store_unavailable"))?;
        Ok(())
    }
}
impl ExecutionBindingLookup for ExecutionBindings {
    fn binding(&self, id: &str) -> Result<Option<PlacementBinding>, Refusal> {
        Ok(self.read()?.remove(id))
    }
}
impl ExecutionBindingLookup for HashMap<String, PlacementBinding> {
    fn binding(&self, id: &str) -> Result<Option<PlacementBinding>, Refusal> {
        Ok(self.get(id).cloned())
    }
}

/// The mount root is a separate Host authority from a caller's workspaceId.
/// First assignment requires the existing Host-global administration action;
/// ordinary execution permission never assigns an arbitrary Host directory.
struct WorkspaceMounts { path: std::path::PathBuf, base: Option<std::path::PathBuf> }
impl WorkspaceMounts {
    fn new(path: std::path::PathBuf, base: Option<std::path::PathBuf>) -> Self {
        Self { path, base }
    }
    fn read(&self) -> Result<HashMap<String, String>, Refusal> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| unavailable("execution_binding_store_unavailable")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(_) => Err(unavailable("execution_binding_store_unavailable")),
        }
    }
    fn key(decision: &ExecutionAdmission) -> String {
        serde_json::to_string(&(&decision.binding.org_id, &decision.binding.workspace_id)).expect("identity serializes")
    }
    #[cfg(test)]
    fn authorize(&self, decision: &ExecutionAdmission, cwd: &str) -> Result<(), Refusal> {
        self.authorized_root(decision, cwd).map(|_| ())
    }
    fn authorized_root(&self, decision: &ExecutionAdmission, cwd: &str) -> Result<std::path::PathBuf, Refusal> {
        if let Some(person) = person_execution_owner(&decision.binding) {
            let directory = self.path.parent().and_then(std::path::Path::parent).ok_or_else(|| unavailable("execution_binding_store_unavailable"))?;
            let policy = cognia_external_agent::presets::SpawnPolicy::from_env(directory);
            let root = cognia_external_agent::person_workspace::person_workspace_path(&policy, &person.account_id)
                .map_err(|_| forbidden("workspace_mount_forbidden"))?;
            let canonical = root.canonicalize().map_err(|_| forbidden("workspace_mount_forbidden"))?;
            let base = policy.workspaces_dir().canonicalize().map_err(|_| forbidden("workspace_mount_forbidden"))?;
            if canonical != base.join("persons").join(&person.account_id) { return Err(forbidden("workspace_mount_forbidden")); }
            cognia_external_agent::person_workspace::person_workspace_cwd(&canonical, Some(cwd))
                .map_err(|_| forbidden("workspace_mount_forbidden"))?;
            return Ok(canonical);
        }
        let base = self.base.as_ref().ok_or_else(|| forbidden("workspace_root_unconfigured"))?
            .canonicalize().map_err(|_| forbidden("workspace_root_unconfigured"))?;
        if !base.is_dir() { return Err(forbidden("workspace_root_unconfigured")); }
        let supplied = std::path::Path::new(cwd);
        let cwd = supplied.canonicalize().map_err(|_| forbidden("workspace_mount_forbidden"))?;
        // The operator base itself cannot be claimed by an org administrator.
        if cwd == base || !cwd.starts_with(&base) || cwd != supplied || !cwd.is_dir() { return Err(forbidden("workspace_mount_forbidden")); }
        let roots = self.read()?;
        let key = Self::key(decision);
        if roots.iter().any(|(other, root)| other != &key
            && (cwd.starts_with(root) || std::path::Path::new(root).starts_with(&cwd))) {
            return Err(forbidden("workspace_root_claimed"));
        }
        match roots.get(&key) {
            // The driver mounts cwd itself. Accepting an arbitrary child
            // would let a writable sibling replace it with a symlink between
            // canonicalization and the daemon's bind. Mount the assigned root.
            Some(root) if cwd == std::path::Path::new(root) => Ok(cwd),
            Some(_) => Err(forbidden("workspace_mount_forbidden")),
            None if decision.has("host.global-surfaces") => Ok(cwd),
            None => Err(forbidden("workspace_unresolved")),
        }
    }
    fn persist(&self, decision: &ExecutionAdmission, cwd: &str) -> Result<(), Refusal> {
        let _guard = BINDING_WRITER.lock();
        let canonical = self.authorized_root(decision, cwd)?;
        let mut roots = self.read()?;
        let key = Self::key(decision);
        if roots.contains_key(&key) { return Ok(()); }
        roots.insert(key, canonical.to_string_lossy().into_owned());
        let parent = self.path.parent().ok_or_else(|| unavailable("execution_binding_store_unavailable"))?;
        std::fs::create_dir_all(parent).map_err(|_| unavailable("execution_binding_store_unavailable"))?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| unavailable("execution_binding_store_unavailable"))?;
        use std::io::Write;
        file.write_all(&serde_json::to_vec(&roots).map_err(|_| unavailable("execution_binding_store_unavailable"))?)
            .and_then(|_| file.as_file().sync_all()).map_err(|_| unavailable("execution_binding_store_unavailable"))?;
        file.persist(&self.path).map_err(|_| unavailable("execution_binding_store_unavailable"))?;
        Ok(())
    }
}

/// `cwd` must be the canonical path returned by Host SpawnPolicy, never the
/// caller's raw path. Checks run before staging/probing/starting a container.
pub async fn authorize_execution_mount(state: &crate::SharedState, cwd: &str) -> Result<(), Problem> {
    let Some(decision) = cognia_external_agent::spawn_authority::execution_admission() else { return Ok(()); };
    let root = state.runtime.execution_binding_root(state);
    let base = state.runtime.execution_workspace_base(state);
    let cwd = cwd.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        root.ok_or_else(|| unavailable("execution_binding_store_unavailable"))
            // Claim under the writer lock BEFORE a container can see the path.
            // Concurrent org creations cannot both run before one loses CAS.
            .and_then(|root| WorkspaceMounts::new(root.join("companion/workspace-mounts.json"), base).persist(&decision, &cwd))
    }).await.unwrap_or_else(|_| Err(unavailable("execution_binding_store_unavailable")));
    result.map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))
}

async fn resolve_execution_admission(provider: &dyn StandingProvider, lookup: &dyn ExecutionBindingLookup,
    command: &str, args: &Value, principal: &DeviceContext) -> Result<ExecutionAdmission, Refusal> {
    if args.pointer("/config/sandbox/binding").is_some() || args.pointer("/placement/binding").is_some() {
        return Err(forbidden("placement_binding_client_supplied"));
    }
    if principal.scope == "person-brain" {
        let person = crate::person_chat::person_caller(principal, command).map_err(|_| forbidden("host_surface_forbidden"))?;
        return person_resolve_execution(provider, lookup, command, args, &person).await;
    }
    let workspace = execution_workspace(command, args, lookup)?.ok_or_else(|| forbidden("workspace_unresolved"))?;
    let person = provider.person(principal)?;
    let id = record_id(command, args).filter(|id| !id.is_empty()).ok_or_else(|| forbidden("workspace_unresolved"))?;
    let existing = lookup.binding(&record_key(command, id))?;
    let creating = matches!(command, "spawn_external_agent" | "environment_task_shell_exec");
    let binding = match existing {
        Some(binding) => {
            // A device/operator may never take control of a personal run.
            if person_execution_owner(&binding).is_some() { return Err(forbidden("host_surface_forbidden")); }
            if binding.org_id != person.org || (creating && (binding.workspace_id != workspace || binding.actor_user_id != person.user)) {
                return Err(forbidden("execution_binding_exists"));
            }
            if creating { PlacementBinding { run_id: uuid::Uuid::new_v4().to_string(), ..binding } } else { binding }
        }
        None if creating => PlacementBinding { org_id: person.org.clone(), workspace_id: workspace.clone(), actor_user_id: person.user.clone(), run_id: uuid::Uuid::new_v4().to_string() },
        None => return Err(forbidden("workspace_unresolved")),
    };
    // Actor B uses B's current standing, never A's historical permissions.
    let actions = provider.actions(&person, Some(&workspace)).await?;
    let admission = ExecutionAdmission { binding, actions };
    admission.workspace_read_only().map_err(forbidden)?;
    Ok(admission)
}

async fn person_resolve_execution(provider: &dyn StandingProvider, lookup: &dyn ExecutionBindingLookup,
    command: &str, args: &Value, person: &crate::person_partition::PersonPartition) -> Result<ExecutionAdmission, Refusal> {
    provider.person_execution_actions(&Person { org: person.org_id.clone(), user: person.user_id.clone() }).await?;
    let id = record_id(command, args).filter(|id| !id.is_empty()).ok_or_else(|| forbidden("workspace_unresolved"))?;
    let existing = lookup.binding(&record_key(command, id))?;
    if existing.as_ref().is_some_and(|binding| person_execution_owner(binding).as_ref() != Some(person)) {
        return Err(forbidden("host_surface_forbidden"));
    }
    let binding = if command == "spawn_external_agent" {
        PlacementBinding { org_id: person.org_id.clone(), workspace_id: format!("person:{}", person.account_id),
            actor_user_id: person.user_id.clone(), run_id: uuid::Uuid::new_v4().to_string() }
    } else { existing.ok_or_else(|| forbidden("host_surface_forbidden"))? };
    Ok(ExecutionAdmission { binding, actions: vec!["execution.request".into(), "workspace.write".into(), "credential.use".into()] })
}

/// Called only after sandbox creation succeeds. A failed spawn must not bind
/// a pre-existing legacy process that happened to use the same record id.
pub async fn persist_execution_binding(state: &crate::SharedState, command: &str, args: &Value, cwd: &str) -> Result<(), Problem> {
    let Some(decision) = cognia_external_agent::spawn_authority::execution_admission() else { return Ok(()); };
    if !matches!(command, "spawn_external_agent" | "environment_task_shell_exec") { return Ok(()); }
    // Capture typed authority before crossing the task-local boundary.
    let directory = state.runtime.execution_binding_root(state);
    let base = state.runtime.execution_workspace_base(state);
    let key = record_id(command, args).map(|id| record_key(command, id));
    let cwd = cwd.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        let directory = directory.ok_or_else(|| unavailable("execution_binding_store_unavailable"))?;
        let key = key.ok_or_else(|| forbidden("workspace_unresolved"))?;
        WorkspaceMounts::new(directory.join("companion/workspace-mounts.json"), base).persist(&decision, &cwd)?;
        ExecutionBindings(directory.join("companion/execution-bindings.json"))
            .insert(&key, &decision.binding)
    }).await.unwrap_or_else(|_| Err(unavailable("execution_binding_store_unavailable")));
    result.map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))
}

/// Host lifecycle cleanup uses the exact generation captured at spawn. This
/// synchronous helper belongs on a blocking worker, including event callbacks.
pub fn forget_execution_record(directory: &std::path::Path, command: &str, id: &str, expected: &PlacementBinding) -> Result<(), Problem> {
    // Terminal status/reaping may be observed without an exit callback. Retire
    // the exact run's ticket even if persistence cleanup subsequently fails.
    person_execution_lease_revoke(id, expected);
    ExecutionBindings(directory.join("companion/execution-bindings.json")).remove(&record_key(command, id), expected)
        .map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))
}

pub async fn forget_execution_binding(state: &crate::SharedState, command: &str, id: &str) -> Result<(), Problem> {
    let Some(decision) = cognia_external_agent::spawn_authority::execution_admission() else { return Ok(()); };
    let directory = state.runtime.execution_binding_root(state);
    let command = command.to_owned(); let id = id.to_owned();
    tokio::task::spawn_blocking(move || {
        let directory = directory.ok_or_else(|| Problem::with_status(StatusCode::SERVICE_UNAVAILABLE, "execution_binding_store_unavailable", "execution binding directory unavailable"))?;
        forget_execution_record(&directory, &command, &id, &decision.binding)
    }).await.unwrap_or_else(|_| Err(Problem::with_status(StatusCode::SERVICE_UNAVAILABLE, "execution_binding_store_unavailable", "execution binding cleanup failed")))
}

/// Reconcile orphaned records after backend reaping/restart, before admitting
/// another creation. Snapshot generations make concurrent exits/replacements
/// safe; a failed lookup never deletes an active generation by id alone.
pub async fn prune_execution_records(directory: std::path::PathBuf, backend: Arc<dyn cognia_external_agent::exec_backend::ExecBackend>) -> Result<(), Problem> {
    let root = directory.clone();
    let records = tokio::task::spawn_blocking(move || ExecutionBindings(root.join("companion/execution-bindings.json")).read())
        .await.unwrap_or_else(|_| Err(unavailable("execution_binding_store_unavailable")))
        .map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))?;
    let mut retired = Vec::new();
    for (key, binding) in records {
        if let Some(id) = key.strip_prefix("external-agent:") {
            use cognia_external_agent::process::ExternalAgentProcessState::{Stopped, Failed};
            if matches!(backend.status(id).await, None | Some(Stopped | Failed)) { retired.push((key, binding)); }
        }
    }
    tokio::task::spawn_blocking(move || {
        let store = ExecutionBindings(directory.join("companion/execution-bindings.json"));
        for (key, binding) in retired {
            if let Some(id) = key.strip_prefix("external-agent:") { person_execution_lease_revoke(id, &binding); }
            store.remove(&key, &binding)?;
        }
        Ok(())
    }).await.unwrap_or_else(|_| Err(unavailable("execution_binding_store_unavailable")))
        .map_err(|refusal: Refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))
}

/// P6d purge holds person_execution_lock. Kill through the same backend and
/// wait for terminal state before removing any directory or authority record.
pub async fn person_stop_execution(directory: Option<&std::path::Path>, person: &crate::person_partition::PersonPartition,
    backend: &dyn cognia_external_agent::exec_backend::ExecBackend, timeout: Duration) -> Result<usize, &'static str> {
    tokio::time::timeout(timeout, async {
        let records = match directory {
            Some(directory) => ExecutionBindings(directory.join("companion/execution-bindings.json")).read().map_err(|_| "person_brain_unavailable")?,
            None => HashMap::new(),
        };
        let mut ids: std::collections::HashSet<String> = records.iter().filter(|(_, binding)| person_execution_owner(binding).as_ref() == Some(person))
            .filter_map(|(key, _)| key.strip_prefix("external-agent:").map(str::to_owned)).collect();
        // Cover an early exit/creation whose persistence was interrupted too.
        for id in backend.list().await {
            let info = backend.get_info(&id).await.map_err(|_| "person_brain_busy")?;
            if info.pointer("/placement/binding").cloned().and_then(|value| serde_json::from_value::<PlacementBinding>(value).ok())
                .and_then(|binding| person_execution_owner(&binding)).as_ref() == Some(person) { ids.insert(id); }
        }
        let count = ids.len();
        use cognia_external_agent::process::ExternalAgentProcessState::{Stopped, Failed};
        for id in ids {
            let _run = person_execution_run_lock(&id).lock_owned().await;
            let mut lease_binding = PERSON_EXECUTION_LEASES.lock().get(&id)
                .filter(|lease| person_execution_owner(&lease.binding).as_ref() == Some(person)).map(|lease| lease.binding.clone())
                .or_else(|| records.get(&format!("external-agent:{id}")).cloned());
            if !matches!(backend.status(&id).await, None | Some(Stopped | Failed)) {
                let info = backend.get_info(&id).await.map_err(|_| "person_brain_busy")?;
                let binding = info.pointer("/placement/binding").cloned()
                    .and_then(|value| serde_json::from_value::<PlacementBinding>(value).ok());
                if binding.as_ref().and_then(person_execution_owner).as_ref() != Some(person) { return Err("person_brain_busy"); }
                lease_binding = binding;
                backend.kill(&id).await.map_err(|_| "person_brain_busy")?;
            }
            while !matches!(backend.status(&id).await, None | Some(Stopped | Failed)) {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            if let Some(binding) = lease_binding { person_execution_lease_revoke(&id, &binding); }
        }
        Ok(count)
    }).await.map_err(|_| "person_brain_busy")?
}

pub fn person_remove_execution_records(directory: &std::path::Path, person: &crate::person_partition::PersonPartition) -> Result<(), &'static str> {
    let _guard = BINDING_WRITER.lock();
    let store = ExecutionBindings(directory.join("companion/execution-bindings.json"));
    let mut records = store.read().map_err(|_| "person_brain_unavailable")?;
    records.retain(|_, binding| person_execution_owner(binding).as_ref() != Some(person));
    store.write(&records).map_err(|_| "person_brain_unavailable")?;
    let mounts = WorkspaceMounts::new(directory.join("companion/workspace-mounts.json"), None);
    let mut roots = mounts.read().map_err(|_| "person_brain_unavailable")?;
    roots.remove(&serde_json::to_string(&(&person.org_id, format!("person:{}", person.account_id))).map_err(|_| "person_brain_unavailable")?);
    let parent = mounts.path.parent().ok_or("person_brain_unavailable")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "person_brain_unavailable")?;
    use std::io::Write;
    file.write_all(&serde_json::to_vec(&roots).map_err(|_| "person_brain_unavailable")?)
        .and_then(|_| file.as_file().sync_all()).map_err(|_| "person_brain_unavailable")?;
    file.persist(&mounts.path).map_err(|_| "person_brain_unavailable")?;
    Ok(())
}

/// Admission for the two container dispatch paths and their recorded controls.
/// The typed decision is scoped over dispatch; it never enters request args.
pub async fn authorize_execution(state: &crate::SharedState, capability: &str, command: &str,
    principal: &DeviceContext, args: &Value) -> Result<Option<ExecutionAdmission>, Problem> {
    // P6d execution arms take partition admission; P6c remains tool-less.
    if principal.scope == "person-brain" {
        crate::person_chat::person_caller(principal, command)?;
        if !matches!(command, "spawn_external_agent" | "get_external_agent_status" | "kill_external_agent" | "send_to_external_agent") {
            return Ok(None);
        }
        if command == "spawn_external_agent" && args.pointer("/config/sandbox").is_some() {
            return Err(Problem::with_status(StatusCode::FORBIDDEN, "placement_client_supplied", "placement_client_supplied"));
        }
        if command == "spawn_external_agent" && !person_execution_available().await {
            return Err(Problem::with_status(StatusCode::SERVICE_UNAVAILABLE, "execution_isolation_unavailable", "execution_isolation_unavailable"));
        }
        let result = async {
            let directory = state.runtime.execution_binding_root(state).ok_or_else(|| unavailable("execution_binding_store_unavailable"))?;
            let store = tokio::task::spawn_blocking(move || ExecutionBindings(directory.join("companion/execution-bindings.json")).read())
                .await.map_err(|_| unavailable("execution_binding_store_unavailable"))??;
            if command == "spawn_external_agent" && store.len() >= EXECUTION_BINDING_LIMIT { return Err(unavailable("execution_binding_store_full")); }
            resolve_execution_admission(LIVE.as_ref(), &store, command, args, principal).await.map(Some)
        }.await;
        return result.map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code));
    }
    if deployment_mode() == DeploymentMode::SingleUser {
        authorize(capability, Some(command), principal, command_workspace(command, args)).await?;
        return Ok(None);
    }
    POLICY.as_ref().map_err(|_| Problem::with_status(StatusCode::FORBIDDEN, "host_surface_forbidden", "invalid Host policy"))?;
    let container = matches!(command, "spawn_external_agent" | "environment_task_shell_exec");
    let recorded = record_command(command);
    let brain = host_brain_execution(capability, command);
    if !container && !recorded && !brain {
        authorize(capability, Some(command), principal, command_workspace(command, args)).await?;
        return Ok(None);
    }
    let result = async {
        let service = crate::jwt::is_service_scope(Some(principal.scope.as_ref()));
        if command == "environment_task_shell_exec" && service {
            return Err(unavailable("execution_isolation_unavailable"));
        }
        if brain {
            let executes = POLICY.as_ref().is_ok_and(|policy| policy.command_executes(capability, Some(command)));
            return host_brain_refusal(executes, service).map_or(Ok(None), Err);
        }
        if !execution_enabled() || crate::environment_pool::installed().is_none() {
            return Err(unavailable("execution_isolation_unavailable"));
        }
        if container {
            state.runtime.prune_execution_bindings(state).await
                .map_err(|problem| unavailable(if problem.code == "execution_binding_store_full" { "execution_binding_store_full" } else { "execution_binding_store_unavailable" }))?;
        }
        let directory = state.runtime.execution_binding_root(state).ok_or_else(|| unavailable("execution_binding_store_unavailable"))?;
        let store = tokio::task::spawn_blocking(move || {
            ExecutionBindings(directory.join("companion/execution-bindings.json")).read()
        }).await.map_err(|_| unavailable("execution_binding_store_unavailable"))??;
        if container && store.len() >= EXECUTION_BINDING_LIMIT
            && !record_id(command, args).is_some_and(|id| store.contains_key(&record_key(command, id))) {
            return Err(unavailable("execution_binding_store_full"));
        }
        resolve_execution_admission(LIVE.as_ref(), &store, command, args, principal).await.map(Some)
    }.await;
    if let Err(refusal) = &result {
        crate::audit::record_async("host_surface_authorize", &principal.device_id, &principal.scope, "deny",
            json!({ "capability": capability, "arm": command, "code": refusal.code })).await;
    }
    result.map_err(|refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn p6e_run_lease_hooks_compare_generation_and_revoke_once() {
        let first = PlacementBinding { org_id:"org_p6e_hooks".into(),workspace_id:"person:p6e".into(),actor_user_id:"usr_p6e".into(),run_id:"first".into() };
        let second = PlacementBinding { run_id:"second".into(),..first.clone() };
        let revoked = Arc::new(AtomicUsize::new(0)); let hit = revoked.clone();
        person_execution_lease_bind("p6e-hooks",&first,Arc::new(|| true),Arc::new(move || { hit.fetch_add(1,Ordering::SeqCst); })).unwrap();
        assert!(person_execution_lease_refresh("p6e-hooks",&first));
        assert!(!person_execution_lease_refresh("p6e-hooks",&second));
        person_execution_lease_revoke("p6e-hooks",&second); assert_eq!(revoked.load(Ordering::SeqCst),0);
        person_execution_lease_revoke("p6e-hooks",&first); person_execution_lease_revoke("p6e-hooks",&first);
        assert_eq!(revoked.load(Ordering::SeqCst),1);
        assert!(!person_execution_lease_refresh("p6e-hooks",&first));
    }

    #[tokio::test]
    async fn p6e_terminal_record_cleanup_revokes_run_lease_without_exit_callback() {
        for reaped in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let id = format!("p6e-terminal-{reaped}");
            let binding = PlacementBinding { org_id:"org_p6e_terminal".into(), workspace_id:"person:p6e".into(),
                actor_user_id:"usr_p6e_terminal".into(), run_id:id.clone() };
            let store = ExecutionBindings(root.path().join("companion/execution-bindings.json"));
            store.insert(&format!("external-agent:{id}"), &binding).unwrap();
            let revoked = Arc::new(AtomicUsize::new(0));
            let hit = revoked.clone();
            person_execution_lease_bind(&id, &binding, Arc::new(|| true), Arc::new(move || { hit.fetch_add(1, Ordering::SeqCst); })).unwrap();
            if reaped {
                prune_execution_records(root.path().into(), Arc::new(cognia_external_agent::exec_backend::DisabledExecBackend)).await.unwrap();
            } else {
                forget_execution_record(root.path(), "get_external_agent_status", &id, &binding).unwrap();
            }
            assert_eq!(revoked.load(Ordering::SeqCst), 1, "reaped={reaped}");
            assert!(!person_execution_lease_refresh(&id, &binding));
            assert!(store.read().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn p6d_partition_admission_fences_foreign_runs_and_rechecks_standing() {
        struct PersonStanding(std::sync::atomic::AtomicBool);
        #[async_trait::async_trait]
        impl StandingProvider for PersonStanding {
            fn person(&self, _: &DeviceContext) -> Result<Person, Refusal> { panic!("must not resolve a device"); }
            async fn actions(&self, _: &Person, workspace: Option<&str>) -> Result<Vec<String>, Refusal> {
                assert!(workspace.is_none());
                if self.0.load(Ordering::SeqCst) { Ok(vec![]) } else { Err(forbidden("host_surface_forbidden")) }
            }
        }
        let provider = PersonStanding(std::sync::atomic::AtomicBool::new(true));
        let a = crate::person_partition::PersonPartition::new("org_p6d_gate".into(), "usr_p6d_a".into());
        let b = crate::person_partition::PersonPartition::new(a.org_id.clone(), "usr_p6d_b".into());
        let mut records = HashMap::new();
        let args = json!({"config":{"id":"p6d-agent"},"workspaceId":"foreign-workspace"});
        let decision = person_resolve_execution(&provider, &records, "spawn_external_agent", &args, &a).await.unwrap();
        assert_eq!(decision.binding.org_id, a.org_id);
        assert_eq!(decision.binding.actor_user_id, a.user_id);
        assert_eq!(decision.binding.workspace_id, format!("person:{}", a.account_id));
        assert!(!decision.binding.run_id.is_empty());
        assert_eq!(decision.workspace_read_only(), Ok(false));
        assert!(decision.has("credential.use"));
        records.insert("external-agent:p6d-agent".into(), decision.binding.clone());
        for command in ["get_external_agent_status", "kill_external_agent"] {
            let args = json!({"agentId":"p6d-agent","workspaceId":"forged"});
            assert_eq!(person_resolve_execution(&provider, &records, command, &args, &a).await.unwrap().binding, decision.binding);
            assert_eq!(person_resolve_execution(&provider, &records, command, &args, &b).await.unwrap_err().code, "host_surface_forbidden");
        }
        provider.0.store(false, Ordering::SeqCst);
        assert_eq!(person_resolve_execution(&provider, &records, "spawn_external_agent", &args, &a).await.unwrap_err().code, "host_surface_forbidden");
    }

    #[test]
    fn p6d_execution_requires_enabled_local_gvisor_tier() {
        use cognia_environment::spec::IsolationTier::{Container, Gvisor, Vm};
        for tiers in [None, Some(vec![]), Some(vec![Container])] {
            assert!(!person_execution_tiers(true, tiers.as_deref()));
        }
        assert!(!person_execution_tiers(false, Some(&[Gvisor])));
        assert!(person_execution_tiers(true, Some(&[Container, Gvisor])));
        assert!(person_execution_tiers(true, Some(&[Vm])));
    }

    #[test]
    fn p6d_person_mounts_and_record_purge_leave_other_partitions_intact() {
        let temp = tempfile::tempdir().unwrap();
        let policy = cognia_external_agent::presets::SpawnPolicy::from_env(temp.path());
        let mounts = WorkspaceMounts::new(temp.path().join("companion/workspace-mounts.json"), None);
        let store = ExecutionBindings(temp.path().join("companion/execution-bindings.json"));
        let a = crate::person_partition::PersonPartition::new("org_p6d_mount".into(), "usr_p6d_mount_a".into());
        let b = crate::person_partition::PersonPartition::new(a.org_id.clone(), "usr_p6d_mount_b".into());
        let mut roots = Vec::new();
        for person in [&a, &b] {
            let (root, _) = cognia_external_agent::person_workspace::person_workspace_prepare(&policy, &person.account_id, None, 1024).unwrap();
            let decision = ExecutionAdmission { binding:PlacementBinding { org_id:person.org_id.clone(), actor_user_id:person.user_id.clone(),
                workspace_id:format!("person:{}",person.account_id),run_id:person.account_id.clone() },actions:vec!["execution.request".into(),"workspace.write".into(),"credential.use".into()] };
            mounts.persist(&decision, root.to_str().unwrap()).unwrap();
            store.insert(&format!("external-agent:{}",person.account_id), &decision.binding).unwrap();
            roots.push((root, decision));
        }
        assert_eq!(mounts.authorize(&roots[0].1, roots[1].0.to_str().unwrap()).unwrap_err().code, "workspace_mount_forbidden");
        let child = roots[0].0.join("child"); std::fs::create_dir(&child).unwrap();
        mounts.authorize(&roots[0].1, child.to_str().unwrap()).unwrap();
        person_remove_execution_records(temp.path(), &a).unwrap();
        let records = store.read().unwrap();
        assert_eq!(records.len(), 1); assert_eq!(records.values().next().unwrap(), &roots[1].1.binding);
        let remaining = mounts.read().unwrap();
        assert_eq!(remaining.len(), 1); assert_eq!(remaining.values().next().unwrap(), roots[1].0.to_str().unwrap());
    }

    #[tokio::test]
    async fn p6c_tool_less_admission_ignores_execution_switch_only_for_closed_person_commands() {
        let _slot = crate::ws_bridge::test_support::lock_slot().await;
        let person = crate::person_partition::PersonPartition::new("org_p6c_gate".into(), "usr_p6c_gate".into());
        let (_installed, _) = crate::person_partition::person_test_support::Installed::new(vec![person.clone()]);
        let mut principal = device("person-brain"); principal.tenant_id = person.account_id;
        let provider = Fake { result:0, calls:AtomicUsize::new(0), workspaces:Mutex::new(vec![]) };
        for command in ["agent_send", "agent_interrupt", "person_model_ticket_mint"] {
            decide_with_person_fleet(DeploymentMode::MultiTenant, false, false, &provider,
                "agent.run", Some(command), &principal, None, true).await.unwrap();
        }
        assert_eq!(decide_with_person_fleet(DeploymentMode::MultiTenant, false, false, &provider,
            "agent.run", Some("agent_start"), &principal, None, true).await.unwrap_err().code, "host_surface_forbidden");
        assert_eq!(decide_with_person_fleet(DeploymentMode::MultiTenant, false, false, &provider,
            "agent.run", Some("agent_send"), &device("service"), None, true).await.unwrap_err().code, "execution_isolation_unavailable");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn p6b_org_commands_require_live_owner_or_admin_standing_without_host_approval() {
        let policy = POLICY.as_ref().unwrap();
        let entry = policy.get(crate::org_policy::CAPABILITY).unwrap();
        assert_eq!(entry.class, SurfaceClass::OrgAction);
        assert_eq!(entry.action.as_deref(), Some("org.policy.manage"));
        assert!(crate::org_policy::COMMANDS.iter().all(|command| !policy.command_overrides.contains_key(*command)));
        struct OrgStanding { role: Option<cognia_tenant_auth::OrgRole>, bound: bool }
        #[async_trait::async_trait]
        impl StandingProvider for OrgStanding {
            fn person(&self, _: &DeviceContext) -> Result<Person, Refusal> {
                if !self.bound { return Err(forbidden("host_principal_unbound")); }
                Ok(Person { org: "org_p6a_standing".into(), user: "usr_p6a_standing".into() })
            }
            async fn actions(&self, _: &Person, workspace: Option<&str>) -> Result<Vec<String>, Refusal> {
                assert!(workspace.is_none());
                Ok(cognia_tenant_auth::actions::org_actions_for(self.role).into_iter().map(|action|
                    serde_json::to_value(action).unwrap().as_str().unwrap().to_string()).collect())
            }
        }
        use cognia_tenant_auth::OrgRole;
        for command in crate::org_policy::COMMANDS {
            assert_eq!(crate::command_manifest::descriptor(command).unwrap().approval,
                crate::command_manifest::CommandApproval::None);
            for role in [OrgRole::Owner, OrgRole::Admin] {
                let provider = OrgStanding { role: Some(role), bound: true };
                assert!(decide(DeploymentMode::MultiTenant, true, false, &provider,
                    crate::org_policy::CAPABILITY, Some(command), &device("device"), Some("forged")).await.is_ok());
            }
            for provider in [OrgStanding { role: Some(OrgRole::Member), bound: true }, OrgStanding { role: None, bound: true }] {
                assert_eq!(decide(DeploymentMode::MultiTenant, true, false, &provider,
                    crate::org_policy::CAPABILITY, Some(command), &device("device"), None).await.unwrap_err().code, "host_surface_forbidden");
            }
            let unbound = OrgStanding { role: Some(OrgRole::Admin), bound: false };
            assert_eq!(decide(DeploymentMode::MultiTenant, true, false, &unbound,
                crate::org_policy::CAPABILITY, Some(command), &device("device"), None).await.unwrap_err().code, "host_principal_unbound");
            assert!(decide(DeploymentMode::MultiTenant, true, false, &unbound,
                crate::org_policy::CAPABILITY, Some(command), &device("service"), None).await.is_ok());
            assert!(decide(DeploymentMode::MultiTenant, true, false, &unbound,
                crate::org_policy::CAPABILITY, Some(command), &device("person-brain"), None).await.is_err());
            assert_eq!(decide(DeploymentMode::SingleUser, true, false, &unbound,
                crate::org_policy::CAPABILITY, Some(command), &device("service"), None).await.unwrap_err().status, StatusCode::CONFLICT);
        }
    }

    #[test]
    fn p6a_legacy_single_user_and_desktop_paths_stay_unchanged() {
        host_data_single_user_keeps_zero_policy_and_provider_calls();
    }

    #[test]
    fn p5_single_user_admission_retains_all_manifest_paths() {
        host_data_single_user_keeps_zero_policy_and_provider_calls();
        admission_reads_only_the_current_devices_verified_person();
    }

    #[tokio::test]
    async fn p5_data_admission_requires_org_standing_and_preserves_overrides_and_legacy() {
        for result in [0, 1] { // A member can legitimately have no org-admin actions.
            let provider = Fake { result, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
            for arm in ["message_send", "session_list", "issue_create", "register_push_token", "sync_list_tables"] {
                decide_with_person_fleet(DeploymentMode::MultiTenant, true, false, &provider,
                    "client.write", Some(arm), &device("device"), Some("forged"), true).await.unwrap();
            }
            assert!(provider.workspaces.lock().iter().all(Option::is_none));
            for arm in ["pet_chat_send", "pet_soul_generate"] {
                decide_with_person_fleet(DeploymentMode::MultiTenant, true, false, &provider,
                    "client.write", Some(arm), &device("device"), None, true).await.unwrap();
            }
            if result == 1 {
                assert_eq!(decide_with_person_fleet(DeploymentMode::MultiTenant, true, false, &provider,
                    "client.write", Some("app_settings_update"), &device("device"), None, true).await.unwrap_err().code, "host_surface_forbidden");
            }
        }
        assert_eq!(map_authority_error(crate::workspace_access::WorkspaceAccessError::Upstream { status: 404 }).code, "host_surface_forbidden");
        for (result, expected) in [(2, "host_authority_unavailable"), (3, "host_principal_unbound"), (4, "host_surface_forbidden")] {
            let provider = Fake { result, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
            assert_eq!(decide_with_person_fleet(DeploymentMode::MultiTenant, true, false, &provider,
                "client.read", Some("session_list"), &device("device"), None, true).await.unwrap_err().code, expected);
            decide_with_person_fleet(DeploymentMode::SingleUser, true, false, &provider,
                "client.read", Some("session_list"), &device("device"), None, true).await.unwrap();
            assert_eq!(decide_with_person_fleet(DeploymentMode::MultiTenant, true, false, &provider,
                "client.read", Some("session_list"), &device("device"), None, false).await.unwrap_err().code, "host_data_unpartitioned");
        }
    }

    #[test]
    fn p4_direct_execution_channels_stay_inert_and_single_user_keeps_its_behavior() {
        for enabled in [false, true] {
            assert!(!channel_execution_refused(DeploymentMode::MultiTenant, enabled, false));
            assert!(channel_execution_refused(DeploymentMode::MultiTenant, enabled, true));
            assert_eq!(channel_execution_refused(DeploymentMode::SingleUser, enabled, true), !enabled);
            assert!(!channel_execution_refused(DeploymentMode::SingleUser, enabled, false));
        }
        for command in ["claude_send", "agent_send", "workflow_trigger_manual", "execution_run_create", "team_run_start", "goal_create", "room_send", "codex_app_task_create"] {
            let capability = if command.starts_with("workflow_") { "workflow.run" } else { "agent.run" };
            assert!(host_brain_execution(capability, command), "{command}");
        }
        assert!(!host_brain_execution("agent.run", "get_external_agent_status"));
    }

    #[test]
    fn multi_tenant_host_brain_admits_only_its_own_non_executing_arms() {
        let policy = POLICY.as_ref().unwrap();
        // The operator brain's connector-runtime lease: under agent.run, declared non-executing.
        for command in ["connectors_runtime_lease_acquire", "connectors_runtime_lease_renew", "connectors_runtime_lease_release"] {
            assert!(host_brain_execution("agent.run", command), "{command}");
            assert!(!policy.command_executes("agent.run", Some(command)), "{command}");
        }
        assert!(policy.command_executes("agent.run", Some("agent_send")));
        assert!(host_brain_refusal(false, true).is_none());
        assert_eq!(host_brain_refusal(false, false).unwrap().code, "workspace_unresolved");
        for service in [false, true] {
            assert_eq!(host_brain_refusal(true, service).unwrap().code, "execution_isolation_unavailable");
        }
    }

    fn p4_binding() -> PlacementBinding {
        PlacementBinding { org_id: "org_a".into(), workspace_id: "workspace-real".into(), actor_user_id: "usr_owner".into(), run_id: "run-host".into() }
    }

    #[test]
    fn p4_records_survive_restart_and_ignore_forged_workspace_and_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bindings.json");
        let store = ExecutionBindings(path.clone());
        let key = record_key("spawn_external_agent", "agent");
        store.insert(&key, &p4_binding()).unwrap();
        store.insert(&key, &p4_binding()).unwrap();
        let mut forged = p4_binding(); forged.workspace_id = "forged".into();
        assert_eq!(store.insert(&key, &forged).unwrap_err().code, "execution_binding_exists");
        let reopened = ExecutionBindings(path);
        for arm in ["send_to_external_agent", "kill_external_agent", "get_external_agent_status"] {
            let args = json!({"agent_id":"agent", "agentId":"legacy", "workspaceId":"forged"});
            assert_eq!(execution_workspace(arm, &args, &reopened).unwrap().as_deref(), Some("workspace-real"));
            assert_eq!(execution_workspace(arm, &json!({"agentId":"legacy", "workspaceId":"forged"}), &reopened).unwrap(), None);
        }
    }

    #[test]
    fn p4_workspace_roots_need_host_authority_and_cannot_be_borrowed_by_another_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let workspace = base.join("a"); let nested = workspace.join("subdir"); let other = base.join("another");
        std::fs::create_dir_all(&nested).unwrap(); std::fs::create_dir_all(&other).unwrap();
        let root = workspace.to_str().unwrap();
        let roots = WorkspaceMounts::new(temp.path().join("roots.json"), Some(base));
        let mut decision = ExecutionAdmission { binding: p4_binding(), actions: vec!["execution.request".into(), "workspace.read".into()] };
        assert_eq!(roots.authorize(&decision, root).unwrap_err().code, "workspace_unresolved");
        decision.actions.push("host.global-surfaces".into());
        roots.persist(&decision, root).unwrap();
        decision.actions.retain(|action| action != "host.global-surfaces");
        roots.authorize(&decision, root).unwrap();
        assert_eq!(roots.authorize(&decision, nested.to_str().unwrap()).unwrap_err().code, "workspace_mount_forbidden");
        assert_eq!(roots.authorize(&decision, other.to_str().unwrap()).unwrap_err().code, "workspace_mount_forbidden");
        decision.binding.actor_user_id = "usr_other".into();
        roots.authorize(&decision, root).unwrap();
        decision.binding.workspace_id = "workspace-other".into();
        assert_eq!(roots.authorize(&decision, root).unwrap_err().code, "workspace_root_claimed");
    }

    #[test]
    fn p4_review_root_claims_require_operator_base_and_exclude_other_orgs_and_nested_paths() {
        let temp = tempfile::tempdir().unwrap(); let base = temp.path().canonicalize().unwrap().join("base");
        let workspace = base.join("parent/child"); std::fs::create_dir_all(&workspace).unwrap();
        let outside = temp.path().canonicalize().unwrap().join("outside"); std::fs::create_dir_all(&outside).unwrap();
        let mut decision = ExecutionAdmission { binding: p4_binding(), actions: vec!["host.global-surfaces".into()] };
        let missing = WorkspaceMounts::new(temp.path().join("missing.json"), None);
        assert_eq!(missing.persist(&decision, workspace.to_str().unwrap()).unwrap_err().code, "workspace_root_unconfigured");
        let roots = WorkspaceMounts::new(temp.path().join("roots.json"), Some(base.clone()));
        assert_eq!(roots.persist(&decision, outside.to_str().unwrap()).unwrap_err().code, "workspace_mount_forbidden");
        assert_eq!(roots.persist(&decision, base.to_str().unwrap()).unwrap_err().code, "workspace_mount_forbidden");
        roots.persist(&decision, workspace.to_str().unwrap()).unwrap();
        decision.binding.org_id = "org_other".into();
        for path in [workspace.as_path(), workspace.parent().unwrap()] {
            assert_eq!(roots.persist(&decision, path.to_str().unwrap()).unwrap_err().code, "workspace_root_claimed");
        }
        let nested = workspace.join("nested"); std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(roots.persist(&decision, nested.to_str().unwrap()).unwrap_err().code, "workspace_root_claimed");
        #[cfg(unix)] {
            let link = base.join("symlink"); std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert_eq!(roots.persist(&decision, link.to_str().unwrap()).unwrap_err().code, "workspace_mount_forbidden");
        }
        assert_eq!(roots.read().unwrap().len(), 1);
        let concurrent = WorkspaceMounts::new(temp.path().join("concurrent.json"), Some(base));
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let first = scope.spawn(|| { barrier.wait(); concurrent.persist(&decision, workspace.to_str().unwrap()) });
            let mut other = decision.clone(); other.binding.org_id = "org_racer".into();
            let concurrent = &concurrent; let workspace = &workspace; let barrier = &barrier;
            let second = scope.spawn(move || { barrier.wait(); concurrent.persist(&other, workspace.to_str().unwrap()) });
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.into_iter().find_map(Result::err).unwrap().code, "workspace_root_claimed");
    }

    #[tokio::test]
    async fn p4_review_each_creation_gets_a_fresh_generation_and_cleanup_is_generation_safe_and_bounded() {
        let temp = tempfile::tempdir().unwrap(); let store = ExecutionBindings(temp.path().join("bindings.json"));
        let provider = Fake { result: 0, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
        let args = json!({"workspaceId":"workspace-real", "config":{"id":"same-id"}});
        let first = resolve_execution_admission(&provider, &store, "spawn_external_agent", &args, &device("device")).await.unwrap();
        let key = record_key("spawn_external_agent", "same-id"); store.insert(&key, &first.binding).unwrap();
        let second = resolve_execution_admission(&provider, &store, "spawn_external_agent", &args, &device("device")).await.unwrap();
        assert_ne!(first.binding.run_id, second.binding.run_id);
        assert_ne!(first.binding.scratch_path(), second.binding.scratch_path());
        store.insert(&key, &second.binding).unwrap();
        store.remove(&key, &first.binding).unwrap();
        assert_eq!(store.binding(&key).unwrap(), Some(second.binding.clone()));
        store.remove(&key, &second.binding).unwrap();
        assert_eq!(execution_workspace("kill_external_agent", &json!({"agentId":"same-id", "workspaceId":"forged"}), &store).unwrap(), None);
        let task = record_key("environment_task_shell_exec", "task");
        // The public lifecycle helper uses the production companion subdir.
        let production = ExecutionBindings(temp.path().join("companion/execution-bindings.json"));
        production.insert(&task, &first.binding).unwrap();
        forget_execution_record(temp.path(), "environment_task_shell_exec", "task", &first.binding).unwrap();
        assert!(production.read().unwrap().is_empty());
        let records = (0..EXECUTION_BINDING_LIMIT).map(|id| (format!("external-agent:{id}"), first.binding.clone())).collect();
        store.write(&records).unwrap();
        assert_eq!(store.insert("external-agent:overflow", &second.binding).unwrap_err().code, "execution_binding_store_full");
        store.remove("external-agent:0", &first.binding).unwrap();
        store.insert("external-agent:replacement", &second.binding).unwrap();
        assert_eq!(store.read().unwrap().len(), EXECUTION_BINDING_LIMIT);
        std::fs::write(&store.0, vec![b' '; EXECUTION_BINDING_BYTES as usize + 1]).unwrap();
        assert_eq!(store.read().unwrap_err().code, "execution_binding_store_full");
    }

    #[tokio::test]
    async fn p4_creation_stamps_the_gate_person_and_later_actors_need_fresh_standing() {
        let temp = tempfile::tempdir().unwrap();
        let store = ExecutionBindings(temp.path().join("bindings.json"));
        let provider = Fake { result: 0, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
        let args = json!({"workspaceId":"workspace-real", "config":{"id":"new"}});
        let admitted = resolve_execution_admission(&provider, &store, "spawn_external_agent", &args, &device("device")).await.unwrap();
        assert_eq!(admitted.binding.org_id, "org_a");
        assert_eq!(admitted.binding.actor_user_id, "usr_a");
        assert_eq!(admitted.binding.workspace_id, "workspace-real");
        assert!(uuid::Uuid::parse_str(&admitted.binding.run_id).is_ok());
        assert!(store.read().unwrap().is_empty(), "admission itself creates no record");
        store.insert(&record_key("spawn_external_agent", "existing"), &p4_binding()).unwrap();
        let args = json!({"agentId":"existing", "workspaceId":"forged"});
        let other_actor = resolve_execution_admission(&provider, &store, "get_external_agent_status", &args, &device("device")).await.unwrap();
        assert_eq!(other_actor.binding.actor_user_id, "usr_owner");
        assert!(provider.workspaces.lock().iter().all(|workspace| workspace.as_deref() == Some("workspace-real")));
        let denied = Fake { result: 1, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
        assert_eq!(resolve_execution_admission(&denied, &store, "get_external_agent_status", &args, &device("device")).await.unwrap_err().code, "execution_request_forbidden");
        for args in [json!({"workspaceId":"workspace-real", "config":{"id":"new", "sandbox":{"binding":null}}}),
            json!({"workspaceId":"workspace-real", "placement":{"binding":{"orgId":"org_a"}}, "owner":"task"})] {
            assert_eq!(resolve_execution_admission(&provider, &store, "spawn_external_agent", &args, &device("device")).await.unwrap_err().code, "placement_binding_client_supplied");
        }
    }
    #[tokio::test]
    async fn p5d_host_state_gate_requires_fleet_person_and_standing_only_in_multi_tenant() {
        for arm in ["host_state_status", "host_state_snapshot", "host_state_submit", "host_feature_manifest", "session_attach", "session_detach"] {
            let capability = if arm == "host_state_submit" { "workspace.write" } else { "host.observe" };
            let member = Fake { result: 1, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
            for execution in [false, true] {
                assert!(decide_with_person_fleet(DeploymentMode::MultiTenant, execution, false, &member,
                    capability, Some(arm), &device("device"), None, true).await.is_ok(), "{arm}");
                assert_eq!(decide_with_person_fleet(DeploymentMode::MultiTenant, execution, false, &member,
                    capability, Some(arm), &device("device"), None, false).await.unwrap_err().code, "host_surface_forbidden");
                assert!(decide_with_person_fleet(DeploymentMode::SingleUser, execution, false, &member,
                    capability, Some(arm), &device("device"), None, true).await.is_ok());
            }
            let unbound = Fake { result: 3, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
            assert_eq!(decide_with_person_fleet(DeploymentMode::MultiTenant, true, false, &unbound,
                capability, Some(arm), &device("device"), None, true).await.unwrap_err().code, "host_principal_unbound");
            let revoked = Fake { result: 4, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
            assert_eq!(decide_with_person_fleet(DeploymentMode::MultiTenant, true, false, &revoked,
                capability, Some(arm), &device("device"), None, true).await.unwrap_err().code, "host_surface_forbidden");
            assert_eq!(decide_with_person_fleet(DeploymentMode::MultiTenant, true, false, &member,
                capability, Some(arm), &device("service"), None, true).await.unwrap_err().code, "host_surface_forbidden");
        }
    }

    struct Fake { result: u8, calls: AtomicUsize, workspaces: Mutex<Vec<Option<String>>> }
    #[async_trait::async_trait]
    impl StandingProvider for Fake {
        fn person(&self, _: &DeviceContext) -> Result<Person, Refusal> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.result == 3 { return Err(forbidden("host_principal_unbound")); }
            Ok(Person { org: "org_a".into(), user: "usr_a".into() })
        }
        async fn actions(&self, _: &Person, workspace: Option<&str>) -> Result<Vec<String>, Refusal> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.workspaces.lock().push(workspace.map(str::to_string));
            match self.result {
                0 => Ok(vec!["host.global-surfaces".into(), "execution.request".into(), "workspace.read".into()]),
                1 => Ok(vec![]),
                4 => Err(map_authority_error(crate::workspace_access::WorkspaceAccessError::Upstream { status: 404 })),
                _ => Err(unavailable("host_authority_unavailable")),
            }
        }
    }
    fn device(scope: &str) -> DeviceContext { DeviceContext { device_id: "device".into(), tenant_id: "tenant".into(), scope: scope.into(), granted_scopes: vec![], authorization_capabilities: None } }

    #[tokio::test]
    async fn host_data_all_manifest_data_arms_refuse_tenants_until_p5() {
        let manifest: Value = serde_json::from_str(include_str!("../../../protocol/companion-commands.json")).unwrap();
        let policy = POLICY.as_ref().unwrap();
        let provider = Fake { result: 0, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
        let mut refused = std::collections::BTreeSet::new();
        for command in manifest["commands"].as_array().unwrap() {
            let capability = command["capability"].as_str().unwrap();
            let arm = command["arm"].as_str().unwrap();
            if !matches!(capability, "client.read" | "client.write") || policy.command_overrides.contains_key(arm) { continue; }
            refused.insert(arm);
            for scope in ["device", "owner", "unknown"] {
                for enabled in [false, true] {
                    for sandboxes in [false, true] {
                        let refusal = decide(DeploymentMode::MultiTenant, enabled, sandboxes, &provider,
                            capability, Some(arm), &device(scope), Some("forged-workspace")).await.unwrap_err();
                        assert_eq!(refusal.status, StatusCode::FORBIDDEN, "{scope}/{arm}");
                        assert_eq!(refusal.code, "host_data_unpartitioned", "{scope}/{arm}");
                    }
                }
            }
        }
        for arm in ["message_send", "files_library_upload_init", "pet_chat_send", "issue_create", "register_push_token"] {
            assert!(refused.contains(arm), "missing pinned write {arm}");
        }
        let reads: Vec<_> = manifest["commands"].as_array().unwrap().iter()
            .filter(|command| command["capability"] == "client.read").collect();
        assert_eq!(reads.len(), 17, "review the read inventory when the manifest changes");
        assert!(reads.iter().all(|command| refused.contains(command["arm"].as_str().unwrap())));
        assert_eq!(refused.len(), 53, "61 data arms minus eight Host-global overrides");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0, "standing cannot authorize an unpartitioned store");
    }

    #[tokio::test]
    async fn host_data_eight_global_overrides_still_use_org_standing() {
        let policy = POLICY.as_ref().unwrap();
        let arms = ["adapter_update_policy", "app_settings_update", "mcp_set_enabled", "mcp_set_tool_rules",
            "plugin_cogset_activate", "plugin_install_origin_record", "plugin_set_enabled", "skill_set_enabled"];
        assert_eq!(policy.command_overrides.keys().map(String::as_str).collect::<Vec<_>>(), arms);
        for scope in ["device", "owner"] {
            for standing in 0..3 {
                let provider = Fake { result: standing, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
                for arm in arms {
                    let result = decide(DeploymentMode::MultiTenant, true, false, &provider,
                        "client.write", Some(arm), &device(scope), Some("ignored-workspace")).await;
                    if standing == 0 { assert!(result.is_ok(), "{scope}/{arm}"); }
                    else {
                        let refusal = result.unwrap_err();
                        assert_eq!(refusal.status, if standing == 1 { StatusCode::FORBIDDEN } else { StatusCode::SERVICE_UNAVAILABLE });
                        assert_eq!(refusal.code, if standing == 1 { "host_surface_forbidden" } else { "host_authority_unavailable" });
                    }
                }
                assert_eq!(provider.calls.load(Ordering::SeqCst), arms.len() * 2);
                assert!(provider.workspaces.lock().iter().all(Option::is_none));
            }
        }
    }

    #[tokio::test]
    async fn host_data_service_retains_brain_data_without_new_standing_bypasses() {
        let manifest: Value = serde_json::from_str(include_str!("../../../protocol/companion-commands.json")).unwrap();
        let policy = POLICY.as_ref().unwrap();
        let provider = Fake { result: 3, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
        let service = device("service");
        for command in manifest["commands"].as_array().unwrap() {
            let capability = command["capability"].as_str().unwrap();
            let arm = command["arm"].as_str().unwrap();
            if !matches!(capability, "client.read" | "client.write") || policy.command_overrides.contains_key(arm) { continue; }
            for enabled in [false, true] {
                assert!(decide(DeploymentMode::MultiTenant, enabled, false, &provider,
                    capability, Some(arm), &service, None).await.is_ok(), "{arm}");
            }
        }
        assert!(decide(DeploymentMode::MultiTenant, true, false, &provider, "service.internal", None, &service, None).await.is_ok());
        assert_eq!(decide(DeploymentMode::MultiTenant, true, false, &provider,
            "unclassified", None, &service, None).await.unwrap_err().code, "host_surface_forbidden");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        // LiveStanding refuses service identities: they cannot borrow tenant
        // standing. The new class must not exempt overrides or other classes.
        assert_eq!(LiveStanding { cache: Mutex::new(AdmissionCache::default()) }.person(&service).unwrap_err().code, "host_principal_unbound");
        for arm in policy.command_overrides.keys() {
            assert_eq!(decide(DeploymentMode::MultiTenant, true, true, &provider,
                "client.write", Some(arm), &service, None).await.unwrap_err().code, "host_principal_unbound", "{arm}");
        }
        for capability in ["host.admin", "workspace.write"] {
            assert_eq!(decide(DeploymentMode::MultiTenant, true, true, &provider,
                capability, None, &service, None).await.unwrap_err().code, "host_principal_unbound");
        }
        for arm in ["plugin_set_enabled", "plugin_cogset_activate"] {
            assert_eq!(decide(DeploymentMode::MultiTenant, false, true, &provider,
                "client.write", Some(arm), &service, None).await.unwrap_err().code, "execution_isolation_unavailable");
        }
        assert!(provider.workspaces.lock().is_empty());
    }

    #[tokio::test]
    async fn host_data_single_user_keeps_zero_policy_and_provider_calls() {
        // Pin the unchanged first statements as well as behavior: a global
        // Lazy may already be initialized by concurrent tests, so checking its
        // initialization state alone cannot prove that this path never reads it.
        let source = include_str!("host_surface_gate.rs");
        let body = source.split_once("pub async fn decide(").unwrap().1
            .split_once("-> Result<(), Refusal> {").unwrap().1;
        assert!(body.contains("\n    // No policy parse, identity/store read or provider call on the legacy path.\n    if mode == DeploymentMode::SingleUser && execution { return Ok(()); }\n"));
        let provider = Fake { result: 3, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
        let manifest: Value = serde_json::from_str(include_str!("../../../protocol/companion-commands.json")).unwrap();
        for scope in ["device", "owner", "service"] {
            for command in manifest["commands"].as_array().unwrap() {
                if command["capability"] == crate::org_policy::CAPABILITY {
                    assert_eq!(decide(DeploymentMode::SingleUser, true, false, &provider,
                        crate::org_policy::CAPABILITY, command["arm"].as_str(), &device(scope), None).await.unwrap_err().code, "org_scope_unavailable");
                    continue;
                }
                assert!(decide(DeploymentMode::SingleUser, true, false, &provider,
                    command["capability"].as_str().unwrap(), command["arm"].as_str(), &device(scope), None).await.is_ok());
            }
            // Even an invalid capability bypasses policy on the legacy path.
            assert!(decide(DeploymentMode::SingleUser, true, false, &provider,
                "unclassified", None, &device(scope), None).await.is_ok());
        }
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn admission_cache_bounds_positive_negative_and_unavailable_standing_to_five_seconds() {
        let now = Instant::now();
        let key = (Person { org: "org_a".into(), user: "usr_a".into() }, None);
        let mut cache = AdmissionCache::default();
        for result in [Ok(vec!["execution.request".into()]), Ok(vec![]), Err(unavailable("host_authority_unavailable"))] {
            cache.insert(key.clone(), now, now, result.clone());
            let cached = cache.get(&key, now + Duration::from_millis(4999)).unwrap();
            assert_eq!(cached.as_ref().map(Vec::len).map_err(|error| error.code), result.as_ref().map(Vec::len).map_err(|error| error.code));
            assert!(cache.get(&key, now + CACHE_TTL).is_none());
        }
        assert!(cache.get(&(key.0.clone(), Some("workspace".into())), now).is_none());
        assert!(cache.get(&(Person { org: "org_b".into(), ..key.0.clone() }, None), now).is_none());
        assert!(cache.get(&(Person { user: "usr_b".into(), ..key.0.clone() }, None), now).is_none());
        cache.insert(key.clone(), now + Duration::from_secs(1), now + Duration::from_secs(1), Ok(vec![]));
        cache.insert(key.clone(), now, now + Duration::from_secs(2), Ok(vec!["stale grant".into()]));
        assert!(cache.get(&key, now + Duration::from_secs(2)).unwrap().unwrap().is_empty());
        for index in 0..CACHE_LIMIT + 10 {
            cache.insert((key.0.clone(), Some(index.to_string())), now, now, Ok(vec![]));
        }
        assert_eq!(cache.entries.len(), CACHE_LIMIT);
        let slow = (key.0, Some("too slow".into()));
        cache.insert(slow.clone(), now, now + CACHE_TTL, Ok(vec![]));
        assert!(cache.get(&slow, now + CACHE_TTL).is_none());
        assert!(cache.entries.len() <= CACHE_LIMIT);
    }

    #[tokio::test]
    async fn all_surface_classes_mode_and_standing_matrix() {
        for mode in [DeploymentMode::SingleUser, DeploymentMode::MultiTenant] {
            for capability in ["client.local", "client.read", "service.internal", "host.admin", "workspace.write", "agent.run"] {
                for standing in 0..3 {
                    let provider = Fake { result: standing, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
                    let result = decide(mode, true, true, &provider, capability, None, &device("device"), Some("project-1")).await;
                    let allowed = mode == DeploymentMode::SingleUser || capability == "client.local" || (!matches!(capability, "client.read" | "service.internal") && standing == 0);
                    assert_eq!(result.is_ok(), allowed, "{mode:?}/{capability}/{standing}");
                    if mode == DeploymentMode::SingleUser || matches!(capability, "client.local" | "client.read" | "service.internal") {
                        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
                    } else if standing == 2 { assert_eq!(result.unwrap_err().code, "host_authority_unavailable"); }
                    if capability == "workspace.write" { assert!(provider.workspaces.lock().iter().all(Option::is_none)); }
                }
            }
        }
    }

    #[tokio::test]
    async fn isolation_missing_workspace_unknown_surface_and_service_scope() {
        let provider = Fake { result: 0, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
        let multi = DeploymentMode::MultiTenant;
        assert!(decide(multi, true, false, &provider, "service.internal", None, &device("service"), None).await.is_ok());
        assert_eq!(decide(multi, true, true, &provider, "agent.run", None, &device("device"), None).await.unwrap_err().code, "workspace_unresolved");
        for mode in [multi, DeploymentMode::SingleUser] {
            assert_eq!(decide(mode, false, true, &provider, "agent.run", Some("agent_send"), &device("service"), Some("p")).await.unwrap_err().code, "execution_isolation_unavailable");
        }
        assert_eq!(decide(multi, true, false, &provider, "agent.run", None, &device("device"), Some("p")).await.unwrap_err().code, "execution_isolation_unavailable");
        assert!(decide(multi, true, true, &provider, "unclassified", None, &device("service"), None).await.is_err());
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        let unbound = Fake { result: 3, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
        for capability in ["host.admin", "workspace.write", "agent.run"] {
            assert_eq!(decide(multi, true, true, &unbound, capability, None, &device("device"), Some("p")).await.unwrap_err().code, "host_principal_unbound");
        }
        assert!(unbound.workspaces.lock().is_empty(), "unbound identities never query collaboration standing");
    }

    #[tokio::test]
    async fn disabled_execution_is_arm_specific_in_both_modes_and_every_scope() {
        let provider = Fake { result: 0, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
        let manifest: Value = serde_json::from_str(include_str!("../../../protocol/companion-commands.json")).unwrap();
        for mode in [DeploymentMode::SingleUser, DeploymentMode::MultiTenant] {
            for scope in ["device", "owner", "service"] {
                for arm in &POLICY.as_ref().unwrap().execution_commands {
                    let command = manifest["commands"].as_array().unwrap().iter()
                        .find(|command| command["arm"].as_str() == Some(arm.as_str())).unwrap();
                    let refusal = decide(mode, false, false, &provider,
                        command["capability"].as_str().unwrap(), Some(arm), &device(scope), None).await.unwrap_err();
                    assert_eq!(refusal.status, StatusCode::SERVICE_UNAVAILABLE, "{mode:?}/{scope}/{arm}");
                    assert_eq!(refusal.code, "execution_isolation_unavailable");
                }
                assert_eq!(decide(mode, false, false, &provider, "agent.worker", None,
                    &device(scope), None).await.unwrap_err().code, "execution_isolation_unavailable");
            }
        }
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        for capability in ["client.local", "client.read", "client.write", "host.observe", "host.admin", "workspace.read", "workspace.write", "service.internal", "agent.run", "workflow.run", "terminal.open", "process.spawn", "host.execute"] {
            assert!(!POLICY.as_ref().unwrap().executes(capability));
        }
        for (capability, arm) in [("client.local", "acp_terminal_output"), ("client.read", "session_list"), ("client.write", "message_update"), ("host.observe", "host_state_status"), ("host.admin", "host_runtime_status"), ("workspace.read", "git_status"), ("process.spawn", "plugin_list")] {
            for mode in [DeploymentMode::SingleUser, DeploymentMode::MultiTenant] {
                let result = decide(mode, false, false, &provider, capability, Some(arm), &device("device"), None).await;
                if mode == DeploymentMode::MultiTenant && matches!(capability, "client.read" | "client.write") {
                    assert_eq!(result.unwrap_err().code, "host_data_unpartitioned", "{arm}");
                } else { assert!(result.is_ok(), "{mode:?}/{arm}"); }
            }
        }
    }

    #[tokio::test]
    async fn host_global_client_writes_require_org_standing_only_in_multi_tenant() {
        for mode in [DeploymentMode::SingleUser, DeploymentMode::MultiTenant] {
            for standing in 0..3 {
                let provider = Fake { result: standing, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
                for arm in POLICY.as_ref().unwrap().command_overrides.keys() {
                    let result = decide(mode, true, true, &provider, "client.write", Some(arm), &device("device"), None).await;
                    assert_eq!(result.is_ok(), mode == DeploymentMode::SingleUser || standing == 0, "{mode:?}/{arm}");
                    if mode == DeploymentMode::MultiTenant && standing == 1 {
                        let refusal = result.unwrap_err();
                        assert_eq!(refusal.status, StatusCode::FORBIDDEN);
                        assert_eq!(refusal.code, "host_surface_forbidden");
                    }
                }
                if mode == DeploymentMode::SingleUser { assert_eq!(provider.calls.load(Ordering::SeqCst), 0); }
                // Per-user data remains dormant until person partitioning.
                for (capability, arm) in [("client.write", "pet_chat_send"), ("client.read", "session_list"), ("client.write", "files_library_rename")] {
                    let result = decide(mode, true, false, &provider, capability, Some(arm), &device("device"), None).await;
                    if mode == DeploymentMode::MultiTenant {
                        assert_eq!(result.unwrap_err().code, "host_data_unpartitioned", "{arm}");
                    } else { assert!(result.is_ok(), "{arm}"); }
                }
            }
        }
    }

    #[test]
    fn admission_reads_only_the_current_devices_verified_person() {
        use crate::security_store::{SecurityStore, VerifiedDevicePerson};
        use cognia_tenant_auth::{OrgId, UserId};
        let store = SecurityStore::in_memory().unwrap();
        let bound = VerifiedDevicePerson {
            user_id: UserId::parse("usr_verified").unwrap(),
            org_id: OrgId::parse("org_verified").unwrap(),
        };
        let challenge = store.issue_challenge("tenant", 100, 60).unwrap();
        store
            .register_oidc_device(
                "tenant",
                "oidc-subject",
                &bound,
                &challenge.id,
                &challenge.nonce,
                "device",
                "Web",
                "pem",
                "thumb",
                "member",
                101,
            )
            .unwrap();
        for scope in ["device", "owner"] {
            let person = bound_device_person(&store, &device(scope)).unwrap();
            assert_eq!(
                person,
                Person {
                    org: "org_verified".into(),
                    user: "usr_verified".into()
                }
            );
        }
        let mut other = device("device");
        other.tenant_id = "another-tenant".into();
        assert_eq!(
            bound_device_person(&store, &other).unwrap_err().code,
            "host_principal_unbound"
        );
        assert!(bound_device_person(&store, &device("service")).is_err());
        store
            .assign_device_user("tenant", "device", None, 102)
            .unwrap();
        assert_eq!(
            bound_device_person(&store, &device("device"))
                .unwrap_err()
                .code,
            "host_principal_unbound"
        );
        store
            .adopt_unowned_devices("tenant", "usr_verified", 103)
            .unwrap();
        assert_eq!(
            bound_device_person(&store, &device("device"))
                .unwrap_err()
                .code,
            "host_principal_unbound"
        );
    }

    #[test]
    fn generic_or_session_args_cannot_supply_an_execution_workspace() {
        let args = json!({ "workspaceId": "p", "projectId": "forged", "sessionId": "s" });
        assert_eq!(command_workspace("browser_session_ensure", &args), Some("p"));
        assert_eq!(command_workspace("claude_send", &args), None);
        assert_eq!(command_workspace("workflow_trigger_manual", &args), None);
        struct Missing;
        impl ExecutionBindingLookup for Missing {
            fn binding(&self, _: &str) -> Result<Option<PlacementBinding>, Refusal> { Ok(None) }
        }
        assert_eq!(execution_workspace("spawn_external_agent", &args, &Missing).unwrap().as_deref(), Some("p"));
        for arm in ["get_external_agent_status", "send_to_external_agent", "kill_external_agent", "claude_send", "workflow_trigger_manual"] {
            assert_eq!(execution_workspace(arm, &args, &Missing).unwrap(), None, "{arm}");
        }
        // The remaining agent/workflow commands are session/run/deployment-
        // scoped today. Review new arms here before admitting a new argument.
        let manifest: Value = serde_json::from_str(include_str!("../../../protocol/companion-commands.json")).unwrap();
        for command in manifest["commands"].as_array().unwrap() {
            if matches!(command["capability"].as_str(), Some("agent.run" | "workflow.run")) {
                let arm = command["arm"].as_str().unwrap();
                assert_eq!(command_workspace(arm, &args),
                    if matches!(arm, "browser_session_ensure" | "browser_profile_delete") { Some("p") } else { None }, "{arm}");
            }
        }
    }

    #[test]
    fn auth_config_execution_availability_preserves_the_single_user_default() {
        for mode in [DeploymentMode::SingleUser, DeploymentMode::MultiTenant] {
            for sandboxes in [false, true] {
                assert!(!availability(mode, false, sandboxes));
                assert_eq!(availability(mode, true, sandboxes), mode == DeploymentMode::SingleUser || sandboxes);
            }
        }
    }

    #[test]
    fn authority_transport_malformed_and_explicit_denials_have_distinct_statuses() {
        use crate::workspace_access::WorkspaceAccessError::*;
        for error in [NotConfigured, Unreachable("offline".into()), Malformed("invalid JSON".into()), Upstream { status: 503 }] {
            let refusal = map_authority_error(error);
            assert_eq!(refusal.status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(refusal.code, "host_authority_unavailable");
        }
        for error in [Unauthorized, Upstream { status: 403 }, Upstream { status: 404 }] {
            assert_eq!(map_authority_error(error).status, StatusCode::FORBIDDEN);
        }
    }
}
