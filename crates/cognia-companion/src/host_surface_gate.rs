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
pub async fn authorize_channel(capability: &str, execution: bool, principal: &DeviceContext) -> Result<(), Problem> {
    authorize_entry(capability, None, execution, principal, None).await
}

async fn authorize_entry(capability: &str, arm: Option<&str>, execution_channel: bool,
    principal: &DeviceContext, workspace: Option<&str>) -> Result<(), Problem> {
    let enabled = execution_enabled();
    let result = if execution_channel && !enabled {
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
        // Intentionally fallback-only until P4: NEVER use a renderer id here.
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

/// `command` is the descriptor's dispatch arm, after alias resolution.
/// Only fields consumed as workspace ids by the actual target may authorize
/// execution. Unknown commands and session/run-only commands cannot borrow an
/// unrelated `workspaceId` added to their otherwise generic args (P1).
pub fn command_workspace<'a>(command: &str, args: &'a Value) -> Option<&'a str> {
    match command {
        // browser_gateway::dispatch reads this exact field for both commands.
        "browser_session_ensure" | "browser_profile_delete" => args.get("workspaceId")?.as_str(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
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
                0 => Ok(vec!["host.global-surfaces".into(), "execution.request".into()]),
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
