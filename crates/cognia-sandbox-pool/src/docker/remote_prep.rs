//! The remote preparation branch of the sandbox driver (ADR-0221).
//!
//! A remote provider has no named volumes to stage the bundle into and no Host
//! workspace to mount, so preparation is the one thing that differs from a
//! local Docker spawn. In order:
//!
//! 1. admit the spec against the tiers the provider attests;
//! 2. refuse an egress tier the provider cannot enforce when isolation is
//!    mandatory;
//! 3. take a provider slot ([`RemoteLimits::max_concurrent`]);
//! 4. reuse a retained persistent instance by runtime key, or provision one
//!    with the bundle injected natively and the lifetime written into the
//!    provider's own TTL;
//! 5. probe the image over exec (the probe cache is shared with Docker);
//! 6. clone the workspace as the agent's user through the Host's git proxy,
//!    bridged into the instance at [`GIT_PROXY_SANDBOX_PORT`];
//! 7. release the instance's `sandboxd serve` supervisor and wait for its
//!    lifecycle hooks;
//! 8. start the agent as a `connect-agent` session, adopt it, and open the
//!    gateway and tool-host bridges through the unchanged
//!    `finish_gateway_spawn`.
//!
//! When a session ends, [`RemoteSession`] commits and pushes the workspace to
//! the task's branch, reports it on `external-agent://workspace-publish`, and
//! destroys an ephemeral instance. A persistent instance is kept until it has
//! had no session for [`RemoteLimits::idle_timeout`]; every instance is
//! destroyed at its deadline whatever it is doing.

use std::sync::atomic::{AtomicBool, Ordering};

use super::persistent::{
    exec_spec, runtime_ready, sha256_hex, SessionApi, PROJECT_LABEL, RUNTIME_KEY_LABEL, SOCKET,
};
use super::services::{pump_bridge, BridgeGuard, BridgeTarget};
use super::*;
use crate::git_proxy::{is_valid_branch, GitProxy, GitProxyConfig};
use crate::remote::{
    instance_name, EgressPlan, ProvisionRequest, RemoteLimits, RemoteProvider, RemoteProvisioner,
    CAPACITY_WAIT, GIT_PROXY_SANDBOX_PORT,
};
use cognia_external_agent::container_backend::{RunnerExecSpec, PERSISTENT_RUNTIME_LABEL};
use cognia_external_agent::sandbox_routing_backend::RemoteWorkspaceSource;
use cognia_sandboxd::layout::COMMON_DIR;

/// Which provider an instance belongs to, on every instance it creates.
pub const PROVIDER_LABEL: &str = "cognia.provider";
/// Unix seconds after which the instance is destroyed, on every instance, so
/// a Host that restarts still knows the deadline of what it adopts.
pub const EXPIRES_AT_LABEL: &str = "cognia.expires-at";

/// The bundled, static git (ADR-0183 `common/`).
fn git_binary() -> String {
    format!("{INJECTION_ROOT}/{COMMON_DIR}/bin/git")
}

/// The workspace URL inside the instance: the git proxy's bridge.
fn proxy_url() -> String {
    format!("http://127.0.0.1:{GIT_PROXY_SANDBOX_PORT}/repo.git")
}

/// Cloning a large repository is the slowest step of a cold remote start.
const CLONE_TIMEOUT: Duration = Duration::from_secs(1800);
/// One git command of a publish.
const GIT_TIMEOUT: Duration = Duration::from_secs(600);
/// How often deadlines and idle instances are checked.
const REAP_INTERVAL: Duration = Duration::from_secs(15);
/// How long a deadline waits for sessions to exit before destroying anyway.
const DEADLINE_GRACE: Duration = Duration::from_secs(30);

fn refused(code: &str, message: impl Into<String>) -> SandboxSpawnError {
    SandboxSpawnError::refused(code, message.into())
}

fn fault(code: &str, message: impl Into<String>) -> SandboxSpawnError {
    SandboxSpawnError::fault(code, message.into())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// The remote half of a driver: which provider, its limits, and the instances
/// this process is responsible for.
pub(crate) struct RemoteParts {
    pub(super) provider_id: String,
    pub(super) provisioner: Arc<dyn RemoteProvisioner>,
    pub(super) limits: RemoteLimits,
    slots: Arc<tokio::sync::Semaphore>,
    instances: Mutex<HashMap<String, Instance>>,
    reaper: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Drop for RemoteParts {
    fn drop(&mut self) {
        if let Some(reaper) = self.reaper.lock().take() {
            reaper.abort();
        }
    }
}

/// One instance this process holds a slot for.
struct Instance {
    _slot: tokio::sync::OwnedSemaphorePermit,
    persistent: bool,
    deadline: tokio::time::Instant,
    /// Agent ids with a live session in it.
    sessions: BTreeSet<String>,
    /// Since when it has had no session (persistent instances only).
    idle_since: Option<tokio::time::Instant>,
    /// When the deadline sweep asked its sessions to stop.
    stopping_since: Option<tokio::time::Instant>,
    /// Which workspace bridge is current; a bridge whose guard holds another
    /// generation closes on its next tick.
    link_generation: u64,
    workspace: Option<Arc<WorkspaceLink>>,
}

impl Instance {
    fn new(
        slot: tokio::sync::OwnedSemaphorePermit,
        persistent: bool,
        deadline: tokio::time::Instant,
        idle_since: Option<tokio::time::Instant>,
    ) -> Self {
        Self {
            _slot: slot,
            persistent,
            deadline,
            sessions: BTreeSet::new(),
            idle_since,
            stopping_since: None,
            link_generation: 0,
            workspace: None,
        }
    }
}

/// The git proxy for one instance's workspace and the bridge that exposes it
/// inside the instance. Dropping it stops both.
struct WorkspaceLink {
    source: RemoteWorkspaceSource,
    user: UserSpec,
    /// The commit the workspace was cloned at; `None` for an instance adopted
    /// after a Host restart, whose clone predates this process.
    base_commit: Mutex<Option<String>>,
    _proxy: GitProxy,
    stop: tokio::sync::watch::Sender<bool>,
    bridge: tokio::task::JoinHandle<()>,
}

impl Drop for WorkspaceLink {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        self.bridge.abort();
    }
}

impl WorkspaceLink {
    fn alive(&self) -> bool {
        !self.bridge.is_finished()
    }
}

/// A completed one-shot exec.
struct ExecOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    code: Option<i64>,
}

impl ExecOutput {
    fn tail(&self) -> String {
        let stderr = String::from_utf8_lossy(&self.stderr);
        let text = if stderr.trim().is_empty() {
            String::from_utf8_lossy(&self.stdout).to_string()
        } else {
            stderr.to_string()
        };
        let trimmed = text.trim();
        let start = trimmed.len().saturating_sub(400);
        let start = (start..=trimmed.len())
            .find(|index| trimmed.is_char_boundary(*index))
            .unwrap_or(trimmed.len());
        trimmed[start..].to_string()
    }

    fn succeeded(&self) -> bool {
        self.code == Some(0)
    }
}

