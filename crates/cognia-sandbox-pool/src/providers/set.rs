//! The provider set: one sandbox arm, several drivers behind it (ADR-0221).
//!
//! `SandboxRoutingBackend` has exactly one sandbox backend. That backend is
//! this set: each member is a complete driver (the local Docker driver, or the
//! same driver over a remote provider), keyed by provider id. A spawn goes to
//! the member its placement names (`local` when it names none) and every
//! later call goes to the member that owns the agent, exactly as the router
//! itself routes existing versus sandbox.
//!
//! Hosted tool leases are registered before the spawn that uses them, so
//! before anyone knows which member will run it. The set registers each lease
//! with every member under one composite id and rewrites the placement's
//! lease ids for the member the spawn goes to.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use async_trait::async_trait;
use cognia_environment::spec::IsolationTier;
use cognia_external_agent::exec_backend::ExecBackend;
use cognia_external_agent::process::{
    ExternalAgentEventSink, ExternalAgentProcessState, ExternalAgentSpawnConfig,
};
use cognia_external_agent::sandbox_routing_backend::{
    SandboxExecBackend, SandboxPlacement, SandboxSpawnError, LOCAL_PROVIDER_ID,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::remote::RemoteLimits;
use crate::runtime::{
    RuntimePort, SandboxRuntimeControl, TaskShellRequest, TaskShellResult, ToolHostBridge,
    ToolHostService,
};
use crate::status::{RemoteUsage, SandboxDriverStatus};

/// One driver of the set.
#[derive(Clone)]
pub struct ProviderMember {
    pub id: String,
    pub label: Option<String>,
    pub exec: Arc<dyn SandboxExecBackend>,
    pub status: Arc<dyn SandboxDriverStatus>,
    pub runtime: Option<Arc<dyn SandboxRuntimeControl>>,
    /// `None` for the local driver, whose limits are the Host's own.
    pub limits: Option<RemoteLimits>,
}

/// What the console shows about one member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: String,
    pub driver: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub remote: bool,
    pub is_default: bool,
    pub reachable: bool,
    pub available_tiers: Vec<IsolationTier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<ProviderLimitsView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<RemoteUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLimitsView {
    pub max_concurrent: u32,
    pub max_lifetime_secs: u64,
    pub idle_timeout_secs: u64,
}

pub struct ProviderSet {
    members: BTreeMap<String, ProviderMember>,
    /// The remote member `auto` placement uses (ADR-0221 D9).
    default_remote: Option<String>,
    owners: Mutex<HashMap<String, String>>,
    /// Composite tool lease id → member id → that member's lease id.
    tool_leases: Mutex<HashMap<String, BTreeMap<String, String>>>,
    /// Bridge id → the member that opened it.
    bridges: Mutex<HashMap<String, String>>,
}

impl ProviderSet {
    /// A set with at least one member. `default_remote` must name a member.
    pub fn new(
        members: Vec<ProviderMember>,
        default_remote: Option<String>,
    ) -> Result<Arc<Self>, String> {
        if members.is_empty() {
            return Err("a provider set needs at least one driver".into());
        }
        let mut map = BTreeMap::new();
        for member in members {
            let id = member.id.clone();
            if map.insert(id.clone(), member).is_some() {
                return Err(format!("provider {id} is installed twice"));
            }
        }
        if let Some(default) = &default_remote {
            if !map.contains_key(default) || default == LOCAL_PROVIDER_ID {
                return Err(format!("the default provider {default} is not a remote member"));
            }
        }
        Ok(Arc::new(Self {
            members: map,
            default_remote,
            owners: Mutex::new(HashMap::new()),
            tool_leases: Mutex::new(HashMap::new()),
            bridges: Mutex::new(HashMap::new()),
        }))
    }

    /// The runtime control of the provider a task shell names.
    fn task_shell_runtime(
        &self,
        provider: &str,
    ) -> Result<Arc<dyn SandboxRuntimeControl>, SandboxSpawnError> {
        let member = self.members.get(provider).ok_or_else(|| {
            SandboxSpawnError::refused(
                "sandbox_provider_unknown",
                format!("this Host has no sandbox provider {provider}"),
            )
        })?;
        member.runtime.clone().ok_or_else(|| {
            SandboxSpawnError::refused(
                "sandbox_task_shell_unsupported",
                format!("sandbox provider {provider} cannot run task shell commands"),
            )
        })
    }

    pub fn member(&self, id: &str) -> Option<&ProviderMember> {
        self.members.get(id)
    }

    pub fn member_ids(&self) -> impl Iterator<Item = &str> {
        self.members.keys().map(String::as_str)
    }

    pub fn default_remote(&self) -> Option<&str> {
        self.default_remote.as_deref()
    }

    pub fn has_local(&self) -> bool {
        self.members.contains_key(LOCAL_PROVIDER_ID)
    }

    /// The member whose status is the set's top-level answer: the local
    /// driver, else the default remote provider, else the first.
    fn primary(&self) -> &ProviderMember {
        self.members
            .get(LOCAL_PROVIDER_ID)
            .or_else(|| {
                self.default_remote
                    .as_ref()
                    .and_then(|id| self.members.get(id))
            })
            .or_else(|| self.members.values().next())
            .expect("a provider set is never empty")
    }

    /// Every member, as the console lists them.
    pub async fn views(&self) -> Vec<ProviderView> {
        let mut views = Vec::with_capacity(self.members.len());
        for member in self.members.values() {
            let tiers = member.status.available_tiers().await;
            views.push(ProviderView {
                id: member.id.clone(),
                driver: member.status.driver().to_string(),
                label: member.label.clone(),
                remote: member.limits.is_some(),
                is_default: self.default_remote.as_deref() == Some(member.id.as_str()),
                reachable: tiers.is_ok(),
                unavailable_code: tiers.as_ref().err().map(|error| error.code.clone()),
                available_tiers: tiers.unwrap_or_default(),
                limits: member.limits.map(|limits| ProviderLimitsView {
                    max_concurrent: limits.max_concurrent,
                    max_lifetime_secs: limits.max_lifetime.as_secs(),
                    idle_timeout_secs: limits.idle_timeout.as_secs(),
                }),
                usage: member.status.remote_usage(),
            });
        }
        views
    }

    fn owner_of(&self, agent_id: &str) -> Option<ProviderMember> {
        let owner = self.owners.lock().get(agent_id).cloned();
        owner.and_then(|id| self.members.get(&id).cloned())
    }

    async fn find_owner(&self, agent_id: &str) -> Result<ProviderMember, String> {
        if let Some(member) = self.owner_of(agent_id) {
            return Ok(member);
        }
        // An owner unknown to this map (a cancelled spawn retained by a
        // member): ask every member, refusing to guess between two.
        let mut found = Vec::new();
        for member in self.members.values() {
            if member.exec.status(agent_id).await.is_some() {
                found.push(member.clone());
            }
        }
        match found.len() {
            1 => Ok(found.remove(0)),
            0 => Err(format!("Agent {agent_id} not found")),
            _ => Err(format!("Agent {agent_id} has conflicting provider owners")),
        }
    }

    /// Rewrite a placement's composite tool lease ids for `member`.
    fn translate_tool_leases(&self, config: &mut ExternalAgentSpawnConfig, member: &str) {
        let Some(SandboxPlacement::Container {
            hosted_tool_host_lease_ids,
            ..
        }) = config.sandbox.as_mut()
        else {
            return;
        };
        let leases = self.tool_leases.lock();
        for id in hosted_tool_host_lease_ids.iter_mut() {
            if let Some(per_member) = leases.get(id) {
                if let Some(translated) = per_member.get(member) {
                    *id = translated.clone();
                }
            }
        }
    }
}

#[async_trait]
impl SandboxExecBackend for ProviderSet {
    async fn spawn_sandboxed(
        &self,
        mut config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, SandboxSpawnError> {
        let Some(placement) = config.sandbox.as_ref() else {
            return Err(SandboxSpawnError::refused(
                "sandbox_placement_required",
                "a sandbox spawn must carry its runtime environment placement",
            ));
        };
        let provider = placement.provider().to_string();
        let Some(member) = self.members.get(&provider).cloned() else {
            return Err(SandboxSpawnError::refused(
                "sandbox_provider_unknown",
                format!("this Host has no sandbox provider {provider}"),
            ));
        };
        for other in self.members.values() {
            if other.id != member.id && other.exec.status(&config.id).await.is_some() {
                return Err(SandboxSpawnError::refused(
                    "sandbox_agent_exists",
                    format!("Agent {} already runs on provider {}", config.id, other.id),
                ));
            }
        }
        self.translate_tool_leases(&mut config, &member.id);
        let spawned = member.exec.spawn_sandboxed(config, sink).await?;
        self.owners.lock().insert(spawned.clone(), member.id.clone());
        Ok(spawned)
    }

    fn multi_tenant(&self) -> bool {
        self.members.values().any(|member| member.exec.multi_tenant())
    }
}

#[async_trait]
impl ExecBackend for ProviderSet {
    async fn delete_retained_gateway_task(
        &self,
        task_id: &str,
        device: Option<&str>,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        for member in self.members.values() {
            if let Err(error) = member
                .exec
                .delete_retained_gateway_task(task_id, device)
                .await
            {
                errors.push(format!("{}: {error}", member.id));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    async fn spawn(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, String> {
        self.spawn_sandboxed(config, sink)
            .await
            .map_err(|error| error.to_string())
    }

    async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        self.find_owner(id).await?.exec.send(id, message).await
    }

    async fn kill(&self, id: &str) -> Result<(), String> {
        self.find_owner(id).await?.exec.kill(id).await
    }

    async fn kill_all(&self) -> Result<(), String> {
        let mut errors = Vec::new();
        for member in self.members.values() {
            if let Err(error) = member.exec.kill_all().await {
                errors.push(format!("{}: {error}", member.id));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        match self.owner_of(id) {
            Some(member) => member.exec.status(id).await,
            None => {
                for member in self.members.values() {
                    if let Some(state) = member.exec.status(id).await {
                        return Some(state);
                    }
                }
                None
            }
        }
    }

    async fn list(&self) -> Vec<String> {
        let mut ids = Vec::new();
        for member in self.members.values() {
            ids.extend(member.exec.list().await);
        }
        ids.sort();
        ids.dedup();
        ids
    }

    async fn is_running(&self, id: &str) -> Result<bool, String> {
        self.find_owner(id).await?.exec.is_running(id).await
    }

    async fn get_info(&self, id: &str) -> Result<Value, String> {
        self.find_owner(id).await?.exec.get_info(id).await
    }

    async fn set_running(&self, id: &str) -> Result<(), String> {
        self.find_owner(id).await?.exec.set_running(id).await
    }

    async fn set_failed(&self, id: &str) -> Result<(), String> {
        self.find_owner(id).await?.exec.set_failed(id).await
    }

    fn kind(&self) -> &'static str {
        "container"
    }

    async fn reap_orphans(&self) -> Result<Vec<String>, String> {
        let mut reaped = Vec::new();
        let mut errors = Vec::new();
        for member in self.members.values() {
            match member.exec.reap_orphans().await {
                Ok(more) => reaped.extend(more),
                Err(error) => errors.push(format!("{}: {error}", member.id)),
            }
        }
        if !errors.is_empty() {
            log::warn!("sandbox orphan sweep incomplete: {}", errors.join("; "));
        }
        reaped.sort();
        reaped.dedup();
        Ok(reaped)
    }

    fn routes_sandboxes(&self) -> bool {
        true
    }
}

#[async_trait]
impl SandboxDriverStatus for ProviderSet {
    fn driver(&self) -> &'static str {
        self.primary().status.driver()
    }

    fn deployment_id(&self) -> &str {
        self.primary().status.deployment_id()
    }

    fn instance_id(&self) -> &str {
        self.primary().status.instance_id()
    }

    async fn available_tiers(&self) -> Result<Vec<IsolationTier>, SandboxSpawnError> {
        self.primary().status.available_tiers().await
    }
}

fn unsupported() -> SandboxSpawnError {
    SandboxSpawnError::refused(
        "sandbox_service_unsupported",
        "This runtime does not support hosted services",
    )
}

#[async_trait]
impl SandboxRuntimeControl for ProviderSet {
    async fn exec_task_shell(
        &self,
        request: TaskShellRequest,
    ) -> Result<TaskShellResult, SandboxSpawnError> {
        let provider = request.placement.provider().to_string();
        let runtime = self.task_shell_runtime(&provider)?;
        let mut result = runtime.exec_task_shell(request).await?;
        result.provider = provider;
        Ok(result)
    }

    async fn release_task_shell(
        &self,
        provider: &str,
        container_ids: &[String],
    ) -> Result<Vec<String>, SandboxSpawnError> {
        self.task_shell_runtime(provider)?
            .release_task_shell(provider, container_ids)
            .await
    }

    fn agent_origin_allowed(&self, agent_id: &str, device_id: &str) -> Option<bool> {
        let member = self.owner_of(agent_id)?;
        member.runtime.as_ref()?.agent_origin_allowed(agent_id, device_id)
    }

    async fn register_tool_host(
        &self,
        service: ToolHostService,
    ) -> Result<String, SandboxSpawnError> {
        let mut per_member = BTreeMap::new();
        for member in self.members.values() {
            let Some(runtime) = member.runtime.as_ref() else {
                continue;
            };
            let lease = runtime.register_tool_host(service.clone()).await?;
            per_member.insert(member.id.clone(), lease);
        }
        if per_member.is_empty() {
            return Err(unsupported());
        }
        let composite = uuid::Uuid::new_v4().to_string();
        let mut leases = self.tool_leases.lock();
        // Pending leases live 60 s in each member; keep this map bounded the
        // same way a member bounds its own pending set.
        if leases.len() >= 512 {
            leases.clear();
        }
        leases.insert(composite.clone(), per_member);
        Ok(composite)
    }

    async fn open_tool_host(
        &self,
        service: ToolHostService,
    ) -> Result<ToolHostBridge, SandboxSpawnError> {
        let member = self
            .find_owner(&service.agent_id)
            .await
            .map_err(|error| SandboxSpawnError::refused("sandbox_service_unavailable", error))?;
        let runtime = member.runtime.clone().ok_or_else(unsupported)?;
        let bridge = runtime.open_tool_host(service).await?;
        self.bridges
            .lock()
            .insert(bridge.bridge_id.clone(), member.id.clone());
        Ok(bridge)
    }

    fn renew_tool_host(&self, bridge_id: &str) -> bool {
        let owner = self.bridges.lock().get(bridge_id).cloned();
        owner
            .and_then(|id| self.members.get(&id))
            .and_then(|member| member.runtime.as_ref())
            .is_some_and(|runtime| runtime.renew_tool_host(bridge_id))
    }

    fn close_tool_host(&self, bridge_id: &str) {
        let owner = self.bridges.lock().remove(bridge_id);
        if let Some(runtime) = owner
            .and_then(|id| self.members.get(&id))
            .and_then(|member| member.runtime.as_ref())
        {
            runtime.close_tool_host(bridge_id);
        }
    }

    async fn list_ports(&self, project_id: &str) -> Result<Vec<RuntimePort>, SandboxSpawnError> {
        let mut ports = Vec::new();
        for runtime in self.members.values().filter_map(|member| member.runtime.as_ref()) {
            ports.extend(runtime.list_ports(project_id).await?);
        }
        Ok(ports)
    }

    async fn port_allowed(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<bool, SandboxSpawnError> {
        for runtime in self.members.values().filter_map(|member| member.runtime.as_ref()) {
            if runtime.port_allowed(project_id, container_id, port).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn open_port(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<tokio::io::DuplexStream, SandboxSpawnError> {
        for runtime in self.members.values().filter_map(|member| member.runtime.as_ref()) {
            if runtime.port_allowed(project_id, container_id, port).await? {
                return runtime.open_port(project_id, container_id, port).await;
            }
        }
        Err(SandboxSpawnError::refused(
            "sandbox_port_unavailable",
            "no sandbox provider runs that runtime port",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_external_agent::exec_backend::test_support::RecordingAgentEmitter;
    use cognia_external_agent::exec_backend::EmitterEventSink;
    use cognia_external_agent::sandbox_routing_backend::SandboxErrorKind;
    use serde_json::json;
    use std::collections::HashMap as StdHashMap;
    use std::time::Duration;

    /// A member that records spawns and tool leases.
    #[derive(Default)]
    struct Member {
        driver: &'static str,
        tiers: Vec<IsolationTier>,
        running: Mutex<Vec<String>>,
        spawned: Mutex<Vec<ExternalAgentSpawnConfig>>,
        registered: Mutex<Vec<String>>,
        released: Mutex<Vec<(String, Vec<String>)>>,
        unreachable: bool,
    }

    #[async_trait]
    impl ExecBackend for Member {
        async fn spawn(
            &self,
            config: ExternalAgentSpawnConfig,
            sink: Arc<dyn ExternalAgentEventSink>,
        ) -> Result<String, String> {
            self.spawn_sandboxed(config, sink)
                .await
                .map_err(|error| error.to_string())
        }
        async fn send(&self, _id: &str, _message: &str) -> Result<(), String> {
            Ok(())
        }
        async fn kill(&self, id: &str) -> Result<(), String> {
            self.running.lock().retain(|running| running != id);
            Ok(())
        }
        async fn kill_all(&self) -> Result<(), String> {
            self.running.lock().clear();
            Ok(())
        }
        async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
            self.running
                .lock()
                .iter()
                .any(|running| running == id)
                .then_some(ExternalAgentProcessState::Running)
        }
        async fn list(&self) -> Vec<String> {
            self.running.lock().clone()
        }
        async fn is_running(&self, id: &str) -> Result<bool, String> {
            Ok(self.status(id).await.is_some())
        }
        async fn get_info(&self, id: &str) -> Result<Value, String> {
            Ok(json!({ "id": id, "driver": self.driver }))
        }
        async fn set_running(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
        async fn set_failed(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
        fn kind(&self) -> &'static str {
            "container"
        }
    }

    #[async_trait]
    impl SandboxExecBackend for Member {
        async fn spawn_sandboxed(
            &self,
            config: ExternalAgentSpawnConfig,
            _sink: Arc<dyn ExternalAgentEventSink>,
        ) -> Result<String, SandboxSpawnError> {
            let id = config.id.clone();
            self.spawned.lock().push(config);
            self.running.lock().push(id.clone());
            Ok(id)
        }
        fn multi_tenant(&self) -> bool {
            false
        }
    }

    #[async_trait]
    impl SandboxDriverStatus for Member {
        fn driver(&self) -> &'static str {
            self.driver
        }
        fn deployment_id(&self) -> &str {
            "dep1"
        }
        fn instance_id(&self) -> &str {
            self.driver
        }
        async fn available_tiers(&self) -> Result<Vec<IsolationTier>, SandboxSpawnError> {
            if self.unreachable {
                return Err(SandboxSpawnError::fault(
                    "sandbox_provider_unreachable",
                    "down",
                ));
            }
            Ok(self.tiers.clone())
        }
    }

    #[async_trait]
    impl SandboxRuntimeControl for Member {
        // Only the local driver runs task shells, as on a real Host.
        async fn exec_task_shell(
            &self,
            request: TaskShellRequest,
        ) -> Result<TaskShellResult, SandboxSpawnError> {
            if self.driver != "docker" {
                return Err(SandboxSpawnError::refused(
                    "sandbox_task_shell_remote_unsupported",
                    "remote",
                ));
            }
            Ok(TaskShellResult {
                exit_code: Some(0),
                stdout: request.argv.join(" "),
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                timed_out: false,
                duration_ms: 1,
                provider: "set-by-the-member".into(),
                container_id: format!("{}-runtime", self.driver),
                tier: "container".into(),
            })
        }
        async fn release_task_shell(
            &self,
            provider: &str,
            container_ids: &[String],
        ) -> Result<Vec<String>, SandboxSpawnError> {
            self.released
                .lock()
                .push((provider.to_string(), container_ids.to_vec()));
            Ok(container_ids.to_vec())
        }
        async fn register_tool_host(
            &self,
            service: ToolHostService,
        ) -> Result<String, SandboxSpawnError> {
            let lease = format!("{}-lease-{}", self.driver, service.lease_id);
            self.registered.lock().push(lease.clone());
            Ok(lease)
        }
        async fn list_ports(&self, _project: &str) -> Result<Vec<RuntimePort>, SandboxSpawnError> {
            Ok(vec![RuntimePort {
                container_id: format!("{}-runtime", self.driver),
                project_id: "p".into(),
                port: 3000,
                label: None,
                path: String::new(),
            }])
        }
        async fn port_allowed(
            &self,
            _project: &str,
            container: &str,
            _port: u16,
        ) -> Result<bool, SandboxSpawnError> {
            Ok(container == format!("{}-runtime", self.driver))
        }
        async fn open_port(
            &self,
            _project: &str,
            _container: &str,
            _port: u16,
        ) -> Result<tokio::io::DuplexStream, SandboxSpawnError> {
            Ok(tokio::io::duplex(8).0)
        }
    }

    fn member(id: &str, driver: &'static str, remote: bool) -> (ProviderMember, Arc<Member>) {
        let backend = Arc::new(Member {
            driver,
            tiers: vec![if remote { IsolationTier::Vm } else { IsolationTier::Container }],
            ..Default::default()
        });
        (
            ProviderMember {
                id: id.into(),
                label: None,
                exec: backend.clone(),
                status: backend.clone(),
                runtime: Some(backend.clone()),
                limits: remote.then_some(RemoteLimits {
                    max_concurrent: 4,
                    max_lifetime: Duration::from_secs(7200),
                    idle_timeout: Duration::from_secs(600),
                }),
            },
            backend,
        )
    }

    fn placed(id: &str, provider: Option<&str>, leases: Vec<String>) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: id.into(),
            command: "codex-acp".into(),
            args: vec![],
            env: StdHashMap::new(),
            cwd: None,
            framing: Default::default(),
            sandbox_policy: Default::default(),
            sandbox: Some(SandboxPlacement::Container {
                hosted_tool_host_lease_ids: leases,
                provider: provider.map(str::to_string),
                workspace: None,
                spec: json!({}),
                isolation_mandatory: false,
            }),
        }
    }

    fn sink() -> Arc<dyn ExternalAgentEventSink> {
        EmitterEventSink::new(RecordingAgentEmitter::new())
    }

    fn service() -> ToolHostService {
        ToolHostService {
            agent_id: "parent".into(),
            owner_session_id: "chat".into(),
            origin_device_id: None,
            lease_id: "x".repeat(16),
            generation: 1,
            port: 4000,
            authorization: Some(Arc::new(|| true)),
        }
    }

    #[tokio::test]
    async fn a_spawn_goes_to_the_member_its_placement_names_and_stays_there() {
        let (local, local_backend) = member("local", "docker", false);
        let (cloud, cloud_backend) = member("cloud", "e2b", true);
        let set = ProviderSet::new(vec![local, cloud], Some("cloud".into())).unwrap();

        set.spawn_sandboxed(placed("a", None, vec![]), sink()).await.unwrap();
        set.spawn_sandboxed(placed("b", Some("cloud"), vec![]), sink())
            .await
            .unwrap();
        assert_eq!(local_backend.spawned.lock().len(), 1);
        assert_eq!(cloud_backend.spawned.lock().len(), 1);
        assert_eq!(set.get_info("b").await.unwrap()["driver"], "e2b");
        assert_eq!(set.list().await, vec!["a".to_string(), "b".to_string()]);

        set.kill("b").await.unwrap();
        assert!(cloud_backend.running.lock().is_empty());
        assert_eq!(local_backend.running.lock().clone(), vec!["a".to_string()]);
    }

    #[tokio::test]
    async fn task_shells_go_to_the_member_their_placement_names() {
        let (local, local_backend) = member("local", "docker", false);
        let (cloud, cloud_backend) = member("cloud", "e2b", true);
        let set = ProviderSet::new(vec![local, cloud], Some("cloud".into())).unwrap();
        let request = |provider: Option<&str>| TaskShellRequest {
            placement: placed("t", provider, vec![]).sandbox.unwrap(),
            owner: "session:s".into(),
            workspace_root: "/w".into(),
            workspace_path: "/w".into(),
            cwd: "/w".into(),
            argv: vec!["true".into()],
            env: BTreeMap::new(),
            stdin: None,
            timeout_ms: 1000,
        };

        let result = set.exec_task_shell(request(None)).await.unwrap();
        assert_eq!(result.provider, "local");
        assert_eq!(result.container_id, "docker-runtime");
        assert_eq!(
            set.exec_task_shell(request(Some("cloud")))
                .await
                .unwrap_err()
                .code,
            "sandbox_task_shell_remote_unsupported"
        );
        assert_eq!(
            set.exec_task_shell(request(Some("elsewhere")))
                .await
                .unwrap_err()
                .code,
            "sandbox_provider_unknown"
        );

        let ids = vec!["docker-runtime".to_string()];
        assert_eq!(set.release_task_shell("local", &ids).await.unwrap(), ids);
        assert_eq!(
            local_backend.released.lock().clone(),
            vec![("local".to_string(), ids.clone())]
        );
        assert!(cloud_backend.released.lock().is_empty());
        assert_eq!(
            set.release_task_shell("elsewhere", &ids)
                .await
                .unwrap_err()
                .code,
            "sandbox_provider_unknown"
        );
    }

    #[tokio::test]
    async fn an_unknown_provider_or_a_duplicate_id_is_refused() {
        let (local, _) = member("local", "docker", false);
        let (cloud, _) = member("cloud", "e2b", true);
        let set = ProviderSet::new(vec![local, cloud], None).unwrap();
        let error = set
            .spawn_sandboxed(placed("a", Some("elsewhere"), vec![]), sink())
            .await
            .unwrap_err();
        assert_eq!(error.kind, SandboxErrorKind::Refused);
        assert_eq!(error.code, "sandbox_provider_unknown");

        set.spawn_sandboxed(placed("a", None, vec![]), sink()).await.unwrap();
        let duplicate = set
            .spawn_sandboxed(placed("a", Some("cloud"), vec![]), sink())
            .await
            .unwrap_err();
        assert_eq!(duplicate.code, "sandbox_agent_exists");
    }

    #[tokio::test]
    async fn a_remote_only_host_has_no_local_member() {
        let (cloud, _) = member("cloud", "e2b", true);
        let set = ProviderSet::new(vec![cloud], Some("cloud".into())).unwrap();
        assert!(!set.has_local());
        let error = set
            .spawn_sandboxed(placed("a", None, vec![]), sink())
            .await
            .unwrap_err();
        assert_eq!(error.code, "sandbox_provider_unknown");
        assert_eq!(set.driver(), "e2b");
    }

    #[test]
    fn construction_refuses_an_empty_set_a_duplicate_or_a_local_default() {
        assert!(ProviderSet::new(Vec::new(), None).is_err());
        let (a, _) = member("cloud", "e2b", true);
        let (b, _) = member("cloud", "e2b", true);
        assert!(ProviderSet::new(vec![a, b], None).is_err());
        let (local, _) = member("local", "docker", false);
        assert!(ProviderSet::new(vec![local.clone()], Some("local".into())).is_err());
        assert!(ProviderSet::new(vec![local], Some("missing".into())).is_err());
    }

    #[tokio::test]
    async fn a_tool_lease_registered_before_the_spawn_reaches_whichever_member_runs_it() {
        let (local, local_backend) = member("local", "docker", false);
        let (cloud, cloud_backend) = member("cloud", "e2b", true);
        let set = ProviderSet::new(vec![local, cloud], None).unwrap();
        let composite = set.register_tool_host(service()).await.unwrap();
        assert_eq!(local_backend.registered.lock().len(), 1);
        assert_eq!(cloud_backend.registered.lock().len(), 1);

        set.spawn_sandboxed(placed("a", Some("cloud"), vec![composite]), sink())
            .await
            .unwrap();
        let spawned = cloud_backend.spawned.lock()[0].clone();
        assert_eq!(
            spawned
                .sandbox
                .as_ref()
                .unwrap()
                .hosted_tool_host_lease_ids(),
            &[format!("e2b-lease-{}", "x".repeat(16))]
        );
    }

    #[tokio::test]
    async fn ports_are_listed_from_every_member_and_opened_on_the_owning_one() {
        let (local, _) = member("local", "docker", false);
        let (cloud, _) = member("cloud", "e2b", true);
        let set = ProviderSet::new(vec![local, cloud], None).unwrap();
        let ports = set.list_ports("p").await.unwrap();
        assert_eq!(ports.len(), 2);
        assert!(set.port_allowed("p", "e2b-runtime", 3000).await.unwrap());
        assert!(!set.port_allowed("p", "elsewhere", 3000).await.unwrap());
        assert!(set.open_port("p", "e2b-runtime", 3000).await.is_ok());
        assert_eq!(
            set.open_port("p", "elsewhere", 3000).await.unwrap_err().code,
            "sandbox_port_unavailable"
        );
    }

    #[tokio::test]
    async fn the_console_sees_every_member_and_which_one_is_unreachable() {
        let (local, _) = member("local", "docker", false);
        let down = Arc::new(Member {
            driver: "kubernetes",
            unreachable: true,
            ..Default::default()
        });
        let cluster = ProviderMember {
            id: "cluster".into(),
            label: Some("Cluster".into()),
            exec: down.clone(),
            status: down.clone(),
            runtime: None,
            limits: Some(RemoteLimits {
                max_concurrent: 2,
                max_lifetime: Duration::from_secs(3600),
                idle_timeout: Duration::from_secs(300),
            }),
        };
        let set = ProviderSet::new(vec![local, cluster], Some("cluster".into())).unwrap();
        let views = set.views().await;
        let cluster = views.iter().find(|view| view.id == "cluster").unwrap();
        assert!(cluster.remote && cluster.is_default && !cluster.reachable);
        assert_eq!(cluster.unavailable_code.as_deref(), Some("sandbox_provider_unreachable"));
        assert_eq!(cluster.limits.unwrap().max_concurrent, 2);
        let local = views.iter().find(|view| view.id == "local").unwrap();
        assert!(!local.remote && local.reachable && local.limits.is_none());
        assert_eq!(set.driver(), "docker");
    }
}
