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
    fn person(&self, principal: &DeviceContext) -> Result<Person, Refusal> {
        let unbound = || forbidden("host_principal_unbound");
        // require_owner_access authenticates the same paired-device proof,
        // then labels it `owner` for management routes. It is still a device,
        // and must resolve standing rather than acquiring service authority.
        if !matches!(principal.scope.as_str(), "device" | "owner") { return Err(unbound()); }
        let store = crate::security_store::security_store().ok_or_else(unbound)?;
        // The raw user id belongs to the device's tenant, not the currently
        // unlocked profile. The join also checks status on EVERY admission.
        if store.device_user(&principal.tenant_id, &principal.device_id)
            .map_err(|_| unbound())?.is_none() { return Err(unbound()); }
        let binding = store.active_device_person(&principal.tenant_id, &principal.device_id)
            .map_err(|_| unbound())?.ok_or_else(unbound)?;
        person_ids(binding.org_id, binding.user_id, binding.canonical_org_id, binding.canonical_user_id)
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

fn person_ids(org: Option<String>, user: Option<String>, canonical_org: Option<String>, canonical_user: Option<String>) -> Result<Person, Refusal> {
    let (org, user) = match (canonical_org, canonical_user) {
        (Some(org), Some(user)) => (org, user),
        (None, None) => match (org, user) { (Some(org), Some(user)) => (org, user), _ => return Err(forbidden("host_principal_unbound")) },
        // Never combine ids from two namespaces or guess a missing alias.
        _ => return Err(forbidden("host_principal_unbound")),
    };
    cognia_tenant_auth::OrgId::parse(&org).map_err(|_| forbidden("host_principal_unbound"))?;
    cognia_tenant_auth::UserId::parse(&user).map_err(|_| forbidden("host_principal_unbound"))?;
    Ok(Person { org, user })
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
    // No policy parse, identity/store read or provider call on the legacy path.
    if mode == DeploymentMode::SingleUser && execution { return Ok(()); }
    let policy = POLICY.as_ref().map_err(|_| forbidden("host_surface_forbidden"))?;
    let entry = policy.get(capability)
        .ok_or_else(|| forbidden("host_surface_forbidden"))?;
    if !execution && policy.command_executes(capability, arm) {
        return Err(unavailable("execution_isolation_unavailable"));
    }
    if mode == DeploymentMode::SingleUser { return Ok(()); }
    let entry = arm.and_then(|arm| policy.command_overrides.get(arm)).unwrap_or(entry);
    let (action, workspace) = match entry.class {
        SurfaceClass::Client => return Ok(()),
        SurfaceClass::OperatorOnly => return if principal.scope == "service" { Ok(()) } else { Err(forbidden("host_surface_forbidden")) },
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
    let workspace = execution_workspace(command, args, lookup)?.ok_or_else(|| forbidden("workspace_unresolved"))?;
    let person = provider.person(principal)?;
    let id = record_id(command, args).filter(|id| !id.is_empty()).ok_or_else(|| forbidden("workspace_unresolved"))?;
    let existing = lookup.binding(&record_key(command, id))?;
    let creating = matches!(command, "spawn_external_agent" | "environment_task_shell_exec");
    let binding = match existing {
        Some(binding) => {
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
        for (key, binding) in retired { store.remove(&key, &binding)?; }
        Ok(())
    }).await.unwrap_or_else(|_| Err(unavailable("execution_binding_store_unavailable")))
        .map_err(|refusal: Refusal| Problem::with_status(refusal.status, refusal.code, refusal.code))
}

/// Admission for the two container dispatch paths and their recorded controls.
/// The typed decision is scoped over dispatch; it never enters request args.
pub async fn authorize_execution(state: &crate::SharedState, capability: &str, command: &str,
    principal: &DeviceContext, args: &Value) -> Result<Option<ExecutionAdmission>, Problem> {
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
        // Pool availability never makes Host JS/sidecar code isolated. These
        // arms remain intentionally unavailable; no client id can lift this.
        if (brain && POLICY.as_ref().is_ok_and(|policy| policy.command_executes(capability, Some(command))))
            || (command == "environment_task_shell_exec" && principal.scope == "service") {
            return Err(unavailable("execution_isolation_unavailable"));
        }
        if brain { return Err(forbidden("workspace_unresolved")); }
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
                _ => Err(unavailable("host_authority_unavailable")),
            }
        }
    }
    fn device(scope: &str) -> DeviceContext { DeviceContext { device_id: "device".into(), tenant_id: "tenant".into(), scope: scope.into(), granted_scopes: vec![], authorization_capabilities: None } }

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
    async fn all_five_classes_mode_and_standing_matrix() {
        for mode in [DeploymentMode::SingleUser, DeploymentMode::MultiTenant] {
            for capability in ["client.read", "service.internal", "host.admin", "workspace.write", "agent.run"] {
                for standing in 0..3 {
                    let provider = Fake { result: standing, calls: AtomicUsize::new(0), workspaces: Mutex::new(vec![]) };
                    let result = decide(mode, true, true, &provider, capability, None, &device("device"), Some("project-1")).await;
                    let allowed = mode == DeploymentMode::SingleUser || capability == "client.read" || (capability != "service.internal" && standing == 0);
                    assert_eq!(result.is_ok(), allowed, "{mode:?}/{capability}/{standing}");
                    if mode == DeploymentMode::SingleUser || capability == "client.read" || capability == "service.internal" {
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
                assert!(decide(mode, false, false, &provider, capability, Some(arm), &device("device"), None).await.is_ok(), "{mode:?}/{arm}");
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
                // Per-user data keeps the existing client classification.
                for (capability, arm) in [("client.write", "pet_chat_send"), ("client.read", "session_list"), ("client.write", "files_library_rename")] {
                    assert!(decide(mode, true, false, &provider, capability, Some(arm), &device("device"), None).await.is_ok());
                }
            }
        }
    }

    #[test]
    fn canonical_ids_must_be_a_complete_pair() {
        let org = || Some("org_acme".into()); let user = || Some("usr_alice".into());
        assert!(person_ids(org(), user(), None, None).is_ok());
        assert!(person_ids(None, None, org(), user()).is_ok());
        assert!(person_ids(org(), user(), org(), None).is_err());
        assert!(person_ids(None, user(), None, None).is_err());
        assert!(person_ids(Some("bad".into()), user(), None, None).is_err());
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
