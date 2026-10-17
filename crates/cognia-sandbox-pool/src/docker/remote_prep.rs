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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use super::persistent::{
    exec_spec, runtime_ready, sha256_hex, SessionApi, PROJECT_LABEL, RUNTIME_KEY_LABEL, SOCKET,
};
use super::services::{pump_bridge, BridgeGuard, BridgeTarget};
use super::*;
use crate::delivery::{CleanupState, DeliveryStore, TaskDeliveryRecord};
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
/// The first wait before retrying a destroy the provider refused; it doubles
/// up to [`DESTROY_RETRY_MAX`].
const DESTROY_RETRY_BASE: Duration = Duration::from_secs(15);
const DESTROY_RETRY_MAX: Duration = Duration::from_secs(600);
/// How often a held instance retries delivering its workspace.
const PUBLISH_RETRY_INTERVAL: Duration = Duration::from_secs(60);
/// Exporting a workspace bundle to the Host.
const BUNDLE_TIMEOUT: Duration = Duration::from_secs(1800);
/// The largest bundle the Host keeps for one session.
const MAX_RECOVERY_BUNDLE: u64 = 512 * 1024 * 1024;
/// Where undelivered workspaces are kept, under the Host's data directory.
pub const RECOVERY_DIR: &str = "sandbox-recovery";

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
    /// Where a workspace that could not be pushed is exported to; unset, a
    /// failed publish can only hold its instance until the deadline.
    recovery_dir: std::sync::OnceLock<PathBuf>,
    deliveries: std::sync::OnceLock<DeliveryStore>,
    pending_deliveries: Mutex<HashMap<String, (Value, CleanupState)>>,
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
    /// What its workspace is, kept apart from the link so a publish can still
    /// commit and export after the link is gone.
    checkout: Option<Checkout>,
    /// The provider refused to delete it. It stays tracked, slot held, since
    /// it may still be running and billed, and the sweep retries.
    destroy_retry: Option<DestroyRetry>,
    /// Its workspace was neither pushed nor exported. It is kept past its
    /// idle limit, the sweep retrying delivery, until the work is delivered
    /// or its deadline passes.
    held: Option<HeldPublish>,
    /// One delivery (commit, push, export) at a time in its workspace: a
    /// session's end, a retry and the deadline's last attempt never run git
    /// side by side.
    delivery: Arc<tokio::sync::Mutex<()>>,
    delivery_sinks: Vec<(String, String, Arc<dyn ExternalAgentEventSink>)>,
}

#[derive(Clone)]
struct Checkout {
    source: RemoteWorkspaceSource,
    user: UserSpec,
    /// The commit the workspace was cloned at; `None` for an instance adopted
    /// after a Host restart, whose clone predates this process.
    base_commit: Option<String>,
}

struct DestroyRetry {
    attempts: u32,
    next_at: tokio::time::Instant,
}

impl DestroyRetry {
    fn after(attempts: u32) -> Self {
        let delay = DESTROY_RETRY_BASE
            .saturating_mul(1u32 << attempts.saturating_sub(1).min(16))
            .min(DESTROY_RETRY_MAX);
        Self {
            attempts,
            next_at: tokio::time::Instant::now() + delay,
        }
    }
}

/// Who to tell when a held workspace is finally delivered.
struct HeldPublish {
    /// Every session whose work is in it, oldest first: a persistent
    /// instance reused while held carries the earlier session's work too.
    agents: Vec<(String, String, Option<Arc<dyn ExternalAgentEventSink>>)>,
    next_at: tokio::time::Instant,
    /// A delivery attempt is running off the sweep; it decides what happens
    /// next, so the sweep leaves the instance alone until it finishes.
    in_flight: bool,
    /// The bundle exceeded [`MAX_RECOVERY_BUNDLE`]; retries only push, so a
    /// too-large export is not rewritten every minute.
    export_too_large: bool,
}

impl HeldPublish {
    fn latest_agent(&self) -> String {
        self.agents
            .last()
            .map(|(_, id, _)| id.clone())
            .unwrap_or_default()
    }
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
            checkout: None,
            destroy_retry: None,
            held: None,
            delivery: Arc::new(tokio::sync::Mutex::new(())),
            delivery_sinks: Vec::new(),
        }
    }
}

/// Why a bundle could not be streamed to the Host.
enum ExportError {
    /// Over [`MAX_RECOVERY_BUNDLE`]: retrying cannot help.
    TooLarge(String),
    Failed(String),
}

/// Whether a publish report means the work reached the branch, or there was
/// none to deliver.
fn delivered(publish: &Value) -> bool {
    publish["pushed"] == true || publish["code"] == "nothing_to_publish"
}

/// Whether an undelivered publish was exported to the Host.
fn preserved(publish: &Value) -> bool {
    publish["recovery"]["bundle"].is_string()
}

/// A name component from an agent id: only characters safe in a file name.
fn file_component(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "agent".to_string()
    } else {
        cleaned
    }
}