/// Validate what the dispatching client says the workspace is. The URL is the
/// one upstream the git proxy will ever reach; the branch is the only ref the
/// sandbox may push.
fn validate_source(source: &RemoteWorkspaceSource) -> Result<(), SandboxSpawnError> {
    let invalid = |message: &str| refused("sandbox_workspace_remote_invalid", message);
    let url = url::Url::parse(&source.remote_url)
        .map_err(|_| invalid("the workspace remote is not a URL"))?;
    if url.scheme() != "https" {
        return Err(invalid("the workspace remote must be an https:// URL"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("the workspace remote must not carry credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(invalid("the workspace remote must not carry a query or fragment"));
    }
    if !is_valid_branch(&source.branch) {
        return Err(invalid("the workspace branch is not a valid branch name"));
    }
    if !is_valid_branch(&source.base_ref) {
        return Err(invalid("the workspace base ref is not a valid branch or tag name"));
    }
    Ok(())
}

/// The identity a remote runtime is reused by. A persistent instance is one
/// workspace: the same spec, provider, repository and branch. An ephemeral
/// one is unique to its spawn.
fn remote_runtime_key(
    provider_id: &str,
    spec: &EnvironmentSpec,
    source: &RemoteWorkspaceSource,
    ephemeral: Option<&str>,
) -> String {
    let identity = format!(
        "remote\0{provider_id}\0{}\0{}\0{}\0{}",
        spec.spec_digest,
        source.remote_url,
        source.branch,
        ephemeral.unwrap_or("persistent"),
    );
    sha256_hex(identity.as_bytes())
}

/// What runs the bundled git as the agent's user, with no inherited config.
fn git_invocation(user: &UserSpec, args: &[&str]) -> Vec<String> {
    let mut command = vec![
        format!("{INJECTION_ROOT}/bin/cognia-sandboxd"),
        "init-agent".into(),
        "--root".into(),
        "/".into(),
        "--bundle".into(),
        INJECTION_ROOT.into(),
        "--user".into(),
        user.to_string(),
        "--cwd".into(),
        "/".into(),
        "--".into(),
        git_binary(),
        "-c".into(),
        "core.hooksPath=/dev/null".into(),
        "-c".into(),
        "credential.helper=".into(),
        "-c".into(),
        "protocol.allow=never".into(),
        "-c".into(),
        "protocol.http.allow=always".into(),
    ];
    command.extend(args.iter().map(|arg| (*arg).to_string()));
    command
}

/// The environment every git command gets: no prompts, no system or global
/// config, and nothing the image may have baked in about credentials.
fn git_runtime_env() -> Result<Vec<String>, SandboxSpawnError> {
    let runtime = RuntimeConfigV1 {
        spawn_env: BTreeMap::from([
            ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
            ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
            ("GIT_CONFIG_GLOBAL".to_string(), "/dev/null".to_string()),
            ("GIT_ASKPASS".to_string(), "/bin/false".to_string()),
        ])
        .into_iter()
        .collect(),
        workspace_folder: WORKSPACE_TARGET.to_string(),
        ..RuntimeConfigV1::default()
    };
    encode_runtime_config_env(&runtime)
        .map_err(|error| refused("sandbox_runtime_config_invalid", error.to_string()))
}

impl RemoteParts {
    pub(crate) fn new(
        provider_id: String,
        provisioner: Arc<dyn RemoteProvisioner>,
        limits: RemoteLimits,
    ) -> Self {
        Self {
            provider_id,
            provisioner,
            limits,
            slots: Arc::new(tokio::sync::Semaphore::new(
                limits.max_concurrent.max(1) as usize,
            )),
            instances: Mutex::new(HashMap::new()),
            reaper: Mutex::new(None),
        }
    }

    fn workspace(&self, instance: &str) -> Option<Arc<WorkspaceLink>> {
        self.instances
            .lock()
            .get(instance)
            .and_then(|entry| entry.workspace.clone())
    }

    /// Instances this process tracks, and how many sessions each has; for
    /// the console.
    pub(crate) fn snapshot(&self) -> (usize, usize) {
        let instances = self.instances.lock();
        let sessions = instances.values().map(|entry| entry.sessions.len()).sum();
        (instances.len(), sessions)
    }
}

/// A bridge to an instance-scoped Host service (the git proxy): alive while
/// this process still tracks the instance and this bridge is its current one.
struct InstanceBridgeGuard {
    backend: Weak<DockerSandboxBackend>,
    instance: String,
    generation: u64,
}

impl InstanceBridgeGuard {
    fn current(&self) -> bool {
        let Some(backend) = self.backend.upgrade() else {
            return false;
        };
        let Some(remote) = backend.remote.as_ref() else {
            return false;
        };
        let current = remote
            .instances
            .lock()
            .get(&self.instance)
            .is_some_and(|entry| entry.link_generation == self.generation);
        current
    }
}

impl BridgeGuard for InstanceBridgeGuard {
    fn tick(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(async move { self.current() })
    }
    fn admit(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(async move { self.current() })
    }
}

impl DockerSandboxBackend {
    /// A driver whose container surface is a remote provider (ADR-0221).
    pub fn new_remote(
        provider_id: String,
        provider: Arc<dyn RemoteProvider>,
        limits: RemoteLimits,
        admission: Arc<dyn SandboxAdmission>,
        config: DockerSandboxConfig,
    ) -> Arc<Self> {
        let api: Arc<dyn SandboxDockerApi> = provider.clone();
        let provisioner: Arc<dyn RemoteProvisioner> = provider;
        Self::build(
            api,
            admission,
            config,
            Some(RemoteParts::new(provider_id, provisioner, limits)),
        )
    }

    /// Start the deadline and idle sweep once, from inside the runtime that
    /// runs the driver (construction may happen before one exists).
    fn ensure_remote_reaper(&self) {
        let Some(remote) = self.remote.as_ref() else {
            return;
        };
        let mut reaper = remote.reaper.lock();
        if reaper.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let weak = self.own.clone();
        *reaper = Some(tokio::spawn(async move {
            let mut tick = tokio::time::interval(REAP_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let Some(backend) = weak.upgrade() else {
                    return;
                };
                backend.sweep_remote_instances().await;
            }
        }));
    }

    /// Pull credentials for `registry`, and whether the provider may have
    /// them. A registry that needs none is always fine.
    fn delegated_auth(
        &self,
        remote: &RemoteParts,
        registry: &str,
    ) -> Result<Option<RegistryAuth>, SandboxSpawnError> {
        let auth = self.admission.registry_auth(registry)?;
        if auth.is_some() && !remote.provisioner.may_receive_registry_credentials(registry) {
            return Err(refused(
                "sandbox_registry_not_delegated",
                format!(
                    "{registry} needs credentials, and they are not delegated to the {} provider",
                    remote.provisioner.kind()
                ),
            ));
        }
        Ok(auth)
    }

    /// Run one command in an instance and collect its output.
    async fn exec_collect(
        &self,
        instance: &str,
        command: Vec<String>,
        env: Vec<String>,
        timeout: Duration,
    ) -> Result<ExecOutput, String> {
        tokio::time::timeout(timeout, async {
            let mut running = self
                .api
                .exec_runtime(RunnerExecSpec {
                    container_id: instance.to_string(),
                    command,
                    env,
                    working_dir: "/".to_string(),
                })
                .await?;
            drop(running.stdin);
            let mut output = ExecOutput {
                stdout: Vec::new(),
                stderr: Vec::new(),
                code: None,
            };
            while let Some(event) = running.events.recv().await {
                match event {
                    RunnerEvent::Stdout(bytes) => extend_capped(&mut output.stdout, &bytes),
                    RunnerEvent::Stderr(bytes) => extend_capped(&mut output.stderr, &bytes),
                    RunnerEvent::Exited { code } => {
                        output.code = code;
                        return Ok(output);
                    }
                }
            }
            Ok(output)
        })
        .await
        .map_err(|_| "the command timed out".to_string())?
    }

    pub(super) async fn prepare_remote(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
        // Held through preparation: the slot, the cancellation reservation.
        _leases: OperationLeases,
        gateway: Option<cognia_external_agent::spawn_authority::GatewayAuthority>,
        tool_hosts: Vec<crate::runtime::ToolHostService>,
        nonce: String,
    ) -> Result<String, SandboxSpawnError> {
        let remote = self.remote.as_ref().expect("a remote driver");
        self.ensure_remote_reaper();
        let id = config.id.clone();
        let placement = config
            .sandbox
            .as_ref()
            .expect("prepare_spawn checked the placement");
        let source = placement.workspace().cloned().ok_or_else(|| {
            refused(
                "sandbox_workspace_remote_required",
                "a remote sandbox clones its workspace and needs the repository's remote",
            )
        })?;
        validate_source(&source)?;

        let tiers = self.available_tiers().await?;
        let admitted = self.admission.admit(placement.spec(), &tiers)?;
        if !tiers.contains(&admitted.admission.actual_tier) {
            return Err(refused(
                "isolation_tier_unavailable",
                format!(
                    "the {} provider cannot attest {}",
                    remote.provisioner.kind(),
                    admitted.admission.actual_tier.as_str()
                ),
            ));
        }
        let egress_tier = admitted.spec.egress.tier;
        let egress_enforced = remote.provisioner.egress_enforced(egress_tier);
        if !egress_enforced && (placement.isolation_mandatory() || self.admission.multi_tenant()) {
            return Err(refused(
                "sandbox_egress_unenforceable",
                format!(
                    "the {} provider cannot enforce egress {:?}, and this run requires isolation",
                    remote.provisioner.kind(),
                    egress_tier
                ),
            ));
        }
        let image = admitted.spec.image.registry_image().ok_or_else(|| {
            refused(
                "sandbox_image_not_remote",
                "a locally built image exists only on one Host's daemon",
            )
        })?;
        let image = PinnedImage {
            registry: image.registry.clone(),
            repository: image.repository.clone(),
            digest: image.digest.clone(),
        };
        let registry_auth = self.delegated_auth(remote, &image.registry)?;
        let bundle_offer = admitted.admission.bundle.clone();
        let bundle = bundle_offer.image();
        let bundle_registry_auth = self.delegated_auth(remote, &bundle.registry)?;
        let (user, _) = target_user(&admitted.spec.user, admitted.admission.actual_tier);
        let persistent = admitted.spec.lifecycle == SandboxLifecycleKind::Persistent;
        let ephemeral_identity = format!("{id}:{}", uuid::Uuid::new_v4());
        let key = remote_runtime_key(
            &remote.provider_id,
            &admitted.spec,
            &source,
            (!persistent).then_some(ephemeral_identity.as_str()),
        );

        let mut boot = runtime_config(&admitted.spec, &config)?;
        // Task leases never reach the supervisor or the boot hooks.
        boot.spawn_env.clear();
        boot.lifecycle_phases
            .retain(|phase| *phase != LifecyclePhase::PostAttach);
        let mut supervisor = vec![
            format!("{INJECTION_ROOT}/bin/cognia-sandboxd"),
            "serve".to_string(),
            "--root".to_string(),
            "/".to_string(),
            "--bundle".to_string(),
            INJECTION_ROOT.to_string(),
            "--user".to_string(),
            user.to_string(),
            "--socket".to_string(),
            SOCKET.to_string(),
            "--runtime-key".to_string(),
            key.clone(),
            "--idle-timeout-secs".to_string(),
            remote
                .limits
                .idle_timeout
                .as_secs()
                .clamp(60, 86_400)
                .to_string(),
        ];
        for port in &admitted.spec.forward_ports {
            supervisor.extend(["--forward-port".to_string(), port.port.to_string()]);
        }
        let expires_at = unix_now() + remote.limits.max_lifetime.as_secs();
        let mut labels = ownership_labels(&key, &self.config.instance_id, &self.config.deployment_id);
        if persistent {
            labels.insert(PERSISTENT_RUNTIME_LABEL.into(), "1".into());
        }
        labels.insert(RUNTIME_KEY_LABEL.into(), key.clone());
        labels.insert(PROJECT_LABEL.into(), admitted.spec.project_id.clone());
        labels.insert("cognia.spec-digest".into(), admitted.spec.spec_digest.clone());
        labels.insert(PROVIDER_LABEL.into(), remote.provider_id.clone());
        labels.insert(EXPIRES_AT_LABEL.into(), expires_at.to_string());
        let request = ProvisionRequest {
            name: instance_name(&self.config.deployment_id, &key),
            labels,
            image,
            registry_auth,
            bundle,
            bundle_registry_auth,
            bundle_release_tag: bundle_offer.release_tag.clone(),
            tier: admitted.admission.actual_tier,
            size: admitted.admission.size_class.clone(),
            egress: EgressPlan {
                tier: egress_tier,
                domains: match egress_tier {
                    EgressTier::Allowlist => self.admission.egress_allowlist(&admitted.spec),
                    EgressTier::Off | EgressTier::On => Vec::new(),
                },
            },
            lifetime: remote.limits.max_lifetime,
            supervisor,
            supervisor_env: encode_runtime_config_env(&boot)
                .map_err(|error| refused("sandbox_runtime_config_invalid", error.to_string()))?,
        };

        let lock = self.stage_lock(&format!("remote:{key}"));
        let _guard = lock.lock().await;
        let (instance, fresh) = match persistent {
            true => match self.retained_remote_instance(&key).await? {
                Some(instance) => (instance, false),
                None => (self.provision_instance(&request, persistent).await?, true),
            },
            false => (self.provision_instance(&request, persistent).await?, true),
        };
        // Until the session owns it, a failure destroys what was created.
        let mut teardown = InstanceTeardown {
            backend: self.own.clone(),
            instance: instance.clone(),
            armed: fresh,
        };

        let report = self.probe_remote(&admitted, &instance, &user).await?;
        let libc = report.libc.expect("a report without a libc is refused");
        let invocation = bundled_invocation(&config.command, &config.args, &report.commands)
            .ok_or_else(|| {
                refused(
                    "sandbox_command_unavailable",
                    format!(
                        "the agent bundle has no {} for {}",
                        config.command,
                        libc.as_str()
                    ),
                )
            })?;

        if fresh {
            self.clone_workspace(&instance, &source, &user).await?;
            remote
                .provisioner
                .release_supervisor(&instance, &request)
                .await?;
        } else {
            self.ensure_workspace_link(&instance, &source, &user, None)
                .await?;
        }
        self.await_supervisor(&instance, &key, boot.lifecycle_timeout_ms)
            .await?;
        if persistent {
            self.remember_retained_task(&config, &instance, &admitted.spec)?;
        }

        let session = sha256_hex(format!("{}:{}", config.id, default_instance_id()).as_bytes());
        let mut connect = exec_spec(
            &instance,
            &[
                "connect-agent",
                "--socket",
                SOCKET,
                "--session",
                &session,
                "--lease-seconds",
                "60",
                "--",
            ],
        );
        connect.command.push(format!(
            "{INJECTION_ROOT}/{}/bin/{}",
            libc.as_str(),
            invocation.name
        ));
        connect.command.extend(invocation.args.iter().cloned());
        let mut runtime = runtime_config(&admitted.spec, &config)?;
        runtime.lifecycle_phases = vec![LifecyclePhase::PostAttach];
        connect.env = encode_runtime_config_env(&runtime)
            .map_err(|error| refused("sandbox_runtime_config_invalid", error.to_string()))?;

        let cleanup = Arc::new(RemoteSession {
            session: SessionApi::new(self.api.clone(), instance.clone(), session),
            backend: self.own.clone(),
            instance: instance.clone(),
            agent_id: id.clone(),
            sink: Arc::clone(&sink),
            finished: AtomicBool::new(false),
        });
        let running = match self.api.exec_runtime(connect).await {
            Ok(running) => running,
            Err(error) => {
                // A failed start may still have reached the supervisor.
                let _ = cleanup.session.kill(&instance).await;
                return Err(fault("sandbox_persistent_runtime_failed", error));
            }
        };
        if let Some(entry) = remote.instances.lock().get_mut(&instance) {
            entry.sessions.insert(id.clone());
            entry.idle_since = None;
        }
        teardown.armed = false;

        let placement = remote_placement(
            &admitted,
            &report,
            libc,
            &invocation,
            &config,
            remote,
            egress_enforced,
            &source,
        );
        sink.sandbox_placement(&id, &placement);
        let cleanup: Arc<dyn ContainerApi> = cleanup;
        let id = self
            .runners
            .adopt_scoped(config, running, Some(placement), sink, cleanup);
        self.finish_gateway_spawn(id, gateway, tool_hosts, nonce)
            .await
    }

    /// A retained persistent instance for `key`, running again if the
    /// provider can restart it. One that cannot be restarted is destroyed so
    /// a fresh one takes its place.
    async fn retained_remote_instance(&self, key: &str) -> Result<Option<String>, SandboxSpawnError> {
        let remote = self.remote.as_ref().expect("a remote driver");
        let owned = self
            .api
            .list_owned()
            .await
            .map_err(|error| fault("sandbox_provider_unreachable", error))?;
        let matching: Vec<_> = owned
            .into_iter()
            .filter(|item| {
                item.deployment() == Some(self.config.deployment_id.as_str())
                    && item.labels.get(RUNTIME_KEY_LABEL).map(String::as_str) == Some(key)
                    && item.labels.get(PERSISTENT_RUNTIME_LABEL).map(String::as_str) == Some("1")
            })
            .collect();
        if matching.len() > 1 {
            return Err(fault(
                "sandbox_persistent_runtime_failed",
                "multiple persistent instances claim the same workspace",
            ));
        }
        let Some(existing) = matching.into_iter().next() else {
            return Ok(None);
        };
        let state = self
            .api
            .inspect_runtime(&existing.id)
            .await
            .map_err(|error| fault("sandbox_provider_unreachable", error))?;
        let Some(state) = state else {
            return Ok(None);
        };
        if !state.running {
            if let Err(error) = self.api.start_runtime(&existing.id).await {
                log::info!(
                    "persistent {} instance {} cannot restart ({error}); replacing it",
                    remote.provisioner.kind(),
                    existing.id
                );
                self.destroy_instance(&existing.id).await;
                return Ok(None);
            }
        }
        if !remote.instances.lock().contains_key(&existing.id) {
            let slot = self.remote_slot().await?;
            let deadline = deadline_from_labels(&existing.labels, remote.limits.max_lifetime);
            remote.instances.lock().insert(
                existing.id.clone(),
                Instance::new(slot, true, deadline, None),
            );
        }
        Ok(Some(existing.id))
    }

    async fn remote_slot(&self) -> Result<tokio::sync::OwnedSemaphorePermit, SandboxSpawnError> {
        let remote = self.remote.as_ref().expect("a remote driver");
        tokio::time::timeout(CAPACITY_WAIT, remote.slots.clone().acquire_owned())
            .await
            .map_err(|_| {
                fault(
                    "sandbox_provider_capacity",
                    format!(
                        "the {} provider is at its limit of {} instances",
                        remote.provider_id, remote.limits.max_concurrent
                    ),
                )
            })?
            .map_err(|_| fault("sandbox_provider_capacity", "the provider is shutting down"))
    }

    async fn provision_instance(
        &self,
        request: &ProvisionRequest,
        persistent: bool,
    ) -> Result<String, SandboxSpawnError> {
        let remote = self.remote.as_ref().expect("a remote driver");
        let slot = self.remote_slot().await?;
        let instance = remote.provisioner.provision(request).await?;
        remote.instances.lock().insert(
            instance.clone(),
            Instance::new(
                slot,
                persistent,
                tokio::time::Instant::now() + request.lifetime,
                None,
            ),
        );
        Ok(instance)
    }

    /// Destroy an instance and forget it, releasing its slot, proxy and
    /// bridge. Idempotent.
    async fn destroy_instance(&self, instance: &str) {
        if let Err(error) = remove_owned(&self.container, instance).await {
            log::warn!("remote instance {instance} could not be destroyed: {error}");
        }
        if let Some(remote) = self.remote.as_ref() {
            remote.instances.lock().remove(instance);
        }
    }

    async fn probe_remote(
        &self,
        admitted: &AdmittedSandbox,
        instance: &str,
        user: &UserSpec,
    ) -> Result<ProbeReport, SandboxSpawnError> {
        let image_digest = admitted
            .spec
            .image
            .registry_image()
            .map(|image| image.digest)
            .expect("a remote spawn runs a registry image");
        let bundle = admitted.admission.bundle.image();
        if let Some(entry) = self.admission.cached_probe(&image_digest, &bundle.digest) {
            if let Some(report) = cached_report(&entry, user, false, None) {
                return refuse_probe(&report).map_or(Ok(report), Err);
            }
        }
        let command = vec![
            format!("{INJECTION_ROOT}/bin/cognia-sandboxd"),
            "probe".to_string(),
            "--root".to_string(),
            "/".to_string(),
            "--bundle".to_string(),
            INJECTION_ROOT.to_string(),
            "--workspace".to_string(),
            WORKSPACE_TARGET.to_string(),
            "--out".to_string(),
            "-".to_string(),
            "--user".to_string(),
            user.to_string(),
        ];
        let output = self
            .exec_collect(instance, command, Vec::new(), PROBE_TIMEOUT)
            .await
            .map_err(|error| fault("sandbox_container_start_failed", error))?;
        let label = admitted.spec.image.identity();
        let report = interpret_probe(
            &Completed {
                stdout: output.stdout,
                stderr: output.stderr,
                code: output.code,
            },
            &label,
        )?;
        if !report
            .problems
            .iter()
            .any(|problem| problem.code == ProbeCode::WorkspaceNotWritable)
        {
            self.admission.record_probe(
                &image_digest,
                &bundle.digest,
                &cache_entry(user, false, None, &report),
            );
        }
        refuse_probe(&report).map_or(Ok(report), Err)
    }

    /// Start the git proxy and its bridge for an instance, unless a live one
    /// is already there. Returns the link.
    async fn ensure_workspace_link(
        &self,
        instance: &str,
        source: &RemoteWorkspaceSource,
        user: &UserSpec,
        base_commit: Option<String>,
    ) -> Result<Arc<WorkspaceLink>, SandboxSpawnError> {
        let remote = self.remote.as_ref().expect("a remote driver");
        if let Some(link) = remote.workspace(instance) {
            if link.alive() && link.source == *source {
                return Ok(link);
            }
        }
        let upstream = url::Url::parse(&source.remote_url)
            .map_err(|_| refused("sandbox_workspace_remote_invalid", "the workspace remote is not a URL"))?;
        // The brain's token when it sent one, else the Host's own helpers.
        let credential = match source.credential.clone() {
            Some(credential) => Some(credential),
            None => crate::git_proxy::host_credential(&upstream).await,
        };
        let proxy = GitProxy::start(GitProxyConfig {
            upstream,
            credential,
            branch: source.branch.clone(),
        })
        .await
        .map_err(|error| refused("sandbox_workspace_remote_invalid", error))?;
        let permit = self
            .port_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| fault("sandbox_service_unavailable", "Sandbox bridge limit reached"))?;
        let running = tokio::time::timeout(
            Duration::from_secs(10),
            self.api.exec_runtime(RunnerExecSpec {
                container_id: instance.to_string(),
                command: vec![
                    format!("{INJECTION_ROOT}/bin/cognia-sandboxd"),
                    "bridge-service".into(),
                    "--listen-port".into(),
                    GIT_PROXY_SANDBOX_PORT.to_string(),
                ],
                env: Vec::new(),
                working_dir: "/".into(),
            }),
        )
        .await
        .map_err(|_| fault("sandbox_service_unavailable", "the workspace bridge did not start"))?
        .map_err(|error| fault("sandbox_service_unavailable", error))?;
        // Claim the generation before the pump can tick, so the guard of
        // this bridge is current from its first check and every older one
        // is not.
        let generation = {
            let mut instances = remote.instances.lock();
            let Some(entry) = instances.get_mut(instance) else {
                return Err(fault(
                    "sandbox_persistent_runtime_failed",
                    "the instance was released while its workspace was being linked",
                ));
            };
            entry.link_generation += 1;
            entry.workspace = None;
            entry.link_generation
        };
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let guard: Arc<dyn BridgeGuard> = Arc::new(InstanceBridgeGuard {
            backend: self.own.clone(),
            instance: instance.to_string(),
            generation,
        });
        let bridge = tokio::spawn(pump_bridge(
            running,
            BridgeTarget {
                port: proxy.port(),
                listen_port: Some(GIT_PROXY_SANDBOX_PORT),
            },
            stopped,
            ready_tx,
            guard,
            permit,
        ));
        let link = Arc::new(WorkspaceLink {
            source: source.clone(),
            user: user.clone(),
            base_commit: Mutex::new(base_commit),
            _proxy: proxy,
            stop,
            bridge,
        });
        if let Some(entry) = remote.instances.lock().get_mut(instance) {
            if entry.link_generation == generation {
                entry.workspace = Some(Arc::clone(&link));
            }
        }
        match tokio::time::timeout(Duration::from_secs(8), ready_rx).await {
            Ok(Ok(_)) => Ok(link),
            _ => {
                if let Some(entry) = remote.instances.lock().get_mut(instance) {
                    if entry.link_generation == generation {
                        entry.workspace = None;
                    }
                }
                Err(fault(
                    "sandbox_service_unavailable",
                    "the workspace bridge did not become ready",
                ))
            }
        }
    }

    /// Clone the workspace into `/workspace` as the agent's user and put it on
    /// the task's branch.
    async fn clone_workspace(
        &self,
        instance: &str,
        source: &RemoteWorkspaceSource,
        user: &UserSpec,
    ) -> Result<(), SandboxSpawnError> {
        let link = self
            .ensure_workspace_link(instance, source, user, None)
            .await?;
        let env = git_runtime_env()?;
        let clone = self
            .exec_collect(
                instance,
                git_invocation(
                    user,
                    &[
                        "clone",
                        "--filter=blob:none",
                        "--origin",
                        "origin",
                        "--branch",
                        &source.base_ref,
                        &proxy_url(),
                        WORKSPACE_TARGET,
                    ],
                ),
                env.clone(),
                CLONE_TIMEOUT,
            )
            .await
            .map_err(|error| fault("sandbox_workspace_clone_failed", error))?;
        if !clone.succeeded() {
            return Err(refused(
                "sandbox_workspace_clone_failed",
                format!("cloning {} failed: {}", source.remote_url, clone.tail()),
            ));
        }
        let checkout = self
            .exec_collect(
                instance,
                git_invocation(
                    user,
                    &["-C", WORKSPACE_TARGET, "checkout", "-B", &source.branch],
                ),
                env.clone(),
                GIT_TIMEOUT,
            )
            .await
            .map_err(|error| fault("sandbox_workspace_clone_failed", error))?;
        if !checkout.succeeded() {
            return Err(refused(
                "sandbox_workspace_clone_failed",
                format!("creating branch {} failed: {}", source.branch, checkout.tail()),
            ));
        }
        let head = self
            .exec_collect(
                instance,
                git_invocation(user, &["-C", WORKSPACE_TARGET, "rev-parse", "HEAD"]),
                env,
                GIT_TIMEOUT,
            )
            .await
            .map_err(|error| fault("sandbox_workspace_clone_failed", error))?;
        let base = String::from_utf8_lossy(&head.stdout).trim().to_string();
        if !head.succeeded() || base.is_empty() {
            return Err(refused(
                "sandbox_workspace_clone_failed",
                format!("reading the cloned commit failed: {}", head.tail()),
            ));
        }
        *link.base_commit.lock() = Some(base);
        Ok(())
    }

    /// Wait until the instance's supervisor has run its lifecycle hooks.
    async fn await_supervisor(
        &self,
        instance: &str,
        key: &str,
        lifecycle_timeout_ms: u64,
    ) -> Result<(), SandboxSpawnError> {
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(lifecycle_timeout_ms.saturating_mul(4) + 30_000);
        loop {
            if let Ok(body) = super::persistent::control(
                &self.api,
                exec_spec(instance, &["health", "--socket", SOCKET]),
            )
            .await
            {
                if serde_json::from_slice::<Value>(&body)
                    .ok()
                    .is_some_and(|state| runtime_ready(&state, key))
                {
                    return Ok(());
                }
            }
            match self.api.inspect_runtime(instance).await {
                Ok(Some(state)) if state.running => {}
                Ok(_) => {
                    return Err(fault(
                        "sandbox_persistent_runtime_failed",
                        "the remote instance stopped before its lifecycle preparation completed",
                    ))
                }
                Err(error) => return Err(fault("sandbox_provider_unreachable", error)),
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(fault(
                    "sandbox_persistent_runtime_failed",
                    "the remote instance's supervisor did not become ready",
                ));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Commit and push the workspace to the task's branch through the proxy.
    async fn publish_workspace(&self, instance: &str) -> Value {
        let Some(remote) = self.remote.as_ref() else {
            return json!({ "pushed": false, "code": "sandbox_workspace_unavailable" });
        };
        let Some(link) = remote.workspace(instance) else {
            return json!({ "pushed": false, "code": "sandbox_workspace_unavailable" });
        };
        let branch = link.source.branch.clone();
        let link = if link.alive() {
            link
        } else {
            let base = link.base_commit.lock().clone();
            match self
                .ensure_workspace_link(instance, &link.source.clone(), &link.user.clone(), base)
                .await
            {
                Ok(link) => link,
                Err(error) => {
                    return json!({ "branch": branch, "pushed": false, "code": error.code, "message": error.message })
                }
            }
        };
        let env = match git_runtime_env() {
            Ok(env) => env,
            Err(error) => {
                return json!({ "branch": branch, "pushed": false, "code": error.code, "message": error.message })
            }
        };
        let git = |args: Vec<String>| {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            git_invocation(&link.user, &args)
        };
        let run = |command: Vec<String>| self.exec_collect(instance, command, env.clone(), GIT_TIMEOUT);
        let failed = |code: &str, detail: String| {
            json!({ "branch": branch, "pushed": false, "code": code, "message": detail })
        };

        let status = match run(git(vec![
            "-C".into(),
            WORKSPACE_TARGET.into(),
            "status".into(),
            "--porcelain".into(),
        ]))
        .await
        {
            Ok(output) if output.succeeded() => output,
            Ok(output) => return failed("sandbox_workspace_publish_failed", output.tail()),
            Err(error) => return failed("sandbox_workspace_publish_failed", error),
        };
        if !status.stdout.iter().all(u8::is_ascii_whitespace) {
            for args in [
                vec!["-C".to_string(), WORKSPACE_TARGET.into(), "add".into(), "-A".into()],
                vec![
                    "-C".to_string(),
                    WORKSPACE_TARGET.into(),
                    "-c".into(),
                    "user.name=Cognia Agent".into(),
                    "-c".into(),
                    "user.email=agent@cognia.invalid".into(),
                    "commit".into(),
                    "--no-verify".into(),
                    "-m".into(),
                    "Cognia agent changes".into(),
                ],
            ] {
                match run(git(args)).await {
                    Ok(output) if output.succeeded() => {}
                    Ok(output) => return failed("sandbox_workspace_publish_failed", output.tail()),
                    Err(error) => return failed("sandbox_workspace_publish_failed", error),
                }
            }
        }
        let head = match run(git(vec![
            "-C".into(),
            WORKSPACE_TARGET.into(),
            "rev-parse".into(),
            "HEAD".into(),
        ]))
        .await
        {
            Ok(output) if output.succeeded() => String::from_utf8_lossy(&output.stdout).trim().to_string(),
            Ok(output) => return failed("sandbox_workspace_publish_failed", output.tail()),
            Err(error) => return failed("sandbox_workspace_publish_failed", error),
        };
        if link.base_commit.lock().as_deref() == Some(head.as_str()) {
            return json!({ "branch": branch, "pushed": false, "code": "nothing_to_publish", "commit": head });
        }
        let refspec = format!("HEAD:refs/heads/{branch}");
        match run(git(vec![
            "-C".into(),
            WORKSPACE_TARGET.into(),
            "push".into(),
            "--no-verify".into(),
            proxy_url(),
            refspec,
        ]))
        .await
        {
            Ok(output) if output.succeeded() => {
                json!({ "branch": branch, "pushed": true, "commit": head })
            }
            Ok(output) => {
                json!({ "branch": branch, "pushed": false, "commit": head, "code": "sandbox_workspace_push_refused", "message": output.tail() })
            }
            Err(error) => failed("sandbox_workspace_publish_failed", error),
        }
    }

    /// A session ended: publish, then destroy an ephemeral instance or mark a
    /// persistent one idle.
    async fn finish_remote_session(
        &self,
        instance: &str,
        agent_id: &str,
        sink: &Arc<dyn ExternalAgentEventSink>,
    ) {
        let Some(remote) = self.remote.as_ref() else {
            return;
        };
        let tracked = remote.instances.lock().contains_key(instance);
        if tracked {
            let publish = self.publish_workspace(instance).await;
            sink.workspace_published(agent_id, &publish);
        }
        let destroy = {
            let mut instances = remote.instances.lock();
            match instances.get_mut(instance) {
                Some(entry) => {
                    entry.sessions.remove(agent_id);
                    if entry.sessions.is_empty() {
                        entry.idle_since = Some(tokio::time::Instant::now());
                    }
                    !entry.persistent
                }
                None => false,
            }
        };
        if destroy {
            self.destroy_instance(instance).await;
        }
    }

    /// Destroy instances past their deadline and persistent ones idle too long.
    pub(super) async fn sweep_remote_instances(&self) {
        let Some(remote) = self.remote.as_ref() else {
            return;
        };
        let now = tokio::time::Instant::now();
        let mut stop_sessions = Vec::new();
        let mut destroy = Vec::new();
        {
            let mut instances = remote.instances.lock();
            for (id, entry) in instances.iter_mut() {
                if now >= entry.deadline {
                    match entry.stopping_since {
                        None if !entry.sessions.is_empty() => {
                            entry.stopping_since = Some(now);
                            stop_sessions.extend(entry.sessions.iter().cloned());
                        }
                        Some(since) if now < since + DEADLINE_GRACE => {}
                        _ => destroy.push(id.clone()),
                    }
                } else if entry.persistent
                    && entry.sessions.is_empty()
                    && entry
                        .idle_since
                        .is_some_and(|since| now >= since + remote.limits.idle_timeout)
                {
                    destroy.push(id.clone());
                }
            }
        }
        for agent in stop_sessions {
            if let Err(error) = self.runners.kill(&agent).await {
                log::warn!("stopping agent {agent} at its sandbox deadline failed: {error}");
            }
        }
        for instance in destroy {
            log::info!(
                "destroying {} instance {instance} (deadline or idle limit)",
                remote.provisioner.kind()
            );
            self.destroy_instance(&instance).await;
        }
    }

    /// After a restart: track this deployment's persistent instances so their
    /// deadline and idle limits apply, destroying any the limits no longer
    /// leave room for.
    pub(super) async fn adopt_remote_instances(&self) -> Vec<String> {
        let Some(remote) = self.remote.as_ref() else {
            return Vec::new();
        };
        self.ensure_remote_reaper();
        let owned = match self.api.list_owned().await {
            Ok(owned) => owned,
            Err(error) => {
                log::warn!("listing {} instances failed: {error}", remote.provisioner.kind());
                return Vec::new();
            }
        };
        let mut destroyed = Vec::new();
        for item in owned {
            if item.deployment() != Some(self.config.deployment_id.as_str())
                || item.labels.get(PERSISTENT_RUNTIME_LABEL).map(String::as_str) != Some("1")
                || item.labels.get(PROVIDER_LABEL) != Some(&remote.provider_id)
                || remote.instances.lock().contains_key(&item.id)
            {
                continue;
            }
            match remote.slots.clone().try_acquire_owned() {
                Ok(slot) => {
                    remote.instances.lock().insert(
                        item.id.clone(),
                        Instance::new(
                            slot,
                            true,
                            deadline_from_labels(&item.labels, remote.limits.max_lifetime),
                            Some(tokio::time::Instant::now()),
                        ),
                    );
                }
                Err(_) => {
                    if remove_owned(&self.container, &item.id).await.is_ok() {
                        destroyed.push(item.id);
                    }
                }
            }
        }
        destroyed
    }
}

/// The deadline an adopted instance carries in its labels, capped at the
/// configured lifetime from now.
fn deadline_from_labels(labels: &BTreeMap<String, String>, max: Duration) -> tokio::time::Instant {
    let now = tokio::time::Instant::now();
    let remaining = labels
        .get(EXPIRES_AT_LABEL)
        .and_then(|value| value.parse::<u64>().ok())
        .map(|expires| Duration::from_secs(expires.saturating_sub(unix_now())))
        .unwrap_or(max);
    now + remaining.min(max)
}

/// Destroys a freshly provisioned instance if preparation fails before the
/// session owns it.
struct InstanceTeardown {
    backend: Weak<DockerSandboxBackend>,
    instance: String,
    armed: bool,
}

impl Drop for InstanceTeardown {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let backend = self.backend.clone();
        let instance = std::mem::take(&mut self.instance);
        // Dropped outside a runtime (a process shutting down) there is no
        // way to call the provider; the instance's own TTL and the next
        // boot's reap destroy it.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            log::warn!(
                "remote instance {instance} dropped outside a runtime; left to its TTL and the next reap"
            );
            return;
        };
        runtime.spawn(async move {
            if let Some(backend) = backend.upgrade() {
                backend.destroy_instance(&instance).await;
            }
        });
    }
}

/// The registry's cleanup capability for one remote session: it signals the
/// session like a local persistent one, and on removal publishes the
/// workspace and releases the instance.
struct RemoteSession {
    session: SessionApi,
    backend: Weak<DockerSandboxBackend>,
    instance: String,
    agent_id: String,
    sink: Arc<dyn ExternalAgentEventSink>,
    finished: AtomicBool,
}

#[async_trait]
impl ContainerApi for RemoteSession {
    async fn run(&self, _: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
        Err(RunnerRunError::Other(
            "session handle cannot create containers".into(),
        ))
    }
    async fn pull_image(&self, _: &str) -> Result<(), String> {
        Err("session handle cannot pull images".into())
    }
    async fn kill(&self, id: &str) -> Result<(), String> {
        self.session.kill(id).await
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        if id != self.instance {
            return Err("session instance mismatch".into());
        }
        // The supervisor may already be gone with its instance (a deadline);
        // that must not keep the session from being finished.
        if let Err(error) = self.session.kill(id).await {
            log::debug!("remote session signal on removal: {error}");
        }
        if !self.finished.swap(true, Ordering::AcqRel) {
            if let Some(backend) = self.backend.upgrade() {
                backend
                    .finish_remote_session(&self.instance, &self.agent_id, &self.sink)
                    .await;
            }
        }
        Ok(())
    }
    async fn labels(&self, id: &str) -> Result<Option<BTreeMap<String, String>>, String> {
        self.session.labels(id).await
    }
    async fn list_owned(&self) -> Result<Vec<cognia_external_agent::container_backend::OwnedContainer>, String> {
        Ok(Vec::new())
    }
}

/// What the UI shows for an agent in a remote sandbox.
#[allow(clippy::too_many_arguments)]
fn remote_placement(
    admitted: &AdmittedSandbox,
    report: &ProbeReport,
    libc: Libc,
    invocation: &BundledInvocation,
    config: &ExternalAgentSpawnConfig,
    remote: &RemoteParts,
    egress_enforced: bool,
    source: &RemoteWorkspaceSource,
) -> Value {
    let mut placement = sandbox_placement(
        admitted,
        report,
        libc,
        invocation,
        config,
        remote.provisioner.kind(),
        egress_enforced,
    );
    placement["provider"] = json!(remote.provider_id);
    placement["workspace"] = json!({
        "remoteUrl": source.remote_url,
        "baseRef": source.base_ref,
        "branch": source.branch,
    });
    placement
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::tests::{admitted, command, config as driver_config, report, spawn_config, spec, FakeAdmission};
    use crate::remote::fake::{FakeRemote, GitAnswer};
    use cognia_external_agent::exec_backend::test_support::RecordingAgentEmitter;
    use cognia_external_agent::exec_backend::{
        EmitterEventSink, PLACEMENT_CHANNEL, WORKSPACE_PUBLISH_CHANNEL,
    };
    use cognia_external_agent::sandbox_routing_backend::SandboxErrorKind;

    const TOKEN: &str = "ghs_never_in_the_sandbox";

    fn limits(max_concurrent: u32) -> RemoteLimits {
        RemoteLimits {
            max_concurrent,
            max_lifetime: Duration::from_secs(3600),
            idle_timeout: Duration::from_secs(600),
        }
    }

    fn source() -> RemoteWorkspaceSource {
        RemoteWorkspaceSource {
            remote_url: "https://github.com/acme/app.git".into(),
            base_ref: "main".into(),
            branch: "cognia/task-1".into(),
            credential: Some(TOKEN.into()),
        }
    }

    struct Remote {
        fake: Arc<FakeRemote>,
        admission: Arc<FakeAdmission>,
        backend: Arc<DockerSandboxBackend>,
        emitter: Arc<RecordingAgentEmitter>,
    }

    impl Remote {
        fn new(fake: Arc<FakeRemote>, environment: EnvironmentSpec, max_concurrent: u32) -> Self {
            // The workspace's git proxy builds its upstream client under the
            // Host's network policy, as a running Host has it.
            cognia_net::proxy_config::apply_current(
                cognia_net::proxy_config::ProxyConfig::default(),
            )
            .expect("the default policy is valid");
            *fake.probe.lock() = (
                serde_json::to_vec(&report(vec![command("codex-acp", None)], Vec::new())).unwrap(),
                0,
            );
            let admission = FakeAdmission::admitting(admitted(environment, IsolationTier::Vm));
            let backend = DockerSandboxBackend::new_remote(
                "cloud".into(),
                fake.clone(),
                limits(max_concurrent),
                admission.clone(),
                driver_config(),
            );
            Self {
                fake,
                admission,
                backend,
                emitter: RecordingAgentEmitter::new(),
            }
        }

        async fn spawn(&self, config: ExternalAgentSpawnConfig) -> Result<String, SandboxSpawnError> {
            self.backend
                .spawn_sandboxed(config, EmitterEventSink::new(self.emitter.clone()))
                .await
        }

        fn events(&self, channel: &str) -> Vec<Value> {
            self.emitter
                .events()
                .into_iter()
                .filter(|(name, _)| name == channel)
                .map(|(_, payload)| payload)
                .collect()
        }

        /// Make the agent's session exit, as the agent process would.
        fn exit_session(&self) {
            let sessions = self.fake.sessions.lock();
            for session in sessions.values() {
                let _ = session.events.send(RunnerEvent::Exited { code: Some(0) });
            }
        }

        async fn until(&self, what: &str, condition: impl Fn(&Self) -> bool) {
            for _ in 0..400 {
                if condition(self) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("timed out waiting for {what}");
        }
    }

    fn remote_config(id: &str, environment: &EnvironmentSpec) -> ExternalAgentSpawnConfig {
        let mut config = spawn_config(id, "codex-acp", &[], environment);
        if let Some(SandboxPlacement::Container {
            provider,
            workspace,
            ..
        }) = config.sandbox.as_mut()
        {
            *provider = Some("cloud".into());
            *workspace = Some(source());
        }
        config
    }

    fn mandatory(mut config: ExternalAgentSpawnConfig) -> ExternalAgentSpawnConfig {
        if let Some(SandboxPlacement::Container {
            isolation_mandatory,
            ..
        }) = config.sandbox.as_mut()
        {
            *isolation_mandatory = true;
        }
        config
    }

    #[tokio::test]
    async fn a_cold_remote_spawn_provisions_probes_clones_releases_and_connects() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 2);
        let id = remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        assert_eq!(id, "agent-1");

        let provisions = remote.fake.provisions.lock().clone();
        assert_eq!(provisions.len(), 1);
        let request = &provisions[0];
        assert_eq!(request.image.digest, environment.image.registry_image().unwrap().digest);
        assert_eq!(request.bundle.repository, "cognia/agent-bundle");
        assert_eq!(request.tier, IsolationTier::Vm);
        assert_eq!(request.egress.tier, EgressTier::Off);
        assert!(request.egress.domains.is_empty());
        assert_eq!(request.lifetime, Duration::from_secs(3600));
        assert_eq!(request.supervisor[1], "serve");
        assert!(request.supervisor.windows(2).any(|pair| pair[0] == "--runtime-key"));
        assert_eq!(request.labels[PROVIDER_LABEL], "cloud");
        assert!(request.labels.contains_key(EXPIRES_AT_LABEL));
        assert!(!request.labels.contains_key(PERSISTENT_RUNTIME_LABEL));
        assert!(request.name.starts_with("cognia-dep1-"));
        // The boot environment carries no task credential.
        assert!(!request.supervisor_env.join("\n").contains("sk-test"));

        assert_eq!(
            remote.fake.actions(),
            vec!["probe", "bridge-service", "git", "git", "git", "health", "connect-agent"]
        );
        let git = remote.fake.git_calls();
        assert!(git[0].contains(&"clone".to_string()));
        assert!(git[0].contains(&format!("http://127.0.0.1:{GIT_PROXY_SANDBOX_PORT}/repo.git")));
        assert!(git[0].windows(2).any(|pair| pair == ["--branch", "main"]));
        assert!(git[1].windows(2).any(|pair| pair == ["-B", "cognia/task-1"]));
        assert_eq!(remote.fake.released.lock().clone(), vec!["instance-1".to_string()]);

        // Nothing the sandbox is handed carries the upstream credential.
        for exec in remote.fake.execs.lock().iter() {
            assert!(!exec.command.join(" ").contains(TOKEN));
            assert!(!exec.env.join(" ").contains(TOKEN));
        }

        let placement = &remote.events(PLACEMENT_CHANNEL)[0]["placement"];
        assert_eq!(placement["driver"], "fake");
        assert_eq!(placement["provider"], "cloud");
        assert_eq!(placement["isolationTier"], "vm");
        assert_eq!(placement["egress"]["enforced"], true);
        assert_eq!(placement["workspace"]["branch"], "cognia/task-1");
        assert!(!placement.to_string().contains(TOKEN));
        remote.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn an_ended_session_publishes_its_branch_and_releases_an_ephemeral_instance() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        remote.fake.answer_git(
            "rev-parse",
            vec![
                GitAnswer { stdout: format!("{}\n", "a".repeat(40)), code: 0 },
                GitAnswer { stdout: format!("{}\n", "b".repeat(40)), code: 0 },
            ],
        );
        remote.fake.answer_git(
            "status",
            vec![GitAnswer { stdout: " M src/main.rs\n".into(), code: 0 }],
        );
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the instance to be released", |remote| {
                remote.fake.removed.lock().contains(&"instance-1".to_string())
            })
            .await;

        let calls = remote.fake.git_calls();
        let subcommands: Vec<String> = calls
            .iter()
            .map(|call| {
                call.iter()
                    .skip(1)
                    .scan(false, |skip, arg| {
                        let current = *skip;
                        *skip = arg == "-c" || arg == "-C";
                        Some((current, arg.clone()))
                    })
                    .find(|(skipped, arg)| !skipped && arg != "-c" && arg != "-C")
                    .map(|(_, arg)| arg)
                    .unwrap_or_default()
            })
            .collect();
        assert_eq!(
            subcommands,
            vec!["clone", "checkout", "rev-parse", "status", "add", "commit", "rev-parse", "push"]
        );
        let push = calls.last().unwrap();
        assert!(push.contains(&"HEAD:refs/heads/cognia/task-1".to_string()));
        let publish = &remote.events(WORKSPACE_PUBLISH_CHANNEL)[0];
        assert_eq!(publish["agentId"], "agent-1");
        assert_eq!(publish["publish"]["pushed"], true);
        assert_eq!(publish["publish"]["commit"], "b".repeat(40));
        assert_eq!(publish["publish"]["branch"], "cognia/task-1");
        // The slot came back: a second spawn provisions without waiting.
        remote.spawn(remote_config("agent-2", &environment)).await.unwrap();
        assert_eq!(remote.fake.provisions.lock().len(), 2);
        remote.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn an_unchanged_workspace_is_not_pushed() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the publish report", |remote| {
                !remote.events(WORKSPACE_PUBLISH_CHANNEL).is_empty()
            })
            .await;
        let publish = &remote.events(WORKSPACE_PUBLISH_CHANNEL)[0]["publish"];
        assert_eq!(publish["pushed"], false);
        assert_eq!(publish["code"], "nothing_to_publish");
        assert!(!remote
            .fake
            .git_calls()
            .iter()
            .any(|call| call.contains(&"push".to_string())));
    }

    #[tokio::test(start_paused = true)]
    async fn a_persistent_instance_is_reused_then_released_when_idle() {
        let mut environment = spec(EgressTier::Off, None);
        environment.lifecycle = SandboxLifecycleKind::Persistent;
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 2);
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the first session to finish", |remote| {
                !remote.events(WORKSPACE_PUBLISH_CHANNEL).is_empty()
            })
            .await;
        assert!(remote.fake.removed.lock().is_empty(), "persistent instances outlive sessions");

        remote.spawn(remote_config("agent-2", &environment)).await.unwrap();
        assert_eq!(remote.fake.provisions.lock().len(), 1, "reused, not provisioned");
        assert_eq!(
            remote.fake.git_calls().iter().filter(|call| call.contains(&"clone".to_string())).count(),
            1,
            "the workspace is cloned once"
        );
        let provisioned = remote.fake.provisions.lock()[0].clone();
        assert_eq!(provisioned.labels[PERSISTENT_RUNTIME_LABEL], "1");

        remote.exit_session();
        remote
            .until("the second session to finish", |remote| {
                remote.events(WORKSPACE_PUBLISH_CHANNEL).len() == 2
            })
            .await;
        tokio::time::advance(Duration::from_secs(601)).await;
        remote.backend.sweep_remote_instances().await;
        assert_eq!(remote.fake.removed.lock().clone(), vec!["instance-1".to_string()]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_deadline_stops_sessions_and_destroys_the_instance() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        tokio::time::advance(Duration::from_secs(3601)).await;
        remote.backend.sweep_remote_instances().await;
        remote
            .until("the instance to be destroyed", |remote| {
                remote.fake.removed.lock().contains(&"instance-1".to_string())
            })
            .await;
        assert!(remote.backend.runners.list().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_provider_at_its_limit_is_a_capacity_fault() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        let error = remote
            .spawn(remote_config("agent-2", &environment))
            .await
            .unwrap_err();
        assert_eq!(error.kind, SandboxErrorKind::Fault);
        assert_eq!(error.code, "sandbox_provider_capacity");
        assert_eq!(remote.fake.provisions.lock().len(), 1);
        remote.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn requests_a_remote_provider_cannot_honour_are_refused() {
        let environment = spec(EgressTier::Off, None);

        // No workspace source.
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        let mut config = remote_config("a", &environment);
        if let Some(SandboxPlacement::Container { workspace, .. }) = config.sandbox.as_mut() {
            *workspace = None;
        }
        let error = remote.spawn(config).await.unwrap_err();
        assert_eq!(error.code, "sandbox_workspace_remote_required");

        // A plain-http remote, or one carrying credentials.
        for url in ["http://github.com/acme/app.git", "https://user:pw@github.com/acme/app.git"] {
            let mut config = remote_config("b", &environment);
            if let Some(SandboxPlacement::Container { workspace: Some(workspace), .. }) =
                config.sandbox.as_mut()
            {
                workspace.remote_url = url.into();
            }
            let error = remote.spawn(config).await.unwrap_err();
            assert_eq!(error.code, "sandbox_workspace_remote_invalid", "{url}");
        }

        // An allowlist the provider cannot enforce, when isolation is mandatory.
        let allowlisted = spec(EgressTier::Allowlist, None);
        let unenforcing = Remote::new(
            FakeRemote::with("fake", |fake| fake.enforces_allowlist = false),
            allowlisted.clone(),
            1,
        );
        let error = unenforcing
            .spawn(mandatory(remote_config("c", &allowlisted)))
            .await
            .unwrap_err();
        assert_eq!(error.code, "sandbox_egress_unenforceable");
        assert!(unenforcing.fake.provisions.lock().is_empty());

        // Credentials for a registry the provider was not trusted with.
        let private = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        *private.admission.auth.lock() = Some(RegistryAuth {
            server_address: "ghcr.io".into(),
            username: Some("bot".into()),
            password: Some("pw".into()),
            ..RegistryAuth::default()
        });
        let error = private.spawn(remote_config("d", &environment)).await.unwrap_err();
        assert_eq!(error.code, "sandbox_registry_not_delegated");
        assert!(private.fake.provisions.lock().is_empty());
    }

    #[tokio::test]
    async fn an_unenforced_allowlist_runs_labelled_when_isolation_is_optional() {
        let mut allowlisted = spec(EgressTier::Allowlist, None);
        allowlisted.egress.approved_domains = vec!["registry.npmjs.org".into()];
        let remote = Remote::new(
            FakeRemote::with("fake", |fake| fake.enforces_allowlist = false),
            allowlisted.clone(),
            1,
        );
        remote.spawn(remote_config("a", &allowlisted)).await.unwrap();
        let request = remote.fake.provisions.lock()[0].clone();
        assert_eq!(request.egress.domains, vec!["registry.npmjs.org".to_string()]);
        let placement = &remote.events(PLACEMENT_CHANNEL)[0]["placement"];
        assert_eq!(placement["egress"]["enforced"], false);
        remote.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn a_failed_preparation_destroys_the_fresh_instance() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        remote
            .fake
            .answer_git("clone", vec![GitAnswer { stdout: "fatal: repository not found".into(), code: 128 }]);
        let error = remote.spawn(remote_config("a", &environment)).await.unwrap_err();
        assert_eq!(error.code, "sandbox_workspace_clone_failed");
        remote
            .until("the instance to be destroyed", |remote| {
                remote.fake.removed.lock().contains(&"instance-1".to_string())
            })
            .await;
        assert!(remote.fake.released.lock().is_empty(), "never released a broken workspace");
        // The slot is free again.
        remote.fake.answer_git("clone", vec![GitAnswer { stdout: String::new(), code: 0 }]);
        remote.spawn(remote_config("b", &environment)).await.unwrap();
        remote.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn a_provision_failure_keeps_its_kind_and_frees_the_slot() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        *remote.fake.provision_error.lock() = Some(SandboxSpawnError::fault(
            "sandbox_provider_unreachable",
            "the provider did not answer",
        ));
        let error = remote.spawn(remote_config("a", &environment)).await.unwrap_err();
        assert_eq!(error.kind, SandboxErrorKind::Fault);
        assert_eq!(error.code, "sandbox_provider_unreachable");
        *remote.fake.provision_error.lock() = None;
        remote.spawn(remote_config("b", &environment)).await.unwrap();
        remote.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn a_persistent_instance_that_cannot_restart_is_replaced() {
        let mut environment = spec(EgressTier::Off, None);
        environment.lifecycle = SandboxLifecycleKind::Persistent;
        let remote = Remote::new(
            FakeRemote::with("fake", |fake| fake.restartable = false),
            environment.clone(),
            2,
        );
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the first session to finish", |remote| {
                !remote.events(WORKSPACE_PUBLISH_CHANNEL).is_empty()
            })
            .await;
        // The instance stops (a pod that completed); it cannot be restarted.
        remote.fake.stop_runtime("instance-1").await.unwrap();
        remote.spawn(remote_config("agent-2", &environment)).await.unwrap();
        assert_eq!(remote.fake.provisions.lock().len(), 2);
        assert!(remote.fake.removed.lock().contains(&"instance-1".to_string()));
        remote.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn an_adopted_persistent_instance_is_tracked_for_its_limits() {
        let environment = spec(EgressTier::Off, None);
        let fake = FakeRemote::new("fake");
        let labels = BTreeMap::from([
            (cognia_external_agent::container_backend::OWNER_LABEL.to_string(),
             cognia_external_agent::container_backend::OWNER_VALUE.to_string()),
            (cognia_external_agent::container_backend::DEPLOYMENT_LABEL.to_string(), "dep1".to_string()),
            (cognia_external_agent::container_backend::INSTANCE_LABEL.to_string(), "an-earlier-process".to_string()),
            (PERSISTENT_RUNTIME_LABEL.to_string(), "1".to_string()),
            (PROVIDER_LABEL.to_string(), "cloud".to_string()),
            (EXPIRES_AT_LABEL.to_string(), (unix_now() + 120).to_string()),
        ]);
        fake.instances.lock().insert("old-1".into(), (labels, true));
        let remote = Remote::new(fake, environment, 1);
        remote.backend.reap_orphans().await.unwrap();
        let remote_parts = remote.backend.remote.as_ref().unwrap();
        assert_eq!(remote_parts.snapshot(), (1, 0));
        let deadline = remote_parts.instances.lock()["old-1"].deadline;
        assert!(deadline <= tokio::time::Instant::now() + Duration::from_secs(121));
    }

    #[test]
    fn runtime_keys_separate_workspaces_and_ephemeral_spawns() {
        let environment = spec(EgressTier::Off, None);
        let base = remote_runtime_key("cloud", &environment, &source(), None);
        let mut other_branch = source();
        other_branch.branch = "cognia/task-2".into();
        assert_ne!(base, remote_runtime_key("cloud", &environment, &other_branch, None));
        assert_ne!(base, remote_runtime_key("k8s", &environment, &source(), None));
        assert_ne!(base, remote_runtime_key("cloud", &environment, &source(), Some("agent:1")));
        // The credential is never part of an identity.
        let mut rotated = source();
        rotated.credential = Some("another".into());
        assert_eq!(base, remote_runtime_key("cloud", &environment, &rotated, None));
    }

    #[test]
    fn git_runs_as_the_agent_user_with_no_inherited_configuration() {
        let invocation = git_invocation(&UserSpec::Uid(10001), &["status"]);
        assert_eq!(invocation[1], "init-agent");
        assert!(invocation.windows(2).any(|pair| pair == ["--user", "10001"]));
        assert!(invocation.contains(&"core.hooksPath=/dev/null".to_string()));
        assert!(invocation.contains(&"credential.helper=".to_string()));
        assert_eq!(invocation.last().unwrap(), "status");
        let env = git_runtime_env().unwrap();
        let entries = env
            .iter()
            .map(|entry| {
                let (key, value) = entry.split_once('=').unwrap();
                (key.to_string(), value.to_string())
            })
            .collect();
        let runtime = cognia_sandboxd::env::decode_runtime_config_env(&entries).unwrap().unwrap();
        assert_eq!(runtime.spawn_env["GIT_TERMINAL_PROMPT"], "0");
        assert_eq!(runtime.spawn_env["GIT_CONFIG_GLOBAL"], "/dev/null");
        assert!(runtime.lifecycle_phases.is_empty());
    }
}