/// The git proxy for one instance's workspace and the bridge that exposes it
/// inside the instance. Dropping it stops both.
struct WorkspaceLink {
    source: RemoteWorkspaceSource,
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
            recovery_dir: std::sync::OnceLock::new(),
            deliveries: std::sync::OnceLock::new(),
            pending_deliveries: Mutex::new(HashMap::new()),
        }
    }

    fn workspace(&self, instance: &str) -> Option<Arc<WorkspaceLink>> {
        self.instances
            .lock()
            .get(instance)
            .and_then(|entry| entry.workspace.clone())
    }

    fn checkout(&self, instance: &str) -> Option<Checkout> {
        self.instances
            .lock()
            .get(instance)
            .and_then(|entry| entry.checkout.clone())
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

    /// Export a workspace that cannot be pushed to `data_dir`'s
    /// [`RECOVERY_DIR`] before its instance is destroyed. Set once, at boot.
    pub fn configure_publish_recovery(&self, data_dir: &Path) {
        if let Some(remote) = self.remote.as_ref() {
            let _ = remote.recovery_dir.set(data_dir.join(RECOVERY_DIR));
            let _ = remote.deliveries.set(DeliveryStore::new(data_dir));
        }
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
                    workspace_env: BTreeMap::new(),
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
        let mut key = remote_runtime_key(
            &remote.provider_id,
            &admitted.spec,
            &source,
            (!persistent).then_some(ephemeral_identity.as_str()),
        );

        let workspace_env = match config.cwd.as_deref() {
            Some(cwd) => workspace_port_env(cwd).await?,
            None => BTreeMap::new(),
        };
        // Dynamic lease values are runtime compatibility, not approval input.
        if !workspace_env.is_empty() {
            key = sha256_hex(format!("{key}\0{workspace_env:?}").as_bytes());
        }
        let mut boot = runtime_config_with_env(&admitted.spec, BTreeMap::new())?;
        boot.workspace_env = workspace_env.clone();
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
            self.ensure_workspace_link(&instance, &source, &user)
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
        let mut runtime =
            runtime_config_with_env(&admitted.spec, config.env.clone().into_iter().collect())?;
        runtime.workspace_env = workspace_env.clone();
        connect.workspace_env = workspace_env;
        runtime.lifecycle_phases = vec![LifecyclePhase::PostAttach];
        connect.env = encode_runtime_config_env(&runtime)
            .map_err(|error| refused("sandbox_runtime_config_invalid", error.to_string()))?;

        if let Some(store) = remote.deliveries.get() {
            store
                .create(TaskDeliveryRecord::running(
                    session.clone(),
                    id.clone(),
                    gateway.as_ref().map(|authority| authority.task_id.clone()),
                    remote.provider_id.clone(),
                    instance.clone(),
                    source.branch.clone(),
                ))
                .map_err(|error| fault("sandbox_delivery_store_failed", error))?;
        }
        let cleanup = Arc::new(RemoteSession {
            delivery_id: session.clone(),
            session: SessionApi::new(self.api.clone(), instance.clone(), session.clone()),
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
                self.record_publish(
                    &session,
                    &id,
                    Some(&sink),
                    &json!({"pushed":false,"code":"sandbox_persistent_runtime_failed"}),
                    CleanupState::Pending,
                );
                return Err(fault("sandbox_persistent_runtime_failed", error));
            }
        };
        if let Some(entry) = remote.instances.lock().get_mut(&instance) {
            entry
                .delivery_sinks
                .push((session.clone(), id.clone(), Arc::clone(&sink)));
            entry.sessions.insert(id.clone());
            entry.idle_since = None;
        }
        teardown.armed = false;

        let mut placement = remote_placement(
            &admitted,
            &report,
            libc,
            &invocation,
            &config,
            remote,
            egress_enforced,
            &source,
        );
        placement["deliveryRecordId"] = json!(session);
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
        let still_removing = || {
            fault(
                "sandbox_persistent_runtime_failed",
                "the previous instance for this workspace is still being removed",
            )
        };
        let removing = remote
            .instances
            .lock()
            .get(&existing.id)
            .is_some_and(|entry| entry.destroy_retry.is_some());
        if removing {
            return if self.destroy_instance(&existing.id).await {
                Ok(None)
            } else {
                Err(still_removing())
            };
        }
        {
            let mut instances = remote.instances.lock();
            if let Some(entry) = instances.get_mut(&existing.id) {
                if let Some(held) = entry.held.as_mut() {
                    if held.in_flight {
                        return Err(fault(
                            "sandbox_persistent_runtime_failed",
                            "the previous session's work in this workspace is still being delivered",
                        ));
                    }
                    // The new session's own end delivers this work with
                    // its own; no retry may commit under a running agent.
                    held.next_at = entry.deadline;
                }
            }
        }
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
                return if self.destroy_instance(&existing.id).await {
                    Ok(None)
                } else {
                    Err(still_removing())
                };
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
        if remote.instances.lock().len() >= remote.limits.max_concurrent.max(1) as usize {
            return Err(fault(
                "sandbox_provider_capacity",
                "the remote provider is at capacity",
            ));
        }
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

    fn delivery_cleanup(&self, instance: &str, safe: bool) -> CleanupState {
        let persistent = self.remote.as_ref().is_some_and(|remote| {
            remote
                .instances
                .lock()
                .get(instance)
                .is_some_and(|entry| entry.persistent)
        });
        if persistent || !safe {
            CleanupState::Retained
        } else {
            CleanupState::Pending
        }
    }

    fn record_publish(
        &self,
        record_id: &str,
        agent_id: &str,
        sink: Option<&Arc<dyn ExternalAgentEventSink>>,
        publish: &Value,
        cleanup: CleanupState,
    ) {
        let mut event = publish.clone();
        event["deliveryRecordId"] = json!(record_id);
        if let Some((remote, store)) = self
            .remote
            .as_ref()
            .and_then(|remote| remote.deliveries.get().map(|store| (remote, store)))
        {
            // Same lock order as retry: a queued older outcome must never
            // overwrite a newer successfully persisted delivery.
            let mut pending = remote.pending_deliveries.lock();
            match store.publish(record_id, publish, cleanup) {
                Ok(record) => {
                    pending.remove(record_id);
                    event["deliveryRecord"] = json!(record);
                }
                Err(error) => {
                    pending.insert(record_id.into(), (publish.clone(), cleanup));
                    log::error!("persisting sandbox delivery {record_id} failed: {error}");
                    event["deliveryRecordError"] =
                        json!({"code":"sandbox_delivery_store_failed","message":error});
                }
            }
        }
        if let Some(sink) = sink {
            sink.workspace_published(agent_id, &event);
        }
    }

    /// A journal failure must not erase a known push/bundle outcome. Keep the
    /// exact report and retry it before deletion; retries also run for held
    /// instances. Provider TTL remains the external lifetime bound.
    fn flush_pending_deliveries(&self) -> bool {
        let Some(remote) = self.remote.as_ref() else {
            return true;
        };
        let Some(store) = remote.deliveries.get() else {
            return true;
        };
        let mut pending = remote.pending_deliveries.lock();
        let mut written = Vec::new();
        pending.retain(
            |id, (publish, cleanup)| match store.publish(id, publish, *cleanup) {
                Ok(record) => {
                    written.push(record);
                    false
                }
                Err(error) => {
                    log::error!("retrying sandbox delivery {id} failed: {error}");
                    true
                }
            },
        );
        let complete = pending.is_empty();
        drop(pending);
        let sinks: Vec<_> = remote
            .instances
            .lock()
            .values()
            .flat_map(|entry| entry.delivery_sinks.clone())
            .collect();
        for record in written {
            if let Some((_, agent, sink)) = sinks.iter().find(|(id, _, _)| id == &record.id) {
                let mut publish = record.publish.clone();
                publish["deliveryRecord"] = json!(record);
                sink.workspace_published(agent, &publish);
            }
        }
        complete
    }

    fn notify_held(&self, instance: &str, held: &HeldPublish, publish: &Value) {
        for (record_id, agent_id, sink) in &held.agents {
            self.record_publish(
                record_id,
                agent_id,
                sink.as_ref(),
                publish,
                self.delivery_cleanup(instance, !publish["held"].as_bool().unwrap_or(false)),
            );
        }
    }

    fn record_cleanup(&self, instance: &str, state: CleanupState, lost: bool) -> bool {
        let Some(remote) = self.remote.as_ref() else {
            return true;
        };
        let Some(store) = remote.deliveries.get() else {
            return true;
        };
        let sinks = remote
            .instances
            .lock()
            .get(instance)
            .map(|entry| entry.delivery_sinks.clone())
            .unwrap_or_default();
        match store.cleanup(&remote.provider_id, instance, state, lost) {
            Ok(records) => {
                for record in records {
                    if let Some((_, agent_id, sink)) =
                        sinks.iter().find(|(id, _, _)| id == &record.id)
                    {
                        let mut publish = record.publish.clone();
                        publish["deliveryRecord"] = json!(record);
                        sink.workspace_published(agent_id, &publish);
                    }
                }
                true
            }
            Err(error) => {
                log::error!("persisting cleanup of sandbox {instance} failed: {error}");
                for (record_id, agent_id, sink) in sinks {
                    sink.workspace_published(&agent_id, &json!({"pushed":false,"code":"sandbox_delivery_store_failed","deliveryRecordId":record_id,"deliveryRecordError":{"code":"sandbox_delivery_store_failed","message":error}}));
                }
                false
            }
        }
    }

    /// Destroy an instance and forget it, releasing its slot, proxy and
    /// bridge. Idempotent. When the provider refuses, the instance stays
    /// tracked with its slot held (it may still be running and billed) and
    /// the sweep retries with backoff; the provider's own TTL is the last
    /// bound. Returns whether it is gone.
    async fn destroy_instance(&self, instance: &str) -> bool {
        if !self.flush_pending_deliveries() {
            if let Some(remote) = self.remote.as_ref() {
                if let Some(entry) = remote.instances.lock().get_mut(instance) {
                    entry.destroy_retry = Some(DestroyRetry::after(1));
                }
            }
            return false;
        }
        let Err(error) = remove_owned(&self.container, instance).await else {
            if !self.record_cleanup(instance, CleanupState::Destroyed, true) {
                if let Some(remote) = self.remote.as_ref() {
                    if let Some(entry) = remote.instances.lock().get_mut(instance) {
                        entry.destroy_retry = Some(DestroyRetry::after(1));
                        entry.workspace = None;
                        entry.held = None;
                    }
                }
                return false;
            }
            if let Some(remote) = self.remote.as_ref() {
                remote.instances.lock().remove(instance);
            }
            return true;
        };
        let Some(remote) = self.remote.as_ref() else {
            log::warn!("remote instance {instance} could not be destroyed: {error}");
            return false;
        };
        self.record_cleanup(instance, CleanupState::DestroyRetrying, false);
        let mut instances = remote.instances.lock();
        match instances.get_mut(instance) {
            Some(entry) => {
                let attempts = entry.destroy_retry.as_ref().map_or(0, |retry| retry.attempts) + 1;
                let retry = DestroyRetry::after(attempts);
                log::warn!(
                    "remote instance {instance} could not be destroyed (attempt {attempts}): {error}; retrying in {}s",
                    retry.next_at.saturating_duration_since(tokio::time::Instant::now()).as_secs()
                );
                entry.destroy_retry = Some(retry);
                // Nothing may use an instance that is being removed.
                entry.workspace = None;
                entry.held = None;
            }
            None => {
                log::warn!(
                    "remote instance {instance} could not be destroyed: {error}; left to its TTL and the next reap"
                );
            }
        }
        false
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
                workspace_env: BTreeMap::new(),
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
            // The same workspace keeps the commit it was cloned at.
            let base_commit = entry
                .checkout
                .take()
                .filter(|checkout| checkout.source == *source)
                .and_then(|checkout| checkout.base_commit);
            entry.checkout = Some(Checkout {
                source: source.clone(),
                user: user.clone(),
                base_commit,
            });
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
        // Held so the proxy stays up for the clone.
        let _link = self
            .ensure_workspace_link(instance, source, user)
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
        if let Some(remote) = self.remote.as_ref() {
            if let Some(checkout) = remote
                .instances
                .lock()
                .get_mut(instance)
                .and_then(|entry| entry.checkout.as_mut())
            {
                checkout.base_commit = Some(base);
            }
        }
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

    /// Commit the workspace, then push it to the task's branch through the
    /// proxy. The commit comes before the link is re-established so a link
    /// that cannot come back still leaves the work committed for
    /// [`Self::preserve_workspace`] to export.
    async fn publish_workspace(&self, instance: &str) -> Value {
        let Some(remote) = self.remote.as_ref() else {
            return json!({ "pushed": false, "code": "sandbox_workspace_unavailable" });
        };
        let Some(checkout) = remote.checkout(instance) else {
            return json!({ "pushed": false, "code": "sandbox_workspace_unavailable" });
        };
        let branch = checkout.source.branch.clone();
        let env = match git_runtime_env() {
            Ok(env) => env,
            Err(error) => {
                return json!({ "branch": branch, "pushed": false, "code": error.code, "message": error.message })
            }
        };
        let git = |args: Vec<String>| {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            git_invocation(&checkout.user, &args)
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
        if checkout.base_commit.as_deref() == Some(head.as_str()) {
            return json!({ "branch": branch, "pushed": false, "code": "nothing_to_publish", "commit": head });
        }
        if let Err(error) = self
            .ensure_workspace_link(instance, &checkout.source, &checkout.user)
            .await
        {
            return json!({ "branch": branch, "pushed": false, "commit": head, "code": error.code, "message": error.message });
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
            Err(error) => {
                json!({ "branch": branch, "pushed": false, "commit": head, "code": "sandbox_workspace_publish_failed", "message": error })
            }
        }
    }

    /// Keep an undelivered workspace on the Host: a git bundle of every
    /// commit not on the remote, in [`RECOVERY_DIR`], beside a manifest of
    /// where it came from. Returns `publish` with a `recovery` object: its
    /// `bundle` path when exported, `code: "nothing_to_preserve"` when every
    /// commit is already on the remote, else the failure.
    async fn preserve_workspace(&self, instance: &str, agent_id: &str, mut publish: Value) -> Value {
        let recovery = self.export_workspace(instance, agent_id, &publish).await;
        publish["recovery"] = match recovery {
            Ok(recovery) => recovery,
            Err((code, message)) => json!({ "code": code, "message": message }),
        };
        publish
    }

    async fn export_workspace(
        &self,
        instance: &str,
        agent_id: &str,
        publish: &Value,
    ) -> Result<Value, (&'static str, String)> {
        let failed = |message: String| ("sandbox_workspace_recovery_failed", message);
        let remote = self.remote.as_ref().ok_or_else(|| failed("not a remote driver".into()))?;
        let Some(dir) = remote.recovery_dir.get() else {
            return Err((
                "sandbox_workspace_recovery_unavailable",
                "this Host keeps no recovery directory".into(),
            ));
        };
        let checkout = remote
            .checkout(instance)
            .ok_or_else(|| failed("the workspace is no longer known".into()))?;
        let env = git_runtime_env().map_err(|error| failed(error.message))?;
        let git = |args: &[&str]| git_invocation(&checkout.user, args);

        // A bundle holds commits only: changes the publish could not commit
        // are not preserved by one, so they are not "nothing to preserve".
        let status = self
            .exec_collect(
                instance,
                git(&["-C", WORKSPACE_TARGET, "status", "--porcelain"]),
                env.clone(),
                GIT_TIMEOUT,
            )
            .await
            .map_err(failed)?;
        if !status.succeeded() {
            return Err(failed(status.tail()));
        }
        if !status.stdout.iter().all(u8::is_ascii_whitespace) {
            return Err(failed("the workspace has changes that could not be committed".into()));
        }

        // Everything not on a remote-tracking ref of the clone: the agent's
        // own commits, whether or not this process saw the clone.
        let count = self
            .exec_collect(
                instance,
                git(&["-C", WORKSPACE_TARGET, "rev-list", "--count", "HEAD", "--not", "--remotes"]),
                env.clone(),
                GIT_TIMEOUT,
            )
            .await
            .map_err(failed)?;
        if !count.succeeded() {
            return Err(failed(count.tail()));
        }
        let commits: u64 = String::from_utf8_lossy(&count.stdout)
            .trim()
            .parse()
            .map_err(|_| failed("git did not report a commit count".into()))?;
        if commits == 0 {
            return Ok(json!({ "code": "nothing_to_preserve" }));
        }
        let head = self
            .exec_collect(
                instance,
                git(&["-C", WORKSPACE_TARGET, "rev-parse", "HEAD"]),
                env.clone(),
                GIT_TIMEOUT,
            )
            .await
            .map_err(failed)?;
        let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
        if head.is_empty() {
            return Err(failed("git did not report the workspace commit".into()));
        }

        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|error| failed(error.to_string()))?;
        let stem = format!(
            "{}-{}-{}",
            file_component(agent_id),
            &head[..head.len().min(12)],
            unix_now()
        );
        let bundle = dir.join(format!("{stem}.bundle"));
        let partial = dir.join(format!("{stem}.bundle.partial"));
        let bytes = self
            .exec_to_file(
                instance,
                git(&["-C", WORKSPACE_TARGET, "bundle", "create", "-", "HEAD", "--not", "--remotes"]),
                env,
                &partial,
            )
            .await;
        let bytes = match bytes {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = tokio::fs::remove_file(&partial).await;
                return Err(match error {
                    ExportError::TooLarge(message) => ("sandbox_workspace_recovery_too_large", message),
                    ExportError::Failed(message) => failed(message),
                });
            }
        };
        if let Err(error) = tokio::fs::rename(&partial, &bundle).await {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(failed(error.to_string()));
        }
        let branch = checkout.source.branch.as_str();
        let manifest = json!({
            "agentId": agent_id,
            "provider": remote.provider_id,
            "instance": instance,
            "remoteUrl": checkout.source.remote_url,
            "baseRef": checkout.source.base_ref,
            "branch": branch,
            "baseCommit": checkout.base_commit,
            "commit": head,
            "commits": commits,
            "bytes": bytes,
            "publish": { "code": publish["code"], "message": publish["message"] },
            "createdAt": unix_now(),
            "restore": format!("git fetch {} HEAD:{branch}", bundle.display()),
        });
        let manifest_path = dir.join(format!("{stem}.json"));
        let written = match serde_json::to_vec_pretty(&manifest) {
            Ok(body) => tokio::fs::write(&manifest_path, body)
                .await
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        if let Err(error) = written {
            // The bundle is the work; a missing manifest only loses context.
            log::warn!("writing {} failed: {error}", manifest_path.display());
        }
        log::warn!(
            "the workspace of {agent_id} could not be pushed; {commits} commit(s) kept in {}",
            bundle.display()
        );
        Ok(json!({
            "bundle": bundle.to_string_lossy(),
            "commit": head,
            "commits": commits,
            "bytes": bytes,
        }))
    }

    /// Run one command in an instance and stream its stdout into `path`, at
    /// most [`MAX_RECOVERY_BUNDLE`] bytes. Returns how many were written.
    async fn exec_to_file(
        &self,
        instance: &str,
        command: Vec<String>,
        env: Vec<String>,
        path: &Path,
    ) -> Result<u64, ExportError> {
        use tokio::io::AsyncWriteExt;
        let io = |error: std::io::Error| ExportError::Failed(error.to_string());
        tokio::time::timeout(BUNDLE_TIMEOUT, async {
            let mut file = tokio::fs::File::create(path).await.map_err(io)?;
            let mut running = self
                .api
                .exec_runtime(RunnerExecSpec {
                    workspace_env: BTreeMap::new(),
                    container_id: instance.to_string(),
                    command,
                    env,
                    working_dir: "/".to_string(),
                })
                .await
                .map_err(ExportError::Failed)?;
            drop(running.stdin);
            let mut written: u64 = 0;
            let mut stderr = Vec::new();
            while let Some(event) = running.events.recv().await {
                match event {
                    RunnerEvent::Stdout(bytes) => {
                        written += bytes.len() as u64;
                        if written > MAX_RECOVERY_BUNDLE {
                            return Err(ExportError::TooLarge(format!(
                                "the bundle is larger than {} MiB",
                                MAX_RECOVERY_BUNDLE / (1024 * 1024)
                            )));
                        }
                        file.write_all(&bytes).await.map_err(io)?;
                    }
                    RunnerEvent::Stderr(bytes) => extend_capped(&mut stderr, &bytes),
                    RunnerEvent::Exited { code: Some(0) } => {
                        file.sync_all().await.map_err(io)?;
                        return if written == 0 {
                            Err(ExportError::Failed("git wrote an empty bundle".to_string()))
                        } else {
                            Ok(written)
                        };
                    }
                    RunnerEvent::Exited { code } => {
                        let output = ExecOutput { stdout: Vec::new(), stderr, code };
                        return Err(ExportError::Failed(format!(
                            "git bundle exited with {code:?}: {}",
                            output.tail()
                        )));
                    }
                }
            }
            Err(ExportError::Failed(
                "the bundle stream ended without an exit".to_string(),
            ))
        })
        .await
        .map_err(|_| ExportError::Failed("exporting the bundle timed out".to_string()))?
    }

    /// Publish, and when that does not deliver, preserve. Returns the report
    /// and whether the work is safe: delivered, exported, or nothing new.
    /// Deliveries into one workspace run one at a time.
    async fn deliver_workspace(&self, instance: &str, agent_id: &str, export: bool) -> (Value, bool) {
        let delivery = self.remote.as_ref().and_then(|remote| {
            remote
                .instances
                .lock()
                .get(instance)
                .map(|entry| Arc::clone(&entry.delivery))
        });
        let _turn = match delivery.as_ref() {
            Some(delivery) => Some(delivery.lock().await),
            None => None,
        };
        let publish = self.publish_workspace(instance).await;
        if delivered(&publish) {
            return (publish, true);
        }
        if !export {
            let mut publish = publish;
            publish["recovery"] = json!({
                "code": "sandbox_workspace_recovery_too_large",
                "message": "an earlier export was over the size limit",
            });
            return (publish, false);
        }
        let publish = self.preserve_workspace(instance, agent_id, publish).await;
        let safe = preserved(&publish) || publish["recovery"]["code"] == "nothing_to_preserve";
        (publish, safe)
    }

    /// A session ended: publish, then destroy an ephemeral instance or mark a
    /// persistent one idle. Work that was neither pushed nor exported holds
    /// the instance, past its idle limit, while the sweep retries.
    async fn finish_remote_session(
        &self,
        instance: &str,
        delivery_id: &str,
        agent_id: &str,
        sink: &Arc<dyn ExternalAgentEventSink>,
    ) {
        let Some(remote) = self.remote.as_ref() else {
            return;
        };
        let tracked = remote.instances.lock().contains_key(instance);
        let mut outcome = None;
        if tracked {
            let (mut publish, safe) = self.deliver_workspace(instance, agent_id, true).await;
            if !safe {
                // Kept on the instance until it is delivered or the deadline
                // passes; the UI says so.
                publish["held"] = json!(true);
            }
            self.record_publish(
                delivery_id,
                agent_id,
                Some(sink),
                &publish,
                self.delivery_cleanup(instance, safe),
            );
            outcome = Some((publish, safe));
        } else {
            self.record_publish(
                delivery_id,
                agent_id,
                Some(sink),
                &json!({"pushed":false,"discarded":true,"code":"sandbox_workspace_instance_lost"}),
                CleanupState::Destroyed,
            );
        }
        let (destroy, earlier) = {
            let mut instances = remote.instances.lock();
            match instances.get_mut(instance) {
                Some(entry) => {
                    entry.sessions.remove(agent_id);
                    if entry.sessions.is_empty() {
                        entry.idle_since = Some(tokio::time::Instant::now());
                    }
                    // Earlier sessions whose work was held here: this
                    // delivery carried it too.
                    let mut agents = match outcome {
                        Some(_) => entry.held.take().map(|held| held.agents).unwrap_or_default(),
                        None => Vec::new(),
                    };
                    agents.retain(|(id, _, _)| id != delivery_id);
                    let mut earlier = None;
                    match outcome.as_ref() {
                        Some((publish, false)) => {
                            agents.push((
                                delivery_id.to_string(),
                                agent_id.to_string(),
                                Some(Arc::clone(sink)),
                            ));
                            entry.held = Some(HeldPublish {
                                agents,
                                next_at: tokio::time::Instant::now() + PUBLISH_RETRY_INTERVAL,
                                in_flight: false,
                                export_too_large: publish["recovery"]["code"]
                                    == "sandbox_workspace_recovery_too_large",
                            });
                        }
                        Some((_, true)) => earlier = Some(agents),
                        None => {}
                    }
                    (!entry.persistent && entry.held.is_none(), earlier)
                }
                None => (false, None),
            }
        };
        if let (Some(agents), Some((publish, _))) = (earlier, outcome.as_ref()) {
            for (record_id, id, sink) in agents {
                self.record_publish(
                    &record_id,
                    &id,
                    sink.as_ref(),
                    publish,
                    self.delivery_cleanup(instance, true),
                );
            }
        }
        if destroy {
            self.destroy_instance(instance).await;
        }
    }

    /// Retry delivering a held instance's workspace. Once it is safe, an
    /// ephemeral instance is destroyed and a persistent one goes back to its
    /// idle limit.
    async fn retry_held_publish(&self, instance: &str) {
        let Some(remote) = self.remote.as_ref() else {
            return;
        };
        let Some((agent_id, export)) = remote
            .instances
            .lock()
            .get(instance)
            .and_then(|entry| entry.held.as_ref())
            .map(|held| (held.latest_agent(), !held.export_too_large))
        else {
            return;
        };
        let (publish, safe) = self.deliver_workspace(instance, &agent_id, export).await;
        let (destroy, delivered_to) = {
            let mut instances = remote.instances.lock();
            let Some(entry) = instances.get_mut(instance) else {
                return;
            };
            let mut delivered_to = None;
            if safe {
                delivered_to = entry.held.take();
                entry.idle_since = entry
                    .sessions
                    .is_empty()
                    .then(tokio::time::Instant::now);
            } else if let Some(held) = entry.held.as_mut() {
                held.next_at = tokio::time::Instant::now() + PUBLISH_RETRY_INTERVAL;
                held.in_flight = false;
                held.export_too_large |=
                    publish["recovery"]["code"] == "sandbox_workspace_recovery_too_large";
            }
            (safe && !entry.persistent && entry.sessions.is_empty(), delivered_to)
        };
        if let Some(held) = delivered_to {
            self.notify_held(instance, &held, &publish);
            if destroy {
                self.destroy_instance(instance).await;
            }
        } else {
            log::warn!(
                "the workspace of {agent_id} is still undelivered ({}); retrying",
                publish["code"]
            );
        }
    }

    /// Destroy instances past their deadline and persistent ones idle too
    /// long, retry destroys the provider refused, and retry delivering held
    /// workspaces. Deliveries run off the sweep: a push or an export can take
    /// minutes, and the other instances' deadlines must not wait for it.
    pub(super) async fn sweep_remote_instances(&self) {
        let Some(remote) = self.remote.as_ref() else {
            return;
        };
        self.flush_pending_deliveries();
        let now = tokio::time::Instant::now();
        let mut stop_sessions = Vec::new();
        let mut destroy = Vec::new();
        let mut retry_publish = Vec::new();
        let mut held_at_deadline = Vec::new();
        let mut overrun = Vec::new();
        {
            let mut instances = remote.instances.lock();
            for (id, entry) in instances.iter_mut() {
                if let Some(retry) = entry.destroy_retry.as_ref() {
                    if now >= retry.next_at {
                        destroy.push(id.clone());
                    }
                    continue;
                }
                if entry.held.as_ref().is_some_and(|held| held.in_flight) {
                    if now < entry.deadline + DEADLINE_GRACE {
                        continue;
                    }
                    // A delivery still running past the deadline's grace: the
                    // provider's TTL has ended the instance or is about to.
                    if let Some(held) = entry.held.take() {
                        overrun.push((id.clone(), held));
                    }
                    destroy.push(id.clone());
                    continue;
                }
                if now >= entry.deadline {
                    match entry.stopping_since {
                        None if !entry.sessions.is_empty() => {
                            entry.stopping_since = Some(now);
                            stop_sessions.extend(entry.sessions.iter().cloned());
                        }
                        Some(since) if now < since + DEADLINE_GRACE => {}
                        _ => match entry.held.as_mut() {
                            Some(held) => {
                                held.in_flight = true;
                                held_at_deadline.push(id.clone());
                            }
                            None => destroy.push(id.clone()),
                        },
                    }
                } else if let Some(held) = entry.held.as_mut() {
                    if entry.sessions.is_empty() && now >= held.next_at {
                        held.in_flight = true;
                        retry_publish.push(id.clone());
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
        for (instance, held) in overrun {
            log::warn!("a delivery from instance {instance} outran its deadline; discarding it");
            self.notify_held(&instance, &held, &json!({
                "pushed": false,
                "code": "sandbox_workspace_deadline",
                "message": "the sandbox reached its deadline while its work was being delivered",
                "discarded": true,
            }));
        }
        for instance in retry_publish {
            let backend = self.own.clone();
            tokio::spawn(async move {
                if let Some(backend) = backend.upgrade() {
                    backend.retry_held_publish(&instance).await;
                }
            });
        }
        for instance in held_at_deadline {
            let backend = self.own.clone();
            tokio::spawn(async move {
                if let Some(backend) = backend.upgrade() {
                    backend.last_delivery(&instance).await;
                    log::info!("destroying held instance {instance} at its deadline");
                    backend.destroy_instance(&instance).await;
                }
            });
        }
        for instance in destroy {
            log::info!(
                "destroying {} instance {instance} (deadline, idle limit or a retried removal)",
                remote.provisioner.kind()
            );
            self.destroy_instance(&instance).await;
        }
    }

    /// Before a held instance is destroyed at its deadline: one more attempt,
    /// and if the work is still undelivered, say it is being discarded. The
    /// hold stays (in flight) until the attempt returns, so no sweep destroys
    /// the instance under it.
    async fn last_delivery(&self, instance: &str) {
        let Some(remote) = self.remote.as_ref() else {
            return;
        };
        let Some((agent_id, export)) = remote
            .instances
            .lock()
            .get(instance)
            .and_then(|entry| entry.held.as_ref())
            .map(|held| (held.latest_agent(), !held.export_too_large))
        else {
            return;
        };
        let (mut publish, safe) = self.deliver_workspace(instance, &agent_id, export).await;
        let Some(held) = remote
            .instances
            .lock()
            .get_mut(instance)
            .and_then(|entry| entry.held.take())
        else {
            return;
        };
        if !safe {
            publish["discarded"] = json!(true);
            log::warn!(
                "the workspace of {agent_id} was never delivered; its instance {instance} reached its deadline"
            );
        }
        self.notify_held(instance, &held, &publish);
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
        let history = match remote
            .deliveries
            .get()
            .map(|store| store.list(None, None))
            .transpose()
        {
            Ok(records) => records.unwrap_or_default(),
            Err(error) => {
                log::error!("reading sandbox history during reconciliation failed: {error}");
                return Vec::new();
            }
        };
        // A provider list that succeeded is authoritative for instances already
        // deleted by its TTL (or by a previous Host after the last journal write).
        for record in &history {
            if record.provider_id == remote.provider_id
                && record.cleanup_state != CleanupState::Destroyed
                && !owned.iter().any(|item| item.id == record.instance_id)
            {
                self.record_cleanup(&record.instance_id, CleanupState::Destroyed, true);
            }
        }
        let mut destroyed = Vec::new();
        for item in owned {
            if item.deployment() != Some(self.config.deployment_id.as_str())
                || item.labels.get(PROVIDER_LABEL) != Some(&remote.provider_id)
                || remote.instances.lock().contains_key(&item.id)
            {
                continue;
            }
            let persistent = item
                .labels
                .get(PERSISTENT_RUNTIME_LABEL)
                .map(String::as_str)
                == Some("1");
            let removing = history.iter().any(|r| {
                r.provider_id == remote.provider_id
                    && r.instance_id == item.id
                    && matches!(
                        r.cleanup_state,
                        CleanupState::Pending | CleanupState::DestroyRetrying
                    )
            });
            // Adopt even an orphan being removed so failed removal remains
            // tracked and retries, including when boot found more instances
            // than the newly configured capacity.
            let slot = match remote.slots.clone().try_acquire_owned() {
                Ok(slot) => slot,
                Err(_) => {
                    Arc::new(tokio::sync::Semaphore::new(1)).try_acquire_owned().expect("the orphan slot")
                }
            };
            let mut adopted = Instance::new(
                slot,
                persistent,
                deadline_from_labels(&item.labels, remote.limits.max_lifetime),
                Some(tokio::time::Instant::now()),
            );
            let unresolved: Vec<_> = history
                .iter()
                .filter(|r| {
                    r.provider_id == remote.provider_id
                        && r.instance_id == item.id
                        && matches!(
                            r.publish_state,
                            crate::delivery::PublishState::Held
                                | crate::delivery::PublishState::Running
                        )
                })
                .collect();
            if persistent && !removing && !unresolved.is_empty() {
                adopted.held = Some(HeldPublish {
                    agents: unresolved
                        .iter()
                        .map(|r| (r.id.clone(), r.agent_id.clone(), None))
                        .collect(),
                    next_at: tokio::time::Instant::now() + PUBLISH_RETRY_INTERVAL,
                    in_flight: false,
                    export_too_large: unresolved.iter().any(|r| {
                        r.publish["recovery"]["code"] == "sandbox_workspace_recovery_too_large"
                    }),
                });
            }
            remote.instances.lock().insert(item.id.clone(), adopted);
            if !persistent
                || removing
                || remote.instances.lock().len() > remote.limits.max_concurrent as usize
            {
                if self.destroy_instance(&item.id).await {
                    destroyed.push(item.id);
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
    delivery_id: String,
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
                    .finish_remote_session(
                        &self.instance,
                        &self.delivery_id,
                        &self.agent_id,
                        &self.sink,
                    )
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
    async fn trusted_workspace_ports_survive_remote_boot_scrubbing_and_exec() {
        super::super::tests::install_port_provider();
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 2);
        let mut config = remote_config("port-agent", &environment);
        config.cwd = Some(super::super::tests::PORT_CWD.into());
        config.env.insert("PORT".into(), "9999".into());
        remote.spawn(config).await.unwrap();
        let request = remote.fake.provisions.lock()[0].clone();
        let boot = super::super::tests::decode_agent_environment(&request.supervisor_env);
        assert!(boot.spawn_env.is_empty());
        assert_eq!(boot.workspace_env["PORT"], "41000");
        let exec = remote
            .fake
            .execs
            .lock()
            .iter()
            .find(|exec| exec.command.iter().any(|arg| arg == "connect-agent"))
            .unwrap()
            .clone();
        let runtime = super::super::tests::decode_agent_environment(&exec.env);
        assert_eq!(runtime.spawn_env["PORT"], "9999");
        assert_eq!(runtime.workspace_env, boot.workspace_env);
        assert_eq!(exec.workspace_env, boot.workspace_env);
        remote.exit_session();
    }

    #[tokio::test]
    async fn real_provider_frontend_leases_reach_remote_boot_and_exec_unchanged() {
        for kind in ["project-root", "desktop-session"] {
            let (cwd, expected) = super::super::tests::real_workspace_env_fixture(kind);
            let environment = spec(EgressTier::Off, None);
            let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 2);
            let mut config = remote_config("real-port-agent", &environment);
            config.cwd = Some(cwd.path().to_string_lossy().into_owned());
            config.env.insert("PORT".into(), "9999".into());
            remote.spawn(config).await.unwrap();
            let request = remote.fake.provisions.lock()[0].clone();
            let boot = super::super::tests::decode_agent_environment(&request.supervisor_env);
            assert!(boot.spawn_env.is_empty());
            assert_eq!(boot.workspace_env, expected);
            let exec = remote.fake.execs.lock().iter()
                .find(|exec| exec.command.iter().any(|arg| arg == "connect-agent"))
                .unwrap().clone();
            let runtime = super::super::tests::decode_agent_environment(&exec.env);
            assert_eq!(runtime.workspace_env, expected);
            assert_eq!(exec.workspace_env, expected);
            remote.exit_session();
        }
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

    fn answer(stdout: &str, code: i64) -> GitAnswer {
        GitAnswer { stdout: stdout.into(), code }
    }

    /// A workspace the agent changed: cloned at `a…`, committed as `b…`,
    /// clean once the publish has committed it.
    fn changed_workspace(fake: &FakeRemote) {
        fake.answer_git(
            "rev-parse",
            vec![answer(&format!("{}\n", "a".repeat(40)), 0), answer(&format!("{}\n", "b".repeat(40)), 0)],
        );
        fake.answer_git("status", vec![answer(" M src/main.rs\n", 0), answer("", 0)]);
    }

    fn recovery_files(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir.join(RECOVERY_DIR))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[tokio::test]
    async fn a_refused_push_keeps_the_work_in_a_host_bundle_before_the_instance_goes() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        let data = tempfile::tempdir().unwrap();
        remote.backend.configure_publish_recovery(data.path());
        changed_workspace(&remote.fake);
        remote.fake.answer_git("push", vec![answer("! [rejected] (non-fast-forward)", 1)]);
        remote.fake.answer_git("rev-list", vec![answer("2\n", 0)]);
        remote.fake.answer_git("bundle", vec![answer("# v2 git bundle\n", 0)]);
        remote.spawn(remote_config("agent/1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the instance to be released", |remote| {
                remote.fake.removed.lock().contains(&"instance-1".to_string())
            })
            .await;

        let publish = &remote.events(WORKSPACE_PUBLISH_CHANNEL)[0]["publish"];
        assert_eq!(publish["pushed"], false);
        assert_eq!(publish["code"], "sandbox_workspace_push_refused");
        assert!(publish.get("held").is_none(), "kept work does not hold the instance");
        let record = DeliveryStore::new(data.path()).list(Some("agent/1"), None).unwrap().remove(0);
        assert_eq!(record.publish_state, crate::delivery::PublishState::SavedBundle);
        assert_eq!(record.cleanup_state, CleanupState::Destroyed);
        let recovery = &publish["recovery"];
        assert_eq!(record.publish["recovery"]["bundle"], recovery["bundle"]);
        assert_eq!(recovery["commit"], "b".repeat(40));
        assert_eq!(recovery["commits"], 2);
        let bundle = PathBuf::from(recovery["bundle"].as_str().unwrap());
        assert!(bundle.starts_with(data.path().join(RECOVERY_DIR)));
        assert_eq!(std::fs::read(&bundle).unwrap(), b"# v2 git bundle\n");

        let manifest: Value =
            serde_json::from_slice(&std::fs::read(bundle.with_extension("json")).unwrap()).unwrap();
        assert_eq!(manifest["agentId"], "agent/1");
        assert_eq!(manifest["branch"], "cognia/task-1");
        assert_eq!(manifest["remoteUrl"], "https://github.com/acme/app.git");
        assert_eq!(manifest["baseCommit"], "a".repeat(40));
        assert_eq!(manifest["publish"]["code"], "sandbox_workspace_push_refused");
        assert!(manifest["restore"].as_str().unwrap().ends_with("HEAD:cognia/task-1"));
        assert!(!manifest.to_string().contains(TOKEN), "the upstream credential stays out");
        // Exactly the bundle and its manifest, named from a sanitized id.
        let files = recovery_files(data.path());
        assert_eq!(files.len(), 2, "{files:?}");
        assert!(files.iter().all(|name| name.starts_with("agent_1-bbbbbbbbbbbb-")));

        let bundle_call = remote
            .fake
            .git_calls()
            .into_iter()
            .find(|call| call.contains(&"bundle".to_string()))
            .unwrap();
        assert!(bundle_call
            .windows(6)
            .any(|args| args == ["bundle", "create", "-", "HEAD", "--not", "--remotes"]));
    }

    #[tokio::test(start_paused = true)]
    async fn delivery_history_survives_reused_agent_ids_and_tracks_idle_cleanup() {
        let mut environment = spec(EgressTier::Off, None);
        environment.lifecycle = SandboxLifecycleKind::Persistent;
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        let data = tempfile::tempdir().unwrap();
        remote.backend.configure_publish_recovery(data.path());
        for count in 1..=2 {
            changed_workspace(&remote.fake);
            if count == 2 {
                remote
                    .fake
                    .answer_git("rev-parse", vec![answer(&"b".repeat(40), 0)]);
            }
            remote
                .spawn(remote_config("reused-agent", &environment))
                .await
                .unwrap();
            remote.exit_session();
            remote
                .until("a durable completed session", |_| {
                    let records = DeliveryStore::new(data.path())
                        .list(Some("reused-agent"), None)
                        .unwrap();
                    records.len() == count
                        && records.iter().all(|record| {
                            record.publish_state == crate::delivery::PublishState::Pushed
                        })
                })
                .await;
        }
        let records = DeliveryStore::new(data.path()).list(None, None).unwrap();
        assert_ne!(records[0].id, records[1].id);
        let placements = remote.events(PLACEMENT_CHANNEL);
        assert_ne!(
            placements[0]["placement"]["deliveryRecordId"],
            placements[1]["placement"]["deliveryRecordId"]
        );
        assert!(placements.iter().all(|event| records
            .iter()
            .any(|record| event["placement"]["deliveryRecordId"] == record.id)));
        assert!(records.iter().all(|r| r.commit.as_deref()
            == Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
            && r.cleanup_state == CleanupState::Retained));
        let journal = data.path().join(crate::delivery::DELIVERY_DIR);
        std::fs::rename(&journal, data.path().join("saved-journal")).unwrap();
        std::fs::write(&journal, "cleanup journal unavailable").unwrap();
        tokio::time::advance(Duration::from_secs(601)).await;
        remote.backend.sweep_remote_instances().await;
        assert!(remote
            .fake
            .removed
            .lock()
            .contains(&"instance-1".to_string()));
        assert_eq!(
            remote.backend.remote.as_ref().unwrap().snapshot(),
            (1, 0),
            "cleanup journal failure stays tracked for retry"
        );
        std::fs::remove_file(&journal).unwrap();
        std::fs::rename(data.path().join("saved-journal"), &journal).unwrap();
        tokio::time::advance(DESTROY_RETRY_BASE + Duration::from_secs(1)).await;
        remote.backend.sweep_remote_instances().await;
        let records = DeliveryStore::new(data.path()).list(None, None).unwrap();
        assert!(records
            .iter()
            .all(|r| r.cleanup_state == CleanupState::Destroyed && r.revision >= 2));
        assert!(remote
            .events(WORKSPACE_PUBLISH_CHANNEL)
            .iter()
            .filter(|e| e["publish"].get("deliveryRecordError").is_none())
            .all(|e| e["publish"]["deliveryRecord"].is_object()));
    }

    #[tokio::test(start_paused = true)]
    async fn durable_held_deadline_and_destroy_retries_are_recorded() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        let data = tempfile::tempdir().unwrap();
        remote.backend.configure_publish_recovery(data.path());
        std::fs::write(data.path().join(RECOVERY_DIR), "cannot export").unwrap();
        changed_workspace(&remote.fake);
        remote.fake.answer_git("push", vec![answer("refused", 128)]);
        *remote.fake.remove_failures.lock() = 1;
        remote
            .spawn(remote_config("agent-1", &environment))
            .await
            .unwrap();
        remote.exit_session();
        remote
            .until("a durable held delivery", |_| {
                DeliveryStore::new(data.path()).list(None, None).unwrap()[0].publish_state
                    == crate::delivery::PublishState::Held
            })
            .await;
        tokio::time::advance(Duration::from_secs(3601)).await;
        remote.backend.sweep_remote_instances().await;
        remote
            .until("a durable destroy retry", |_| {
                DeliveryStore::new(data.path()).list(None, None).unwrap()[0].cleanup_state
                    == CleanupState::DestroyRetrying
            })
            .await;
        let record = DeliveryStore::new(data.path())
            .list(None, None)
            .unwrap()
            .remove(0);
        assert_eq!(
            record.publish_state,
            crate::delivery::PublishState::Discarded
        );
        tokio::time::advance(DESTROY_RETRY_BASE + Duration::from_secs(1)).await;
        remote.backend.sweep_remote_instances().await;
        assert_eq!(
            DeliveryStore::new(data.path()).list(None, None).unwrap()[0].cleanup_state,
            CleanupState::Destroyed
        );
    }

    #[tokio::test(start_paused = true)]
    async fn restart_reconciles_orphan_delivery_and_retries_refused_cleanup() {
        let environment = spec(EgressTier::Off, None);
        let fake = FakeRemote::new("fake");
        let remote = Remote::new(fake.clone(), environment.clone(), 1);
        let data = tempfile::tempdir().unwrap();
        remote.backend.configure_publish_recovery(data.path());
        std::fs::write(data.path().join(RECOVERY_DIR), "cannot export").unwrap();
        changed_workspace(&fake);
        fake.answer_git("push", vec![answer("refused", 128)]);
        remote
            .spawn(remote_config("agent-1", &environment))
            .await
            .unwrap();
        remote.exit_session();
        remote
            .until("a held delivery", |_| {
                DeliveryStore::new(data.path()).list(None, None).unwrap()[0].publish_state
                    == crate::delivery::PublishState::Held
            })
            .await;
        drop(remote);
        *fake.remove_failures.lock() = 1;
        let restarted = Remote::new(fake, environment, 1);
        restarted.backend.configure_publish_recovery(data.path());
        let record = DeliveryStore::new(data.path())
            .list(None, None)
            .unwrap()
            .remove(0);
        let path = data
            .path()
            .join(crate::delivery::DELIVERY_DIR)
            .join(format!("{}.json", record.id));
        let original = std::fs::read(&path).unwrap();
        std::fs::write(&path, "corrupt").unwrap();
        restarted.backend.reap_orphans().await.unwrap();
        assert!(
            restarted.fake.removed.lock().is_empty(),
            "unreadable history does not authorize destructive reconciliation"
        );
        assert_eq!(*restarted.fake.remove_failures.lock(), 1);
        std::fs::write(&path, original).unwrap();
        restarted.backend.reap_orphans().await.unwrap();
        assert_eq!(
            DeliveryStore::new(data.path()).list(None, None).unwrap()[0].cleanup_state,
            CleanupState::DestroyRetrying
        );
        tokio::time::advance(DESTROY_RETRY_BASE + Duration::from_secs(1)).await;
        restarted.backend.sweep_remote_instances().await;
        let record = DeliveryStore::new(data.path())
            .list(None, None)
            .unwrap()
            .remove(0);
        assert_eq!(record.cleanup_state, CleanupState::Destroyed);
        assert_eq!(
            record.publish_state,
            crate::delivery::PublishState::Discarded
        );
    }

    #[tokio::test(start_paused = true)]
    async fn recovered_persistent_hold_is_kept_past_idle_and_delivered_by_next_session() {
        let mut environment = spec(EgressTier::Off, None);
        environment.lifecycle = SandboxLifecycleKind::Persistent;
        let fake = FakeRemote::new("fake");
        let remote = Remote::new(fake.clone(), environment.clone(), 1);
        let data = tempfile::tempdir().unwrap();
        remote.backend.configure_publish_recovery(data.path());
        std::fs::write(data.path().join(RECOVERY_DIR), "cannot export").unwrap();
        changed_workspace(&fake);
        fake.answer_git("push", vec![answer("refused", 128)]);
        remote
            .spawn(remote_config("old-agent", &environment))
            .await
            .unwrap();
        remote.exit_session();
        remote
            .until("a durable hold", |_| {
                DeliveryStore::new(data.path()).list(None, None).unwrap()[0].publish_state
                    == crate::delivery::PublishState::Held
            })
            .await;
        drop(remote);
        let restarted = Remote::new(fake.clone(), environment.clone(), 1);
        restarted.backend.configure_publish_recovery(data.path());
        restarted.backend.reap_orphans().await.unwrap();
        tokio::time::advance(Duration::from_secs(601)).await;
        restarted.backend.sweep_remote_instances().await;
        restarted
            .until("the failed retry to settle", |remote| {
                !remote.backend.remote.as_ref().unwrap().instances.lock()["instance-1"]
                    .held
                    .as_ref()
                    .unwrap()
                    .in_flight
            })
            .await;
        assert!(
            fake.removed.lock().is_empty(),
            "recovered hold outlives the idle limit"
        );
        fake.answer_git("push", vec![answer("", 0)]);
        fake.answer_git("rev-parse", vec![answer(&"b".repeat(40), 0)]);
        restarted
            .spawn(remote_config("new-agent", &environment))
            .await
            .unwrap();
        restarted.exit_session();
        restarted
            .until("both historical sessions to be delivered", |_| {
                let records = DeliveryStore::new(data.path()).list(None, None).unwrap();
                records.len() == 2
                    && records
                        .iter()
                        .all(|record| record.publish_state == crate::delivery::PublishState::Pushed)
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn journal_write_failure_is_reported_instead_of_claiming_durability() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        let data = tempfile::tempdir().unwrap();
        remote.backend.configure_publish_recovery(data.path());
        changed_workspace(&remote.fake);
        remote
            .spawn(remote_config("agent-1", &environment))
            .await
            .unwrap();
        let journal = data.path().join(crate::delivery::DELIVERY_DIR);
        std::fs::rename(&journal, data.path().join("old-journal")).unwrap();
        std::fs::write(&journal, "disk unavailable").unwrap();
        remote.exit_session();
        remote
            .until("the journal failure report", |remote| {
                !remote.events(WORKSPACE_PUBLISH_CHANNEL).is_empty()
            })
            .await;
        let event = &remote.events(WORKSPACE_PUBLISH_CHANNEL)[0]["publish"];
        assert_eq!(
            event["deliveryRecordError"]["code"],
            "sandbox_delivery_store_failed"
        );
        assert!(event.get("deliveryRecord").is_none());
        assert_eq!(
            event["deliveryRecordId"],
            remote.events(PLACEMENT_CHANNEL)[0]["placement"]["deliveryRecordId"]
        );
        assert_eq!(event["pushed"], true);
        assert!(
            remote.fake.removed.lock().is_empty(),
            "known outcome is journaled before cleanup"
        );
        std::fs::remove_file(&journal).unwrap();
        std::fs::rename(data.path().join("old-journal"), &journal).unwrap();
        tokio::time::advance(DESTROY_RETRY_BASE + Duration::from_secs(1)).await;
        remote.backend.sweep_remote_instances().await;
        let record = DeliveryStore::new(data.path())
            .list(None, None)
            .unwrap()
            .remove(0);
        assert_eq!(record.publish_state, crate::delivery::PublishState::Pushed);
        assert_eq!(record.cleanup_state, CleanupState::Destroyed);
    }

    #[tokio::test]
    async fn a_failed_bundle_leaves_no_partial_file_and_holds_the_instance() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        let data = tempfile::tempdir().unwrap();
        remote.backend.configure_publish_recovery(data.path());
        changed_workspace(&remote.fake);
        remote.fake.answer_git("push", vec![answer("", 1)]);
        remote.fake.answer_git("rev-list", vec![answer("1\n", 0)]);
        remote.fake.answer_git("bundle", vec![answer("partial", 128)]);
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the publish report", |remote| {
                !remote.events(WORKSPACE_PUBLISH_CHANNEL).is_empty()
            })
            .await;
        let publish = &remote.events(WORKSPACE_PUBLISH_CHANNEL)[0]["publish"];
        assert_eq!(publish["held"], true);
        assert_eq!(publish["recovery"]["code"], "sandbox_workspace_recovery_failed");
        assert!(recovery_files(data.path()).is_empty(), "no partial bundle is left behind");
        assert!(remote.fake.removed.lock().is_empty());
        remote.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn changes_that_could_not_be_committed_are_not_nothing_to_preserve() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        let data = tempfile::tempdir().unwrap();
        remote.backend.configure_publish_recovery(data.path());
        // The commit fails, so the tree stays dirty and nothing is ahead of
        // the remote: a bundle would hold none of the agent's work.
        remote.fake.answer_git("status", vec![answer(" M src/main.rs\n", 0)]);
        remote.fake.answer_git("commit", vec![answer("fatal: unable to write index", 128)]);
        remote.fake.answer_git("rev-list", vec![answer("0\n", 0)]);
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the publish report", |remote| {
                !remote.events(WORKSPACE_PUBLISH_CHANNEL).is_empty()
            })
            .await;
        let publish = &remote.events(WORKSPACE_PUBLISH_CHANNEL)[0]["publish"];
        assert_eq!(publish["code"], "sandbox_workspace_publish_failed");
        assert_eq!(publish["recovery"]["code"], "sandbox_workspace_recovery_failed");
        assert_eq!(publish["held"], true);
        assert!(remote.fake.removed.lock().is_empty(), "uncommitted work is not destroyed");
        remote.backend.kill_all().await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_that_reuses_a_held_workspace_delivers_the_earlier_work_too() {
        let mut environment = spec(EgressTier::Off, None);
        environment.lifecycle = SandboxLifecycleKind::Persistent;
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 2);
        changed_workspace(&remote.fake);
        remote
            .fake
            .answer_git("push", vec![answer("unable to access", 128), answer("", 0)]);
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the first publish report", |remote| {
                !remote.events(WORKSPACE_PUBLISH_CHANNEL).is_empty()
            })
            .await;
        assert_eq!(remote.events(WORKSPACE_PUBLISH_CHANNEL)[0]["publish"]["held"], true);

        remote.spawn(remote_config("agent-2", &environment)).await.unwrap();
        assert_eq!(remote.fake.provisions.lock().len(), 1, "the held workspace is reused");
        // No retry runs under the new session, even past the retry interval.
        tokio::time::advance(PUBLISH_RETRY_INTERVAL * 2).await;
        remote.backend.sweep_remote_instances().await;
        let pushes = || {
            remote
                .fake
                .git_calls()
                .iter()
                .filter(|call| call.contains(&"push".to_string()))
                .count()
        };
        assert_eq!(pushes(), 1);

        remote.exit_session();
        remote
            .until("both sessions to hear of the push", |remote| {
                remote.events(WORKSPACE_PUBLISH_CHANNEL).len() == 3
            })
            .await;
        let events = remote.events(WORKSPACE_PUBLISH_CHANNEL);
        let mut delivered: Vec<&str> = events[1..]
            .iter()
            .map(|event| {
                assert_eq!(event["publish"]["pushed"], true);
                event["agentId"].as_str().unwrap()
            })
            .collect();
        delivered.sort();
        assert_eq!(delivered, vec!["agent-1", "agent-2"]);
        assert!(remote.backend.remote.as_ref().unwrap().instances.lock()["instance-1"]
            .held
            .is_none());
        remote.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn work_already_on_the_remote_needs_no_bundle() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        let data = tempfile::tempdir().unwrap();
        remote.backend.configure_publish_recovery(data.path());
        changed_workspace(&remote.fake);
        remote.fake.answer_git("push", vec![answer("", 1)]);
        remote.fake.answer_git("rev-list", vec![answer("0\n", 0)]);
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the instance to be released", |remote| {
                remote.fake.removed.lock().contains(&"instance-1".to_string())
            })
            .await;
        let publish = &remote.events(WORKSPACE_PUBLISH_CHANNEL)[0]["publish"];
        assert_eq!(publish["recovery"]["code"], "nothing_to_preserve");
        assert!(recovery_files(data.path()).is_empty());
        assert!(!remote
            .fake
            .git_calls()
            .iter()
            .any(|call| call.contains(&"bundle".to_string())));
    }

    #[tokio::test(start_paused = true)]
    async fn undelivered_work_holds_the_instance_until_a_retry_pushes_it() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        changed_workspace(&remote.fake);
        // No recovery directory: the work exists only on the instance.
        remote
            .fake
            .answer_git("push", vec![answer("unable to access", 128), answer("", 0)]);
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the first publish report", |remote| {
                !remote.events(WORKSPACE_PUBLISH_CHANNEL).is_empty()
            })
            .await;
        let first = &remote.events(WORKSPACE_PUBLISH_CHANNEL)[0]["publish"];
        assert_eq!(first["pushed"], false);
        assert_eq!(first["held"], true);
        assert_eq!(first["recovery"]["code"], "sandbox_workspace_recovery_unavailable");
        assert!(remote.fake.removed.lock().is_empty(), "the only copy is not destroyed");

        tokio::time::advance(PUBLISH_RETRY_INTERVAL + Duration::from_secs(1)).await;
        remote.backend.sweep_remote_instances().await;
        remote
            .until("the retried push and the release", |remote| {
                remote.events(WORKSPACE_PUBLISH_CHANNEL).len() == 2
                    && remote.fake.removed.lock().contains(&"instance-1".to_string())
            })
            .await;
        let second = &remote.events(WORKSPACE_PUBLISH_CHANNEL)[1]["publish"];
        assert_eq!(second["pushed"], true);
        assert_eq!(second["commit"], "b".repeat(40));
        assert_eq!(remote.backend.remote.as_ref().unwrap().snapshot(), (0, 0));
    }

    #[tokio::test(start_paused = true)]
    async fn held_work_still_undelivered_at_the_deadline_is_reported_discarded() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        changed_workspace(&remote.fake);
        remote.fake.answer_git("push", vec![answer("unable to access", 128)]);
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the first publish report", |remote| {
                !remote.events(WORKSPACE_PUBLISH_CHANNEL).is_empty()
            })
            .await;
        tokio::time::advance(Duration::from_secs(3601)).await;
        remote.backend.sweep_remote_instances().await;
        remote
            .until("the instance to be destroyed", |remote| {
                remote.fake.removed.lock().contains(&"instance-1".to_string())
            })
            .await;
        let events = remote.events(WORKSPACE_PUBLISH_CHANNEL);
        assert_eq!(events.len(), 2, "a failed retry is silent; the discard is not");
        assert_eq!(events[1]["publish"]["discarded"], true);
        assert_eq!(events[1]["publish"]["pushed"], false);
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_destroy_keeps_the_slot_and_is_retried() {
        let environment = spec(EgressTier::Off, None);
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        *remote.fake.remove_failures.lock() = 2;
        remote.spawn(remote_config("agent-1", &environment)).await.unwrap();
        remote.exit_session();
        remote
            .until("the first destroy attempt", |remote| *remote.fake.remove_failures.lock() == 1)
            .await;
        let parts = remote.backend.remote.as_ref().unwrap();
        assert_eq!(parts.snapshot(), (1, 0), "still tracked: it may still be billed");
        assert_eq!(parts.slots.available_permits(), 0, "its slot stays taken");
        assert!(remote.fake.instances.lock().contains_key("instance-1"));

        tokio::time::advance(DESTROY_RETRY_BASE + Duration::from_secs(1)).await;
        remote.backend.sweep_remote_instances().await;
        remote
            .until("the second attempt", |remote| *remote.fake.remove_failures.lock() == 0)
            .await;
        assert_eq!(parts.snapshot(), (1, 0));
        let retry = parts.instances.lock()["instance-1"]
            .destroy_retry
            .as_ref()
            .map(|retry| retry.attempts);
        assert_eq!(retry, Some(2));

        tokio::time::advance(DESTROY_RETRY_BASE * 2 + Duration::from_secs(1)).await;
        remote.backend.sweep_remote_instances().await;
        remote
            .until("the instance to be destroyed", |remote| {
                remote.fake.removed.lock().contains(&"instance-1".to_string())
            })
            .await;
        assert_eq!(parts.snapshot(), (0, 0));
        assert_eq!(parts.slots.available_permits(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_workspace_whose_instance_is_still_being_removed_is_not_reused() {
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
        *remote.fake.remove_failures.lock() = 2;
        tokio::time::advance(Duration::from_secs(601)).await;
        remote.backend.sweep_remote_instances().await;
        remote
            .until("the idle destroy to be refused", |remote| {
                *remote.fake.remove_failures.lock() == 1
            })
            .await;

        let error = remote
            .spawn(remote_config("agent-2", &environment))
            .await
            .expect_err("an instance being removed is not handed out");
        assert_eq!(error.code, "sandbox_persistent_runtime_failed");
        assert_eq!(remote.fake.provisions.lock().len(), 1, "nor duplicated");

        remote.spawn(remote_config("agent-3", &environment)).await.unwrap();
        assert!(remote.fake.removed.lock().contains(&"instance-1".to_string()));
        assert_eq!(remote.fake.provisions.lock().len(), 2);
        remote.backend.kill_all().await.unwrap();
    }

    #[test]
    fn destroy_retries_back_off_to_a_ceiling() {
        let delay = |attempts| {
            DestroyRetry::after(attempts)
                .next_at
                .saturating_duration_since(tokio::time::Instant::now())
                .as_secs()
        };
        assert!((14..=15).contains(&delay(1)));
        assert!((29..=30).contains(&delay(2)));
        assert!((59..=60).contains(&delay(3)));
        assert!((599..=600).contains(&delay(40)));
    }

    #[test]
    fn recovery_file_names_keep_only_safe_characters() {
        assert_eq!(file_component("agent/../1"), "agent____1");
        assert_eq!(file_component(""), "agent");
        assert_eq!(file_component(&"x".repeat(100)).len(), 64);
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

    #[test]
    fn remote_allowlist_runtime_config_defaults_to_no_local_bridge() {
        let mut environment = spec(EgressTier::Allowlist, None);
        environment.egress.approved_domains = vec!["registry.npmjs.org".into()];
        for spawn in [BTreeMap::new(), BTreeMap::from([("TASK_FLAG".into(), "1".into())])] {
            let runtime = runtime_config_with_env(&environment, spawn).unwrap();
            assert!(runtime.egress.is_none());
            let encoded = encode_runtime_config_env(&runtime).unwrap();
            assert!(super::super::tests::decode_agent_environment(&encoded).egress.is_none());
        }
        assert!(super::super::tests::decode_agent_environment(&git_runtime_env().unwrap()).egress.is_none());
        let provider = FakeRemote::new("fake");
        assert!(provider.egress_enforced(EgressTier::Allowlist));
    }

    /// Run: `cargo test --offline -p cognia-sandbox-pool provider_allowlist_never_waits_for_a_local_egress_bridge -- --ignored`.
    #[tokio::test]
    #[ignore = "requires local socket binding for the remote git proxy"]
    async fn provider_allowlist_never_waits_for_a_local_egress_bridge() {
        let mut environment = spec(EgressTier::Allowlist, None);
        environment.egress.approved_domains = vec!["registry.npmjs.org".into()];
        let remote = Remote::new(FakeRemote::new("fake"), environment.clone(), 1);
        remote.spawn(mandatory(remote_config("provider-allowlist", &environment))).await.unwrap();
        let request = remote.fake.provisions.lock()[0].clone();
        assert_eq!(request.egress.tier, EgressTier::Allowlist);
        assert_eq!(request.egress.domains, vec!["registry.npmjs.org"]);
        assert!(super::super::tests::decode_agent_environment(&request.supervisor_env).egress.is_none());
        for exec in remote.fake.execs.lock().iter() {
            assert!(!exec.command.iter().any(|arg| arg == "bridge-egress" || arg == "--require-egress-v1"));
            if exec.env.iter().any(|entry| entry.starts_with("COGNIA_SANDBOXD_RUNTIME_CONFIG_")) {
                assert!(super::super::tests::decode_agent_environment(&exec.env).egress.is_none());
            }
        }
        remote.backend.kill_all().await.unwrap();
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
