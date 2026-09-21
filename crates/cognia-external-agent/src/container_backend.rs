//! `ExecBackend::Container` — per-agent runner containers (ADR-0059 R13, T2).
//!
//! Each `spawn_external_agent` becomes ONE runner container: the agent binary
//! is the container's PID 1, its workspace is the only piece of the
//! `cognia_workspaces` volume it can see, and `kill` maps to `docker kill`.
//! ACP rides the container's attached stdio (`Tty:false`, so the daemon
//! multiplexes stdout/stderr and bollard demuxes into `LogOutput` frames) —
//! transparent to the TS `acp-client`, exactly like a local process.
//!
//! The backend never talks to the raw Docker socket in the T2 topology: the
//! compose override points `DOCKER_HOST` at a tecnativa socket-proxy that
//! allows only container lifecycle + images (see
//! `deploy/compose/docker-compose.t2.yml`).
//!
//! Layering (Windows-testable ≥90% without a daemon):
//!
//! - [`ContainerApi`] — the daemon primitives this backend needs (run /
//!   pull / kill / remove), modeled as channels.
//!   [`test_support::FakeContainerApi`] scripts them in-memory; the bollard
//!   implementation lives behind the `container-exec` cargo feature so
//!   desktop builds never compile the Docker client. A missing runner image
//!   is pulled once and the spawn retried (first spawn on a fresh daemon).
//! - [`ContainerBackend`] — the [`ExecBackend`] state machine (registry,
//!   line-buffering, event choreography). Feature-free, unit-tested here.
//! - A real-daemon integration test runs only under `COGNIA_TEST_DOCKER=1`
//!   (WSL2 / CI with Docker).

// Without the feature only `exec_backend_from_env` is reachable from the
// (private) module graph — everything else is exercised by tests and the
// feature-gated bollard impl.
#![cfg_attr(not(any(test, feature = "container-exec")), allow(dead_code))]

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::exec_backend::ExecBackend;
use super::process::{ExternalAgentEventSink, ExternalAgentProcessState, ExternalAgentSpawnConfig};

// ---------------------------------------------------------------------------
// Environment contract (docker-compose.t2.yml is the canonical consumer)
// ---------------------------------------------------------------------------

/// `local-process` (default) | `container`.
pub const EXEC_BACKEND_ENV: &str = "COGNIA_EXEC_BACKEND";
/// Runner image, e.g. `ghcr.io/maxqian888/cognia-runner:latest`. Required in
/// container mode.
pub const RUNNER_IMAGE_ENV: &str = "COGNIA_RUNNER_IMAGE";
/// Workspace root as seen by cognia-server (`/workspaces` in compose).
pub const WORKSPACES_DIR_ENV: &str = "COGNIA_WORKSPACES_DIR";
/// Named volume backing the workspace root. When set, runners get a
/// volume+subpath mount of ONLY their workspace; when unset, the workspace
/// path is bind-mounted (bare-metal self-host).
pub const WORKSPACES_VOLUME_ENV: &str = "COGNIA_WORKSPACES_VOLUME";
/// Path to a seccomp profile JSON applied to every runner (optional).
pub const RUNNER_SECCOMP_ENV: &str = "COGNIA_RUNNER_SECCOMP";
/// Per-runner memory ceiling in MiB (default 2048).
pub const RUNNER_MEMORY_MB_ENV: &str = "COGNIA_RUNNER_MEMORY_MB";
/// Per-runner CPU budget in whole/fractional CPUs (default 2).
pub const RUNNER_CPUS_ENV: &str = "COGNIA_RUNNER_CPUS";
/// Per-runner pids ceiling (default 512).
pub const RUNNER_PIDS_ENV: &str = "COGNIA_RUNNER_PIDS";
/// Docker network mode for runners (default `bridge`).
pub const RUNNER_NETWORK_ENV: &str = "COGNIA_RUNNER_NETWORK";
/// Stable identity of THIS deployment (one server plus one data volume) on
/// the shared daemon. Optional: `cognia-server` derives a persisted default
/// from its data directory, so the variable only matters when an operator
/// wants a readable name (the compose suite passes `${COGNIA_INSTANCE}`).
///
/// Why it exists: several deployments can share one Docker daemon or one
/// Kubernetes namespace. Ownership alone (`cognia.owner`) says "a Cognia made
/// this". It cannot say WHICH, so an orphan sweep at boot used to remove the
/// live runners of every other deployment on the same daemon.
pub const DEPLOYMENT_ID_ENV: &str = "COGNIA_DEPLOYMENT_ID";

/// Where the agent's workspace lands inside the runner.
pub const WORKSPACE_TARGET: &str = "/workspace";

#[derive(Clone, Debug)]
pub struct ContainerBackendConfig {
    pub image: String,
    pub workspaces_dir: PathBuf,
    pub workspaces_volume: Option<String>,
    /// Full profile JSON (file already read), passed as `seccomp=<json>`.
    pub seccomp_json: Option<String>,
    pub memory_bytes: i64,
    pub nano_cpus: i64,
    pub pids_limit: i64,
    pub network_mode: String,
    /// Stamped as [`DEPLOYMENT_LABEL`] on every runner. The orphan sweep only
    /// ever removes containers carrying this exact value.
    pub deployment_id: String,
}

/// Validate a deployment id for use as a container or pod label value: 1 to
/// 63 characters from `[A-Za-z0-9_.-]`. Kubernetes label values are the
/// tighter of the two targets, and a value the pod path would have to
/// sanitize could collide with another deployment's after sanitizing.
pub fn validate_deployment_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 63 {
        return Err("deployment id must contain 1 to 63 characters".into());
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err(format!(
            "deployment id {value:?} may only contain letters, digits, '_', '.' and '-'"
        ));
    }
    Ok(value.to_string())
}

impl ContainerBackendConfig {
    /// Resolve from the environment. Fails loudly on a missing image or an
    /// unreadable seccomp profile — a silently-degraded T2 boot is the bug.
    ///
    /// `default_deployment_id` is what the caller derived for this data
    /// volume. [`DEPLOYMENT_ID_ENV`] overrides it when set.
    pub fn from_env(default_deployment_id: &str) -> Result<Self, String> {
        let deployment_id = deployment_id_from_env(default_deployment_id)?;
        let image = std::env::var(RUNNER_IMAGE_ENV)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| format!("{RUNNER_IMAGE_ENV} is required in container exec mode"))?;
        let host = RunnerHostSettings::from_env()?;
        Ok(Self {
            image,
            workspaces_dir: host.workspaces_dir,
            workspaces_volume: host.workspaces_volume,
            seccomp_json: host.seccomp_json,
            memory_bytes: host.memory_bytes,
            nano_cpus: host.nano_cpus,
            pids_limit: host.pids_limit,
            network_mode: host.network_mode,
            deployment_id,
        })
    }
}

/// [`DEPLOYMENT_ID_ENV`] when set, else the caller's derived default.
pub fn deployment_id_from_env(default_deployment_id: &str) -> Result<String, String> {
    match std::env::var(DEPLOYMENT_ID_ENV) {
        Ok(value) if !value.trim().is_empty() => validate_deployment_id(&value)
            .map_err(|error| format!("invalid {DEPLOYMENT_ID_ENV}: {error}")),
        _ => validate_deployment_id(default_deployment_id)
            .map_err(|error| format!("invalid default deployment id: {error}")),
    }
}

/// How this host lays workspaces and limits out for any container it runs:
/// the legacy runner and a runtime environment sandbox read the same
/// variables, so the two can never disagree about where a workspace is.
#[derive(Clone, Debug)]
pub struct RunnerHostSettings {
    pub workspaces_dir: PathBuf,
    pub workspaces_volume: Option<String>,
    pub seccomp_json: Option<String>,
    pub memory_bytes: i64,
    pub nano_cpus: i64,
    pub pids_limit: i64,
    pub network_mode: String,
}

impl RunnerHostSettings {
    pub fn from_env() -> Result<Self, String> {
        let workspaces_dir = std::env::var(WORKSPACES_DIR_ENV)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| format!("{WORKSPACES_DIR_ENV} is required in container exec mode"))?;
        let workspaces_volume = std::env::var(WORKSPACES_VOLUME_ENV)
            .ok()
            .filter(|v| !v.trim().is_empty());
        let seccomp_json = match std::env::var(RUNNER_SECCOMP_ENV) {
            Ok(path) if !path.trim().is_empty() => Some(
                std::fs::read_to_string(&path)
                    .map_err(|e| format!("cannot read {RUNNER_SECCOMP_ENV} ({path}): {e}"))?,
            ),
            _ => None,
        };
        let memory_mb: i64 = parse_env_number(RUNNER_MEMORY_MB_ENV, 2048)?;
        let cpus: f64 = match std::env::var(RUNNER_CPUS_ENV) {
            Ok(v) if !v.trim().is_empty() => v
                .trim()
                .parse()
                .map_err(|e| format!("invalid {RUNNER_CPUS_ENV}: {e}"))?,
            _ => 2.0,
        };
        let pids: i64 = parse_env_number(RUNNER_PIDS_ENV, 512)?;
        let network_mode =
            std::env::var(RUNNER_NETWORK_ENV).unwrap_or_else(|_| "bridge".to_string());
        Ok(Self {
            workspaces_dir,
            workspaces_volume,
            seccomp_json,
            memory_bytes: memory_mb.saturating_mul(1024 * 1024),
            nano_cpus: (cpus * 1_000_000_000f64) as i64,
            pids_limit: pids,
            network_mode,
        })
    }

    /// Where the workspace at `cwd` comes from. In volume mode the cwd must
    /// live under the workspace root (the SpawnPolicy already canonicalizes;
    /// this is defense in depth for direct callers).
    pub fn resolve_mount(&self, cwd: &str) -> Result<RunnerMount, String> {
        resolve_workspace_mount(&self.workspaces_dir, self.workspaces_volume.as_deref(), cwd)
    }
}

fn resolve_workspace_mount(
    workspaces_dir: &Path,
    workspaces_volume: Option<&str>,
    cwd: &str,
) -> Result<RunnerMount, String> {
    match workspaces_volume {
        Some(volume) => {
            let rel = Path::new(cwd).strip_prefix(workspaces_dir).map_err(|_| {
                format!(
                    "cwd {cwd} is outside the workspace root {}",
                    workspaces_dir.display()
                )
            })?;
            let subpath = rel
                .to_string_lossy()
                .replace('\\', "/")
                .trim_matches('/')
                .to_string();
            Ok(RunnerMount::Volume {
                volume: volume.to_string(),
                subpath: if subpath.is_empty() {
                    None
                } else {
                    Some(subpath)
                },
            })
        }
        None => Ok(RunnerMount::Bind {
            host_dir: cwd.to_string(),
        }),
    }
}

fn parse_env_number(key: &str, default: i64) -> Result<i64, String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => {
            v.trim().parse().map_err(|e| format!("invalid {key}: {e}"))
        }
        _ => Ok(default),
    }
}

// ---------------------------------------------------------------------------
// ContainerApi — the daemon seam
// ---------------------------------------------------------------------------

/// How the workspace reaches the runner.
#[derive(Clone, Debug, PartialEq)]
pub enum RunnerMount {
    /// Named-volume subpath (compose/k8s): the runner sees ONLY its own
    /// workspace even though every workspace shares one volume.
    Volume {
        volume: String,
        subpath: Option<String>,
    },
    /// Host-dir bind (bare-metal self-host).
    Bind { host_dir: String },
}

/// Label key marking a container as ours. Present on every container this
/// backend creates, and required before it will touch one.
pub const OWNER_LABEL: &str = "cognia.owner";

/// The value [`OWNER_LABEL`] carries. A different value is someone else's.
pub const OWNER_VALUE: &str = "cognia-external-agent";

/// Label carrying the agent id the container was created for.
pub const AGENT_ID_LABEL: &str = "cognia.agent-id";

/// Label carrying the id of the PROCESS that created the container, so a
/// restart can tell its own live containers from the previous run's orphans.
pub const INSTANCE_LABEL: &str = "cognia.instance";

/// Label carrying the deployment (server + data volume) the container
/// belongs to. Unlike [`INSTANCE_LABEL`] it survives a restart, so it is what
/// separates "my previous run's orphan" from "another deployment's live
/// runner" on a shared daemon or namespace.
pub const DEPLOYMENT_LABEL: &str = "cognia.deployment";

/// Label carrying the label schema version, so a future change can recognise
/// and migrate containers created by an older build.
pub const SCHEMA_LABEL: &str = "cognia.schema-version";

/// Current value of [`SCHEMA_LABEL`].
pub const SCHEMA_VERSION: &str = "1";

/// A named volume mounted somewhere other than the workspace: the injected
/// agent bundle of a runtime environment sandbox (ADR-0183).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeMount {
    pub volume: String,
    pub target: String,
    pub read_only: bool,
}

/// Everything the daemon needs to run one agent container.
#[derive(Clone, Debug)]
pub struct RunnerSpec {
    pub name: String,
    pub image: String,
    pub cmd: Vec<String>,
    /// `KEY=VALUE`, sorted for determinism.
    pub env: Vec<String>,
    pub working_dir: String,
    /// The workspace at [`WORKSPACE_TARGET`]. Every agent runner has one; only
    /// the bundle staging containers of a sandbox run without.
    pub mount: Option<RunnerMount>,
    pub seccomp_json: Option<String>,
    pub memory_bytes: i64,
    pub nano_cpus: i64,
    pub pids_limit: i64,
    pub network_mode: String,
    /// Ownership labels, sorted for determinism. The container itself carries
    /// them, which is the whole point: a name convention lives only in this
    /// process, and dies with it.
    pub labels: BTreeMap<String, String>,
    // The fields below are runtime environment sandboxes only (ADR-0183). A
    // legacy runner leaves every one empty, and the daemon request it builds
    // is exactly what it was before they existed.
    /// Replaces the image's `ENTRYPOINT` (`cognia-sandboxd` in a user image).
    pub entrypoint: Option<Vec<String>>,
    /// The container user; `0` so `init-agent` can switch to the declared one.
    pub user: Option<String>,
    pub extra_mounts: Vec<VolumeMount>,
    /// An OCI runtime registered with the daemon (`runsc` for gVisor).
    pub runtime: Option<String>,
    // Isolation bounds below apply to every runner, not only sandboxes: a
    // container that can escape its bounds is root on the host's daemon.
    /// `HostConfig.CapDrop` entries. `["ALL"]` is the hardened answer; an
    /// empty list keeps the daemon's default bounding set.
    pub cap_drop: Vec<String>,
    /// `HostConfig.CapAdd` entries, re-granted after `cap_drop`.
    pub cap_add: Vec<String>,
    /// `HostConfig.ReadonlyRootfs`. The writable surface then comes only from
    /// `mount`, `extra_mounts`, `tmpfs` and `writable_dirs`.
    pub read_only_rootfs: bool,
    /// `HostConfig.Tmpfs` mounts, each `path` or `path:opts` verbatim.
    pub tmpfs: Vec<String>,
    /// `Config.Volumes` entries — anonymous volumes. Unlike tmpfs an
    /// anonymous volume is seeded with the image's content at that path,
    /// which is what a populated agent home needs under a read-only rootfs.
    pub writable_dirs: Vec<String>,
}

/// Demuxed output of a running container (Tty:false framing).
#[derive(Debug)]
pub enum RunnerEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    /// Terminal — the sender closes after this.
    Exited {
        code: Option<i64>,
    },
}

/// Runtime exec streams use bounded queues so a slow ACP client or port
/// consumer exerts backpressure all the way to the Docker attach stream.
/// Legacy/container adapters retain their existing channel implementation.
pub enum RunnerEvents {
    Unbounded(mpsc::UnboundedReceiver<RunnerEvent>),
    Bounded(mpsc::Receiver<RunnerEvent>),
}
impl RunnerEvents {
    pub async fn recv(&mut self) -> Option<RunnerEvent> {
        match self {
            Self::Unbounded(rx) => rx.recv().await,
            Self::Bounded(rx) => rx.recv().await,
        }
    }
}
impl From<mpsc::UnboundedReceiver<RunnerEvent>> for RunnerEvents {
    fn from(rx: mpsc::UnboundedReceiver<RunnerEvent>) -> Self {
        Self::Unbounded(rx)
    }
}
impl From<mpsc::Receiver<RunnerEvent>> for RunnerEvents {
    fn from(rx: mpsc::Receiver<RunnerEvent>) -> Self {
        Self::Bounded(rx)
    }
}
#[derive(Clone)]
pub enum RunnerStdin {
    Unbounded(mpsc::UnboundedSender<Vec<u8>>),
    Bounded(mpsc::Sender<Vec<u8>>),
}
impl RunnerStdin {
    pub async fn send(&self, bytes: Vec<u8>) -> Result<(), String> {
        match self {
            Self::Unbounded(tx) => tx.send(bytes).map_err(|_| "runner stdin closed".into()),
            Self::Bounded(tx) => tx
                .send(bytes)
                .await
                .map_err(|_| "runner stdin closed".into()),
        }
    }
}
impl From<mpsc::UnboundedSender<Vec<u8>>> for RunnerStdin {
    fn from(tx: mpsc::UnboundedSender<Vec<u8>>) -> Self {
        Self::Unbounded(tx)
    }
}
impl From<mpsc::Sender<Vec<u8>>> for RunnerStdin {
    fn from(tx: mpsc::Sender<Vec<u8>>) -> Self {
        Self::Bounded(tx)
    }
}

/// A started container with attached stdio.
pub struct RunningRunner {
    pub container_id: String,
    pub events: RunnerEvents,
    pub stdin: RunnerStdin,
}

/// Complete a daemon create even if its caller disappears. The acknowledgement
/// closes the gap where a oneshot send succeeds but the receiver is then dropped
/// before it takes ownership of the runner. No ambiguous create is replayed.
#[cfg(any(test, feature = "container-exec"))]
async fn handoff_started_runner(
    api: Arc<dyn ContainerApi>,
    start: impl std::future::Future<Output = Result<RunningRunner, RunnerRunError>> + Send + 'static,
) -> Result<RunningRunner, RunnerRunError> {
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let running = match start.await {
            Ok(running) => running,
            Err(error) => {
                let _ = result_tx.send(Err(error));
                return;
            }
        };
        let container_id = running.container_id.clone();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let _ = result_tx.send(Ok((running, accepted_tx)));
        if accepted_rx.await.is_err() {
            if let Err(error) = remove_owned(&api, &container_id).await {
                log::warn!("cancelled creation cleanup {container_id} failed: {error}");
            }
        }
    });
    let (running, accepted) = result_rx.await.map_err(|error| {
        RunnerRunError::Other(format!("container creation worker failed: {error}"))
    })??;
    let _ = accepted.send(());
    Ok(running)
}

/// Why a runner failed to start — the backend retries exactly one case.
#[derive(Debug)]
pub enum RunnerRunError {
    /// The runner image is absent on the daemon. First spawn on a fresh
    /// host hits this: nothing in the compose suite runs the runner image
    /// as a service, so nothing ever pulled it.
    ImageMissing(String),
    Other(String),
}

impl RunnerRunError {
    pub fn into_message(self) -> String {
        match self {
            Self::ImageMissing(msg) | Self::Other(msg) => msg,
        }
    }
}

/// The daemon primitives the backend needs. Implemented by bollard
/// (feature `container-exec`) and by the in-memory fake (tests).
#[async_trait]
pub trait ContainerApi: Send + Sync + 'static {
    /// Create + attach (before start, so no output is lost) + start.
    async fn run(&self, spec: RunnerSpec) -> Result<RunningRunner, RunnerRunError>;
    /// Pull `image` from its registry (`/images/create`); resolves when the
    /// pull stream completes. The T2 socket proxy allows this (IMAGES+POST).
    async fn pull_image(&self, image: &str) -> Result<(), String>;
    async fn kill(&self, container_id: &str) -> Result<(), String>;
    /// Best-effort cleanup; idempotent.
    async fn remove(&self, container_id: &str) -> Result<(), String>;
    /// Labels on one container. `Ok(None)` when the container is gone.
    ///
    /// This is what makes ownership checkable at all: without it the only
    /// evidence a container is ours is a name convention plus an in-process
    /// map, and a name convention is something anyone can type.
    async fn labels(&self, container_id: &str) -> Result<Option<BTreeMap<String, String>>, String>;
    /// Ids of every container carrying our owner label, running or not.
    /// Used to reap what a previous process left behind.
    async fn list_owned(&self) -> Result<Vec<OwnedContainer>, String>;
}

/// Registry credentials for one pull, in the shape the daemon's
/// `X-Registry-Auth` header takes. Never logged and never stored here: the
/// Host reads them from `COGNIA_REGISTRY_AUTH_FILE` for each pull.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct RegistryAuth {
    pub server_address: String,
    pub username: Option<String>,
    pub password: Option<String>,
    /// An OAuth2 refresh token the daemon exchanges itself.
    pub identity_token: Option<String>,
    /// A bearer token used as-is.
    pub registry_token: Option<String>,
}

impl std::fmt::Debug for RegistryAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let set = |value: &Option<String>| value.as_ref().map(|_| "<set>");
        f.debug_struct("RegistryAuth")
            .field("server_address", &self.server_address)
            .field("username", &self.username)
            .field("password", &set(&self.password))
            .field("identity_token", &set(&self.identity_token))
            .field("registry_token", &set(&self.registry_token))
            .finish()
    }
}

/// A named volume carrying our owner label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnedVolume {
    pub name: String,
    pub labels: BTreeMap<String, String>,
}

/// What removing a volume did. A volume a container still mounts is not an
/// error: it is the reference count saying "not yet".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VolumeRemoval {
    Removed,
    InUse,
    Gone,
}

/// The extra daemon primitives the runtime environment driver needs on top of
/// [`ContainerApi`] (ADR-0183 "Injection"): named volumes for the staged
/// bundle, the registered OCI runtimes (to attest the gVisor tier) and pulls
/// with registry credentials. Docker only — a Kubernetes sandbox is the pool
/// of ADR-0184, not a runner pod.
#[async_trait]
pub trait SandboxDockerApi: ContainerApi {
    /// Persistent runtime operations. A driver lacking these capabilities
    /// refuses persistent placement; it cannot silently run an ephemeral job.
    async fn inspect_runtime(&self, _id: &str) -> Result<Option<RuntimeContainerState>, String> {
        Err("persistent runtime inspection is unavailable".into())
    }
    async fn start_runtime(&self, _id: &str) -> Result<(), String> {
        Err("persistent runtime start is unavailable".into())
    }
    async fn stop_runtime(&self, _id: &str) -> Result<(), String> {
        Err("persistent runtime stop is unavailable".into())
    }
    async fn exec_runtime(&self, _spec: RunnerExecSpec) -> Result<RunningRunner, String> {
        Err("persistent runtime exec is unavailable".into())
    }

    /// Runtime names from `/info` (`runc`, `runsc`, …).
    async fn runtimes(&self) -> Result<Vec<String>, String>;
    /// Create the volume if it does not exist. Idempotent.
    async fn ensure_volume(
        &self,
        name: &str,
        labels: &BTreeMap<String, String>,
    ) -> Result<(), String>;
    async fn list_owned_volumes(&self) -> Result<Vec<OwnedVolume>, String>;
    async fn remove_volume(&self, name: &str) -> Result<VolumeRemoval, String>;
    async fn pull_image_with_auth(
        &self,
        image: &str,
        auth: Option<RegistryAuth>,
    ) -> Result<(), String>;
}

/// Retained workspace runtime, reconciled by the sandbox pool after restart.
pub const PERSISTENT_RUNTIME_LABEL: &str = "cognia.persistent-runtime";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeContainerState {
    pub running: bool,
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct RunnerExecSpec {
    pub container_id: String,
    pub command: Vec<String>,
    pub env: Vec<String>,
    pub working_dir: String,
}

/// One container the daemon reports as ours.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnedContainer {
    pub id: String,
    pub labels: BTreeMap<String, String>,
}

impl OwnedContainer {
    /// The process that created it, if it said.
    pub fn instance(&self) -> Option<&str> {
        self.labels.get(INSTANCE_LABEL).map(String::as_str)
    }

    /// The deployment that created it, if it said. Containers from builds
    /// before the label existed answer `None` and are never reaped.
    pub fn deployment(&self) -> Option<&str> {
        self.labels.get(DEPLOYMENT_LABEL).map(String::as_str)
    }
}

/// A process/time identity plus a sequence: multiple backend instances may
/// initialize within the same host clock tick, including on parallel threads.
pub fn default_instance_id() -> String {
    static NEXT_INSTANCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let sequence = NEXT_INSTANCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{pid}-{nanos}-{sequence}")
}

/// Labels for a container this process is about to create.
pub fn ownership_labels(
    agent_id: &str,
    instance_id: &str,
    deployment_id: &str,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        (OWNER_LABEL.to_string(), OWNER_VALUE.to_string()),
        (AGENT_ID_LABEL.to_string(), agent_id.to_string()),
        (INSTANCE_LABEL.to_string(), instance_id.to_string()),
        (DEPLOYMENT_LABEL.to_string(), deployment_id.to_string()),
        (SCHEMA_LABEL.to_string(), SCHEMA_VERSION.to_string()),
    ])
}

/// Whether a label set marks a container as ours to act on.
pub fn is_owned(labels: &BTreeMap<String, String>) -> bool {
    labels.get(OWNER_LABEL).map(String::as_str) == Some(OWNER_VALUE)
}

/// Refuse to act on a container we cannot prove is ours.
///
/// `Ok(false)` means the container is already gone — nothing to protect, and
/// every caller treats removal as idempotent. An `Err` means it exists and
/// belongs to someone else.
///
/// The old evidence was a name (`cognia-agent-<id>`) plus an in-process map.
/// Both are forgeable and neither survives a crash, so a container a user
/// happened to name that way could be killed, and our own containers became
/// invisible the moment the process died.
///
/// A free function, not a method, because the spawned stdout reader owns only
/// an `Arc<dyn ContainerApi>` — and that reader is the one place a recycled
/// container id would do damage.
pub async fn assert_owned(api: &Arc<dyn ContainerApi>, container_id: &str) -> Result<bool, String> {
    match api.labels(container_id).await? {
        None => Ok(false),
        Some(labels) if is_owned(&labels) => Ok(true),
        Some(_) => Err(format!(
            "refusing to touch container {container_id}: it does not carry {OWNER_LABEL}={OWNER_VALUE}"
        )),
    }
}

/// Remove a container after proving we own it. Idempotent.
pub async fn remove_owned(api: &Arc<dyn ContainerApi>, container_id: &str) -> Result<(), String> {
    if assert_owned(api, container_id).await? {
        api.remove(container_id).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// ContainerBackend — the ExecBackend state machine
// ---------------------------------------------------------------------------

struct AgentEntry {
    container_id: String,
    /// Persistent sessions can reuse a container id; identity belongs to an
    /// adoption, not the shared container or reusable external agent id.
    generation: Arc<()>,
    cleanup_api: Arc<dyn ContainerApi>,
    state: ExternalAgentProcessState,
    stdin: RunnerStdin,
    config: ExternalAgentSpawnConfig,
    exit_code: Option<i64>,
    exit_notified: bool,
    /// What a runtime environment sandbox reported about where the agent
    /// runs (ADR-0183); absent for a legacy runner.
    placement: Option<Value>,
}

/// The agents running in containers of one backend: stdio, line buffering,
/// state and the exit choreography. Shared by the legacy runner backend and
/// the runtime environment sandbox driver, which differ only in how the
/// container is built — so an agent looks the same to the UI whichever ran it.
#[derive(Clone)]
pub struct RunnerRegistry {
    api: Arc<dyn ContainerApi>,
    agents: Arc<Mutex<HashMap<String, AgentEntry>>>,
    pending: Arc<Mutex<HashMap<String, Arc<tokio::sync::watch::Sender<bool>>>>>,
}

/// Reserves an agent id through preparation and creation. Dropping a cancelled
/// or failed spawn releases the id; kill requests wake the preparation future.
pub struct RunnerReservation {
    id: String,
    pending: Arc<Mutex<HashMap<String, Arc<tokio::sync::watch::Sender<bool>>>>>,
    token: Arc<tokio::sync::watch::Sender<bool>>,
    cancelled: tokio::sync::watch::Receiver<bool>,
}

impl RunnerReservation {
    /// Observe cancellation while an owned operation keeps the reservation
    /// alive through daemon completion and cleanup.
    pub fn cancellation(&self) -> tokio::sync::watch::Receiver<bool> {
        self.cancelled.clone()
    }

    pub async fn cancelled(&self) {
        let mut cancellation = self.cancellation();
        let _ = cancellation.wait_for(|cancelled| *cancelled).await;
    }

    pub fn cancel(&self) {
        self.token.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }
}

impl Drop for RunnerReservation {
    fn drop(&mut self) {
        let mut pending = self.pending.lock();
        if pending
            .get(&self.id)
            .is_some_and(|token| Arc::ptr_eq(token, &self.token))
        {
            pending.remove(&self.id);
        }
    }
}

struct CancelCreationOnDrop {
    token: Arc<tokio::sync::watch::Sender<bool>>,
    armed: bool,
}

impl Drop for CancelCreationOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.token.send_replace(true);
        }
    }
}

impl RunnerRegistry {
    pub fn new(api: Arc<dyn ContainerApi>) -> Self {
        Self {
            api,
            agents: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.pending.lock().contains_key(id) || self.agents.lock().contains_key(id)
    }

    pub fn reserve(&self, id: &str) -> Result<RunnerReservation, String> {
        let mut pending = self.pending.lock();
        if pending.contains_key(id) || self.agents.lock().contains_key(id) {
            return Err(format!("Agent {id} already exists"));
        }
        let (sender, cancelled) = tokio::sync::watch::channel(false);
        let token = Arc::new(sender);
        pending.insert(id.to_string(), Arc::clone(&token));
        Ok(RunnerReservation {
            id: id.to_string(),
            pending: Arc::clone(&self.pending),
            token,
            cancelled,
        })
    }

    /// Take over a started container: register it and pump its output to
    /// `sink` until it exits, then forget it and remove the container.
    pub fn adopt(
        &self,
        config: ExternalAgentSpawnConfig,
        running: RunningRunner,
        placement: Option<Value>,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> String {
        self.adopt_scoped(config, running, placement, sink, Arc::clone(&self.api))
    }

    /// Adopt an exec session whose cleanup affects only that session. The
    /// reported container id remains the real workspace container identity.
    pub fn adopt_scoped(
        &self,
        config: ExternalAgentSpawnConfig,
        running: RunningRunner,
        placement: Option<Value>,
        sink: Arc<dyn ExternalAgentEventSink>,
        cleanup_api: Arc<dyn ContainerApi>,
    ) -> String {
        let id = config.id.clone();
        let container_id = running.container_id.clone();
        let generation = Arc::new(());
        let mut pending = self.pending.lock();
        self.agents.lock().insert(
            id.clone(),
            AgentEntry {
                container_id: container_id.clone(),
                generation: Arc::clone(&generation),
                cleanup_api: Arc::clone(&cleanup_api),
                state: ExternalAgentProcessState::Starting,
                stdin: running.stdin,
                config,
                exit_code: None,
                exit_notified: false,
                placement,
            },
        );
        let cancelled = pending
            .remove(&id)
            .is_some_and(|cancelled| *cancelled.borrow());
        drop(pending);

        // Reader: demuxed chunks → line events → sink; Exited → choreography
        // parity with the local supervisor (Stopped + exit via the sink, then
        // the registry forgets the id and the container is removed).
        let agents = Arc::clone(&self.agents);
        let api = cleanup_api;
        let agent_id = id.clone();
        let mut events = running.events;
        tokio::spawn(async move {
            // A kill arriving between create completing and this synchronous
            // handoff must still stop the container it targeted.
            if cancelled {
                if let Err(error) = api.kill(&container_id).await {
                    log::warn!("cancelled runner {container_id} kill failed: {error}");
                    let _ = remove_owned(&api, &container_id).await;
                }
            }
            let mut out_buf = LineBuffer::new();
            let mut err_buf = LineBuffer::new();
            let mut exit_code: Option<i64> = None;
            while let Some(event) = events.recv().await {
                match event {
                    RunnerEvent::Stdout(chunk) => {
                        for line in out_buf.push(&chunk) {
                            sink.stdout_line(&agent_id, &line);
                        }
                    }
                    RunnerEvent::Stderr(chunk) => {
                        for line in err_buf.push(&chunk) {
                            sink.stderr_line(&agent_id, &line);
                        }
                    }
                    RunnerEvent::Exited { code } => {
                        exit_code = code;
                        break;
                    }
                }
            }
            if let Some(line) = out_buf.flush() {
                sink.stdout_line(&agent_id, &line);
            }
            if let Some(line) = err_buf.flush() {
                sink.stderr_line(&agent_id, &line);
            }
            let current = {
                let mut map = agents.lock();
                if map
                    .get(&agent_id)
                    .is_some_and(|entry| Arc::ptr_eq(&entry.generation, &generation))
                {
                    if let Some(entry) = map.get_mut(&agent_id) {
                        entry.state = ExternalAgentProcessState::Stopped;
                        entry.exit_code = exit_code;
                    }
                    true
                } else {
                    false
                }
            };
            if current {
                sink.exited(&agent_id, exit_code.map(|c| c as i32), None);
                let mut map = agents.lock();
                if let Some(entry) = map.get_mut(&agent_id) {
                    if Arc::ptr_eq(&entry.generation, &generation) {
                        entry.exit_notified = true;
                    }
                }
            }
            // Always clean up this collector's container, never a new runner
            // that reused its agent id while the old stream was draining.
            // Keep the id occupied through both its exit event and daemon
            // deletion: a stopped container still reserves its Docker name.
            match remove_owned(&api, &container_id).await {
                Ok(()) => {
                    let mut map = agents.lock();
                    if map
                        .get(&agent_id)
                        .is_some_and(|entry| Arc::ptr_eq(&entry.generation, &generation))
                    {
                        map.remove(&agent_id);
                    }
                }
                Err(error) => {
                    // Retain Stopped so kill/kill_all can retry cleanup. A
                    // failed DELETE must not make the occupied name reusable.
                    log::warn!("runner cleanup {container_id} failed: {error}");
                }
            }
        });

        id
    }

    pub async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let stdin = {
            let map = self.agents.lock();
            let entry = map.get(id).ok_or(format!("Agent {id} not found"))?;
            entry.stdin.clone()
        };
        let mut bytes = message.as_bytes().to_vec();
        bytes.push(b'\n');
        stdin
            .send(bytes)
            .await
            .map_err(|_| format!("Agent {id} stdin is closed"))
    }

    pub async fn kill(&self, id: &str) -> Result<(), String> {
        {
            let pending = self.pending.lock();
            if let Some(cancelled) = pending.get(id) {
                cancelled.send_replace(true);
                return Ok(());
            }
        }
        let (container_id, stopped, previous_state, api, generation) = {
            let mut map = self.agents.lock();
            let entry = map.get_mut(id).ok_or(format!("Agent {id} not found"))?;
            let stopped = entry.state == ExternalAgentProcessState::Stopped;
            if stopped && !entry.exit_notified {
                // The collector is delivering this generation's exit. It
                // owns cleanup until delivery completes; releasing the id
                // here would let that old event stop a replacement runner.
                return Ok(());
            }
            let previous_state = entry.state.clone();
            if !stopped {
                entry.state = ExternalAgentProcessState::Stopping;
            }
            (
                entry.container_id.clone(),
                stopped,
                previous_state,
                Arc::clone(&entry.cleanup_api),
                Arc::clone(&entry.generation),
            )
        };
        if stopped {
            remove_owned(&api, &container_id).await?;
            let mut map = self.agents.lock();
            if map
                .get(id)
                .is_some_and(|entry| Arc::ptr_eq(&entry.generation, &generation))
            {
                map.remove(id);
            }
            return Ok(());
        }
        // Prove it is ours before signalling it. A recycled container id in
        // our map would otherwise send a kill to whatever now holds that id.
        let result = async {
            if !assert_owned(&api, &container_id).await? {
                return Ok(());
            }
            // The attached-stream reader owns exit delivery and cleanup.
            api.kill(&container_id).await
        }
        .await;
        if result.is_err() {
            let mut map = self.agents.lock();
            if let Some(entry) = map.get_mut(id) {
                if Arc::ptr_eq(&entry.generation, &generation)
                    && entry.state == ExternalAgentProcessState::Stopping
                {
                    entry.state = previous_state;
                }
            }
        }
        result
    }

    pub async fn kill_all(&self) -> Result<(), String> {
        let ids = self.list();
        let mut errors = Vec::new();
        for id in ids {
            if let Err(e) = self.kill(&id).await {
                errors.push(format!("{id}: {e}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        let pending = self.pending.lock();
        self.agents
            .lock()
            .get(id)
            .map(|e| e.state.clone())
            .or_else(|| {
                pending.get(id).map(|cancelled| {
                    if *cancelled.borrow() {
                        ExternalAgentProcessState::Stopping
                    } else {
                        ExternalAgentProcessState::Starting
                    }
                })
            })
    }

    pub fn list(&self) -> Vec<String> {
        let pending = self.pending.lock();
        let mut ids: Vec<_> = pending
            .keys()
            .chain(self.agents.lock().keys())
            .cloned()
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    pub fn is_running(&self, id: &str) -> Result<bool, String> {
        if self.pending.lock().contains_key(id) {
            return Ok(false);
        }
        self.agents
            .lock()
            .get(id)
            .map(|e| e.state == ExternalAgentProcessState::Running)
            .ok_or(format!("Agent {id} not found"))
    }

    pub fn get_info(&self, id: &str) -> Result<Value, String> {
        let map = self.agents.lock();
        let entry = map.get(id).ok_or(format!("Agent {id} not found"))?;
        // Same shape as the local process manager, plus the container id
        // (`pid` has no meaning across the daemon boundary).
        let mut info = json!({
            "id": entry.config.id,
            "pid": null,
            "state": entry.state,
            "command": entry.config.command,
            "args": entry.config.args,
            "cwd": entry.config.cwd,
            "env": entry.config.env,
            "exitCode": entry.exit_code,
            "exitSignal": null,
            "containerId": entry.container_id,
        });
        if let Some(placement) = &entry.placement {
            info["placement"] = placement.clone();
        }
        Ok(info)
    }

    pub fn set_state(&self, id: &str, state: ExternalAgentProcessState) -> Result<(), String> {
        let mut map = self.agents.lock();
        let entry = map.get_mut(id).ok_or(format!("Agent {id} not found"))?;
        entry.state = state;
        Ok(())
    }
}

/// Remove every container of `deployment_id` a process other than
/// `instance_id` left behind. See [`ContainerBackend::reap_orphans`].
pub async fn reap_owned_orphans(
    api: &Arc<dyn ContainerApi>,
    instance_id: &str,
    deployment_id: &str,
) -> Result<Vec<String>, String> {
    let owned = api.list_owned().await?;
    let mut reaped = Vec::new();
    for container in owned {
        if container.instance() == Some(instance_id)
            || container
                .labels
                .get(PERSISTENT_RUNTIME_LABEL)
                .map(String::as_str)
                == Some("1")
        {
            continue;
        }
        if !is_owned(&container.labels) {
            continue;
        }
        if container.deployment() != Some(deployment_id) {
            log::debug!(
                "orphan sweep: leaving container {} alone (deployment {:?}, ours is {:?})",
                container.id,
                container.deployment(),
                deployment_id
            );
            continue;
        }
        match api.remove(&container.id).await {
            Ok(()) => reaped.push(container.id),
            // One stuck container must not stop the sweep.
            Err(_) => continue,
        }
    }
    Ok(reaped)
}

pub struct ContainerBackend {
    api: Arc<dyn ContainerApi>,
    config: ContainerBackendConfig,
    runners: RunnerRegistry,
    /// Identifies THIS process on every container it creates. A container
    /// labelled with a different instance belongs to a run that is gone.
    instance_id: String,
}

impl ContainerBackend {
    pub fn new(api: Arc<dyn ContainerApi>, config: ContainerBackendConfig) -> Arc<Self> {
        Self::with_instance_id(api, config, default_instance_id())
    }

    /// Construct with an explicit instance id (tests, and any caller that
    /// wants a stable id across a restart).
    pub fn with_instance_id(
        api: Arc<dyn ContainerApi>,
        config: ContainerBackendConfig,
        instance_id: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            runners: RunnerRegistry::new(Arc::clone(&api)),
            api,
            config,
            instance_id,
        })
    }

    /// This process's instance id, as stamped on every container it creates.
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    /// Remove every container of OURS that a previous process left running.
    ///
    /// This is the half a name convention cannot do. `process_registry`
    /// already treats orphan daemons as the failure mode it exists to
    /// prevent; before ownership labels there was no way to enumerate our
    /// containers from the daemon at all, so a crash leaked every one of
    /// them silently.
    ///
    /// Returns the ids reaped. Containers from THIS process are left alone,
    /// and so is everything outside THIS deployment: another server sharing
    /// the daemon owns its runners just as legitimately, and a container
    /// with no deployment label predates the label. Its owner is unknown, so
    /// it is left for the operator rather than guessed at.
    pub async fn reap_orphans(&self) -> Result<Vec<String>, String> {
        reap_owned_orphans(&self.api, &self.instance_id, &self.config.deployment_id).await
    }

    /// Resolve the workspace mount for `cwd`. In volume mode the cwd must
    /// live under the workspace root (the SpawnPolicy already canonicalizes;
    /// this is defense in depth for direct callers).
    fn resolve_mount(&self, cwd: &str) -> Result<RunnerMount, String> {
        resolve_workspace_mount(
            &self.config.workspaces_dir,
            self.config.workspaces_volume.as_deref(),
            cwd,
        )
    }
}

pub fn sanitize_container_name(agent_id: &str) -> String {
    let safe: String = agent_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("cognia-agent-{safe}")
}

/// Byte-chunk → line splitter mirroring the local reader's semantics
/// (`\n`-terminated, trailing `\r` trimmed, lossy UTF-8).
struct LineBuffer(Vec<u8>);

impl LineBuffer {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.0.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.0.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.0.drain(..=pos).collect();
            line.pop(); // the \n
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        lines
    }

    fn flush(&mut self) -> Option<String> {
        if self.0.is_empty() {
            return None;
        }
        let line = String::from_utf8_lossy(&self.0).into_owned();
        self.0.clear();
        Some(line)
    }
}

#[async_trait]
impl ExecBackend for ContainerBackend {
    async fn spawn(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, String> {
        let id = config.id.clone();
        let reservation = self.runners.reserve(&id)?;
        let cwd = config
            .cwd
            .clone()
            .ok_or_else(|| "container exec mode requires a workspace cwd".to_string())?;
        let mount = self.resolve_mount(&cwd)?;

        let mut env: Vec<String> = config.env.iter().map(|(k, v)| format!("{k}={v}")).collect();
        env.sort();

        let mut cmd = Vec::with_capacity(config.args.len() + 1);
        cmd.push(config.command.clone());
        cmd.extend(config.args.iter().cloned());

        let spec = RunnerSpec {
            name: sanitize_container_name(&id),
            image: self.config.image.clone(),
            cmd,
            env,
            working_dir: WORKSPACE_TARGET.to_string(),
            mount: Some(mount),
            seccomp_json: self.config.seccomp_json.clone(),
            memory_bytes: self.config.memory_bytes,
            nano_cpus: self.config.nano_cpus,
            pids_limit: self.config.pids_limit,
            network_mode: self.config.network_mode.clone(),
            labels: ownership_labels(&id, &self.instance_id, &self.config.deployment_id),
            entrypoint: None,
            user: None,
            extra_mounts: Vec::new(),
            runtime: None,
            // An agent CLI needs no Linux capability; the runner's writable
            // surface is its workspace and the image's own home, so the
            // rootfs stays writable here (the pool's sandbox tier is the one
            // that can bound its writable surface precisely).
            cap_drop: vec!["ALL".to_string()],
            cap_add: Vec::new(),
            read_only_rootfs: false,
            tmpfs: Vec::new(),
            writable_dirs: Vec::new(),
        };

        let api = Arc::clone(&self.api);
        let runners = self.runners.clone();
        let mut cancellation = reservation.cancelled.clone();
        let mut cancel_on_drop = CancelCreationOnDrop {
            token: Arc::clone(&reservation.token),
            armed: true,
        };
        let (result_tx, result_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            // The reservation lives in the worker, so cancel/abort can return
            // immediately without making a still-creating id reusable.
            let _reservation = reservation;
            let create = async {
                let running = match api.run(spec.clone()).await {
                    Ok(running) => running,
                    Err(RunnerRunError::ImageMissing(_)) => {
                        if result_tx.is_closed() || _reservation.is_cancelled() {
                            return Err(format!("Agent {} creation cancelled", config.id));
                        }
                        // Pull once, retry once. A second miss (or a pull failure)
                        // is terminal — no loop, no backoff: spawn latency is user-
                        // visible and the caller can retry.
                        api.pull_image(&spec.image).await?;
                        if result_tx.is_closed() || _reservation.is_cancelled() {
                            return Err(format!("Agent {} creation cancelled", config.id));
                        }
                        api.run(spec).await.map_err(RunnerRunError::into_message)?
                    }
                    Err(err) => return Err(err.into_message()),
                };
                Ok::<_, String>(running)
            };
            let running = match create.await {
                Ok(running) => running,
                Err(error) => {
                    let _ = result_tx.send(Err(error));
                    return;
                }
            };
            let container_id = running.container_id.clone();
            if result_tx.is_closed() || _reservation.is_cancelled() {
                if let Err(error) = remove_owned(&api, &container_id).await {
                    log::warn!("cancelled runner creation {container_id} cleanup failed: {error}");
                }
                let _ = result_tx.send(Err(format!("Agent {} creation cancelled", config.id)));
                return;
            }
            let id = runners.adopt(config, running, None, sink);
            let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
            let _ = result_tx.send(Ok((id, accepted_tx)));
            if accepted_rx.await.is_err() {
                if let Err(error) = remove_owned(&api, &container_id).await {
                    log::warn!("unaccepted runner {container_id} cleanup failed: {error}");
                }
            }
        });
        let (id, accepted) = tokio::select! {
            biased;
            _ = cancellation.wait_for(|cancelled| *cancelled) => return Err(format!("Agent {id} creation cancelled")),
            result = result_rx => result.map_err(|error| format!("Agent {id} creation worker failed: {error}"))??,
        };
        cancel_on_drop.armed = false;
        let _ = accepted.send(());
        Ok(id)
    }

    async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        self.runners.send(id, message).await
    }

    async fn kill(&self, id: &str) -> Result<(), String> {
        self.runners.kill(id).await
    }

    async fn kill_all(&self) -> Result<(), String> {
        self.runners.kill_all().await
    }

    async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        self.runners.status(id)
    }

    async fn list(&self) -> Vec<String> {
        self.runners.list()
    }

    async fn is_running(&self, id: &str) -> Result<bool, String> {
        self.runners.is_running(id)
    }

    async fn get_info(&self, id: &str) -> Result<Value, String> {
        self.runners.get_info(id)
    }

    async fn set_running(&self, id: &str) -> Result<(), String> {
        self.runners
            .set_state(id, ExternalAgentProcessState::Running)
    }

    async fn set_failed(&self, id: &str) -> Result<(), String> {
        self.runners
            .set_state(id, ExternalAgentProcessState::Failed)
    }

    fn kind(&self) -> &'static str {
        "container"
    }

    async fn reap_orphans(&self) -> Result<Vec<String>, String> {
        ContainerBackend::reap_orphans(self).await
    }
}

// ---------------------------------------------------------------------------
// Backend selection (boot seam for cognia-server)
// ---------------------------------------------------------------------------

/// Resolve the exec backend from `COGNIA_EXEC_BACKEND`. `container` requires
/// the `container-exec` build feature AND a reachable daemon config;
/// `kubernetes` requires `k8s-exec` + in-cluster config — a T2/T3 deployment
/// that cannot spawn runners must fail at boot, not degrade into running dev
/// agents inside the server container.
///
/// `default_deployment_id` scopes the orphan sweep and every runner label to
/// the calling deployment (see [`DEPLOYMENT_ID_ENV`]); the local-process
/// backend has no daemon to share and ignores it.
pub fn exec_backend_from_env(default_deployment_id: &str) -> Result<Arc<dyn ExecBackend>, String> {
    // Only the container flavors consume it. A desktop build compiles neither.
    let _ = default_deployment_id;
    let legacy: Arc<dyn ExecBackend> = match std::env::var(EXEC_BACKEND_ENV).ok().as_deref() {
        Some("container") => {
            #[cfg(feature = "container-exec")]
            {
                let config = ContainerBackendConfig::from_env(default_deployment_id)?;
                let api = bollard_api::BollardContainerApi::connect()?;
                Ok::<Arc<dyn ExecBackend>, String>(ContainerBackend::new(api, config))
            }
            #[cfg(not(feature = "container-exec"))]
            {
                Err(format!(
                    "{EXEC_BACKEND_ENV}=container but this binary was built without the `container-exec` feature"
                ))
            }
        }
        Some("kubernetes") => {
            #[cfg(feature = "k8s-exec")]
            {
                let config = ContainerBackendConfig::from_env(default_deployment_id)?;
                if config.workspaces_volume.is_none() {
                    return Err(format!(
                        "{WORKSPACES_VOLUME_ENV} must name the workspaces PVC in kubernetes exec mode"
                    ));
                }
                let api = super::kube_backend::kube_api::KubeContainerApi::connect()?;
                Ok::<Arc<dyn ExecBackend>, String>(ContainerBackend::new(api, config))
            }
            #[cfg(not(feature = "k8s-exec"))]
            {
                Err(format!(
                    "{EXEC_BACKEND_ENV}=kubernetes but this binary was built without the `k8s-exec` feature"
                ))
            }
        }
        None | Some("") | Some("local-process") => {
            Ok::<Arc<dyn ExecBackend>, String>(super::exec_backend::LocalProcessBackend::new())
        }
        Some(other) => Err(format!("unknown {EXEC_BACKEND_ENV} value: {other}")),
    }?;
    super::workspace_runtime_backend::wrap_with_workspace_runtime_from_env(legacy)
}

// ---------------------------------------------------------------------------
// Bollard implementation (feature `container-exec`)
// ---------------------------------------------------------------------------

#[cfg(feature = "container-exec")]
pub mod bollard_api {
    use super::*;
    use bollard::container::LogOutput;
    use bollard::models::{ContainerCreateBody, HostConfig, Mount, MountType, MountVolumeOptions};
    use bollard::query_parameters::{
        AttachContainerOptionsBuilder, CreateContainerOptionsBuilder, CreateImageOptionsBuilder,
        KillContainerOptionsBuilder, ListContainersOptionsBuilder, ListVolumesOptionsBuilder,
        RemoveContainerOptionsBuilder, StartContainerOptions, WaitContainerOptionsBuilder,
    };
    use bollard::Docker;
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    pub struct BollardContainerApi {
        docker: Docker,
    }

    const CREATE_ATTEMPT_LABEL: &str = "cognia.create-attempt";

    fn stamp_create_attempt(mut spec: RunnerSpec) -> RunnerSpec {
        static NEXT_ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = NEXT_ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        spec.labels.insert(
            CREATE_ATTEMPT_LABEL.into(),
            format!("{}-{sequence}", default_instance_id()),
        );
        spec
    }

    fn matches_create_attempt(
        spec: &RunnerSpec,
        labels: &std::collections::HashMap<String, String>,
    ) -> bool {
        spec.labels.contains_key(CREATE_ATTEMPT_LABEL)
            && spec
                .labels
                .get(OWNER_LABEL)
                .is_some_and(|owner| owner == OWNER_VALUE)
            && spec
                .labels
                .iter()
                .all(|(key, value)| labels.get(key) == Some(value))
    }

    impl BollardContainerApi {
        /// One `/containers/json` query, `all: true` so a stopped orphan is
        /// still visible — a container that exited but was never removed is
        /// exactly the thing that needs reaping.
        async fn summaries(
            &self,
            filters: std::collections::HashMap<String, Vec<String>>,
        ) -> Result<Vec<bollard::models::ContainerSummary>, String> {
            let options = ListContainersOptionsBuilder::default()
                .all(true)
                .filters(&filters)
                .build();
            self.docker
                .list_containers(Some(options))
                .await
                .map_err(|e| format!("list_containers failed: {e}"))
        }

        /// Honors `DOCKER_HOST` (tcp → the T2 socket proxy); falls back to
        /// the platform-local socket/pipe.
        pub fn connect() -> Result<Arc<Self>, String> {
            let docker = match std::env::var("DOCKER_HOST") {
                Ok(host) if host.starts_with("tcp://") || host.starts_with("http://") => {
                    Docker::connect_with_http_defaults()
                }
                _ => Docker::connect_with_local_defaults(),
            }
            .map_err(|e| format!("docker connect failed: {e}"))?;
            Ok(Arc::new(Self { docker }))
        }
    }

    fn to_mount(mount: &RunnerMount) -> Mount {
        match mount {
            RunnerMount::Volume { volume, subpath } => Mount {
                typ: Some(MountType::VOLUME),
                source: Some(volume.clone()),
                target: Some(WORKSPACE_TARGET.to_string()),
                volume_options: Some(MountVolumeOptions {
                    subpath: subpath.clone(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            RunnerMount::Bind { host_dir } => Mount {
                typ: Some(MountType::BIND),
                source: Some(host_dir.clone()),
                target: Some(WORKSPACE_TARGET.to_string()),
                ..Default::default()
            },
        }
    }

    fn to_volume_mount(mount: &VolumeMount) -> Mount {
        Mount {
            typ: Some(MountType::VOLUME),
            source: Some(mount.volume.clone()),
            target: Some(mount.target.clone()),
            read_only: Some(mount.read_only),
            ..Default::default()
        }
    }

    /// The daemon's mounts for a spec: the workspace first, then the rest.
    pub(super) fn mounts_for(spec: &RunnerSpec) -> Vec<Mount> {
        spec.mount
            .iter()
            .map(to_mount)
            .chain(spec.extra_mounts.iter().map(to_volume_mount))
            .collect()
    }

    /// `spec.tmpfs` rendered as `HostConfig.Tmpfs`: `path` or `path:opts`.
    fn tmpfs_for(spec: &RunnerSpec) -> Option<std::collections::HashMap<String, String>> {
        if spec.tmpfs.is_empty() {
            return None;
        }
        Some(
            spec.tmpfs
                .iter()
                .map(|entry| {
                    let (path, opts) = entry.split_once(':').unwrap_or((entry.as_str(), ""));
                    (path.to_string(), opts.to_string())
                })
                .collect(),
        )
    }

    /// The `POST /containers/create` body for a spec, pure so the hardened
    /// defaults are testable without a daemon.
    pub(super) fn create_body_for(spec: &RunnerSpec) -> ContainerCreateBody {
        let mut security_opt = vec!["no-new-privileges:true".to_string()];
        if let Some(json) = &spec.seccomp_json {
            security_opt.push(format!("seccomp={json}"));
        }
        ContainerCreateBody {
            image: Some(spec.image.clone()),
            entrypoint: spec.entrypoint.clone(),
            cmd: Some(spec.cmd.clone()),
            env: Some(spec.env.clone()),
            user: spec.user.clone(),
            working_dir: Some(spec.working_dir.clone()),
            // Ownership travels ON the container. Everything else about
            // "is this ours" lived in this process and died with it.
            labels: Some(
                spec.labels
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ),
            attach_stdin: Some(true),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            open_stdin: Some(true),
            stdin_once: Some(false),
            tty: Some(false),
            volumes: (!spec.writable_dirs.is_empty()).then(|| spec.writable_dirs.clone()),
            host_config: Some(HostConfig {
                mounts: Some(mounts_for(spec)),
                security_opt: Some(security_opt),
                memory: Some(spec.memory_bytes),
                nano_cpus: Some(spec.nano_cpus),
                pids_limit: Some(spec.pids_limit),
                network_mode: Some(spec.network_mode.clone()),
                runtime: spec.runtime.clone(),
                cap_drop: (!spec.cap_drop.is_empty()).then(|| spec.cap_drop.clone()),
                cap_add: (!spec.cap_add.is_empty()).then(|| spec.cap_add.clone()),
                readonly_rootfs: Some(spec.read_only_rootfs),
                tmpfs: tmpfs_for(spec),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn credentials(auth: RegistryAuth) -> bollard::auth::DockerCredentials {
        bollard::auth::DockerCredentials {
            username: auth.username,
            password: auth.password,
            serveraddress: Some(auth.server_address),
            identitytoken: auth.identity_token,
            registrytoken: auth.registry_token,
            ..Default::default()
        }
    }

    #[async_trait]
    impl SandboxDockerApi for BollardContainerApi {
        async fn inspect_runtime(&self, id: &str) -> Result<Option<RuntimeContainerState>, String> {
            match self.docker.inspect_container(id, None).await {
                Ok(info) => Ok(Some(RuntimeContainerState {
                    running: info.state.and_then(|state| state.running).unwrap_or(false),
                    labels: info
                        .config
                        .and_then(|config| config.labels)
                        .unwrap_or_default()
                        .into_iter()
                        .collect(),
                })),
                Err(bollard::errors::Error::DockerResponseServerError {
                    status_code: 404, ..
                }) => Ok(None),
                Err(error) => Err(format!("inspect runtime failed: {error}")),
            }
        }

        async fn start_runtime(&self, id: &str) -> Result<(), String> {
            self.docker
                .start_container(id, None::<StartContainerOptions>)
                .await
                .map_err(|error| format!("start runtime failed: {error}"))
        }

        async fn stop_runtime(&self, id: &str) -> Result<(), String> {
            self.docker
                .stop_container(
                    id,
                    Some(
                        bollard::query_parameters::StopContainerOptionsBuilder::default()
                            .t(10)
                            .build(),
                    ),
                )
                .await
                .map_err(|error| format!("stop runtime failed: {error}"))
        }

        async fn exec_runtime(&self, spec: RunnerExecSpec) -> Result<RunningRunner, String> {
            use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
            let created = self
                .docker
                .create_exec(
                    &spec.container_id,
                    CreateExecOptions {
                        attach_stdin: Some(true),
                        attach_stdout: Some(true),
                        attach_stderr: Some(true),
                        tty: Some(false),
                        privileged: Some(false),
                        user: Some("0".to_string()),
                        env: Some(spec.env),
                        cmd: Some(spec.command),
                        working_dir: Some(spec.working_dir),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|error| format!("create exec failed: {error}"))?;
            let StartExecResults::Attached {
                mut output,
                mut input,
            } = self
                .docker
                .start_exec(
                    &created.id,
                    Some(StartExecOptions {
                        detach: false,
                        tty: false,
                        output_capacity: Some(64 * 1024),
                    }),
                )
                .await
                .map_err(|error| format!("start exec failed: {error}"))?
            else {
                return Err("exec unexpectedly detached".into());
            };
            let (event_tx, event_rx) = mpsc::channel(16);
            let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(16);
            let input_pump = tokio::spawn(async move {
                while let Some(bytes) = stdin_rx.recv().await {
                    if input.write_all(&bytes).await.is_err() {
                        break;
                    }
                    if input.flush().await.is_err() {
                        break;
                    }
                }
                let _ = input.shutdown().await;
            });
            let docker = self.docker.clone();
            tokio::spawn(async move {
                loop {
                    let item = tokio::select! {
                        _ = event_tx.closed() => break,
                        item = output.next() => match item { Some(item) => item, None => break },
                    };
                    let event = match item {
                        Ok(LogOutput::StdOut { message }) | Ok(LogOutput::Console { message }) => {
                            RunnerEvent::Stdout(message.to_vec())
                        }
                        Ok(LogOutput::StdErr { message }) => RunnerEvent::Stderr(message.to_vec()),
                        Ok(LogOutput::StdIn { .. }) => continue,
                        Err(_) => break,
                    };
                    if event_tx.send(event).await.is_err() {
                        break;
                    }
                }
                input_pump.abort();
                let code = docker
                    .inspect_exec(&created.id)
                    .await
                    .ok()
                    .and_then(|state| state.exit_code);
                let _ = event_tx.send(RunnerEvent::Exited { code }).await;
            });
            Ok(RunningRunner {
                container_id: spec.container_id,
                events: event_rx.into(),
                stdin: stdin_tx.into(),
            })
        }

        async fn runtimes(&self) -> Result<Vec<String>, String> {
            let info = self
                .docker
                .info()
                .await
                .map_err(|e| format!("docker info failed: {e}"))?;
            let mut names: Vec<String> = info.runtimes.unwrap_or_default().into_keys().collect();
            names.sort();
            Ok(names)
        }

        async fn ensure_volume(
            &self,
            name: &str,
            labels: &BTreeMap<String, String>,
        ) -> Result<(), String> {
            // Creating an existing volume with the same driver is a no-op on
            // the daemon, so there is no inspect-then-create race to lose.
            self.docker
                .create_volume(bollard::models::VolumeCreateRequest {
                    name: Some(name.to_string()),
                    labels: Some(labels.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
                    ..Default::default()
                })
                .await
                .map(|_| ())
                .map_err(|e| format!("create_volume {name} failed: {e}"))
        }

        async fn list_owned_volumes(&self) -> Result<Vec<OwnedVolume>, String> {
            let mut filters = std::collections::HashMap::new();
            filters.insert(
                "label".to_string(),
                vec![format!("{OWNER_LABEL}={OWNER_VALUE}")],
            );
            let options = ListVolumesOptionsBuilder::default()
                .filters(&filters)
                .build();
            let listed = self
                .docker
                .list_volumes(Some(options))
                .await
                .map_err(|e| format!("list_volumes failed: {e}"))?;
            Ok(listed
                .volumes
                .unwrap_or_default()
                .into_iter()
                .map(|volume| OwnedVolume {
                    name: volume.name,
                    labels: volume.labels.into_iter().collect(),
                })
                .collect())
        }

        async fn remove_volume(&self, name: &str) -> Result<VolumeRemoval, String> {
            match self
                .docker
                .remove_volume(name, None::<bollard::query_parameters::RemoveVolumeOptions>)
                .await
            {
                Ok(()) => Ok(VolumeRemoval::Removed),
                Err(bollard::errors::Error::DockerResponseServerError {
                    status_code: 404, ..
                }) => Ok(VolumeRemoval::Gone),
                Err(bollard::errors::Error::DockerResponseServerError {
                    status_code: 409, ..
                }) => Ok(VolumeRemoval::InUse),
                Err(e) => Err(format!("remove_volume {name} failed: {e}")),
            }
        }

        async fn pull_image_with_auth(
            &self,
            image: &str,
            auth: Option<RegistryAuth>,
        ) -> Result<(), String> {
            let options = CreateImageOptionsBuilder::default()
                .from_image(image)
                .build();
            let mut stream = self
                .docker
                .create_image(Some(options), None, auth.map(credentials));
            while let Some(item) = stream.next().await {
                item.map_err(|e| format!("pull {image} failed: {e}"))?;
            }
            Ok(())
        }
    }

    impl BollardContainerApi {
        async fn run_inner(&self, spec: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
            let body = create_body_for(&spec);
            let options = CreateContainerOptionsBuilder::default()
                .name(&spec.name)
                .build();
            let created = match self.docker.create_container(Some(options), body).await {
                Ok(created) => created,
                // 404 on create = image absent (name conflicts are 409) —
                // classified so the backend can pull-and-retry once.
                Err(bollard::errors::Error::DockerResponseServerError {
                    status_code: 404,
                    message,
                }) => {
                    return Err(RunnerRunError::ImageMissing(format!(
                        "runner image {} not present on the daemon: {message}",
                        spec.image
                    )))
                }
                Err(e) => {
                    // A transport failure may arrive after the daemon committed
                    // create. Reconcile the unique name and exact ownership;
                    // never retry a request whose outcome is unknown.
                    if !matches!(&e, bollard::errors::Error::DockerResponseServerError { status_code, .. } if *status_code < 500)
                    {
                        self.reconcile_failed_create(&spec).await;
                    }
                    return Err(RunnerRunError::Other(format!(
                        "create_container failed: {e}"
                    )));
                }
            };
            let container_id = created.id;

            // Attach BEFORE start so the first output bytes are never lost.
            let attach_options = AttachContainerOptionsBuilder::default()
                .stdin(true)
                .stdout(true)
                .stderr(true)
                .stream(true)
                .logs(false)
                .build();
            let attached = match self
                .docker
                .attach_container(&container_id, Some(attach_options))
                .await
            {
                Ok(attached) => attached,
                Err(error) => {
                    return Err(self
                        .failed_start(&container_id, format!("attach_container failed: {error}"))
                        .await)
                }
            };

            if let Err(error) = self
                .docker
                .start_container(&container_id, None::<StartContainerOptions>)
                .await
            {
                return Err(self
                    .failed_start(&container_id, format!("start_container failed: {error}"))
                    .await);
            }

            let (event_tx, event_rx) = mpsc::unbounded_channel::<RunnerEvent>();
            let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();

            // stdin pump.
            let mut input = attached.input;
            tokio::spawn(async move {
                while let Some(bytes) = stdin_rx.recv().await {
                    if input.write_all(&bytes).await.is_err() {
                        break;
                    }
                    let _ = input.flush().await;
                }
            });

            // Output pump — drain the demuxed stream to its end (the stream
            // closes when the container exits), THEN resolve the exit code,
            // so Exited is guaranteed to be the last event.
            let docker = self.docker.clone();
            let wait_id = container_id.clone();
            let mut output = attached.output;
            tokio::spawn(async move {
                while let Some(item) = output.next().await {
                    let event = match item {
                        Ok(LogOutput::StdOut { message }) | Ok(LogOutput::Console { message }) => {
                            RunnerEvent::Stdout(message.to_vec())
                        }
                        Ok(LogOutput::StdErr { message }) => RunnerEvent::Stderr(message.to_vec()),
                        Ok(LogOutput::StdIn { .. }) => continue,
                        Err(_) => break,
                    };
                    if event_tx.send(event).is_err() {
                        return;
                    }
                }
                let code = {
                    let options = WaitContainerOptionsBuilder::default()
                        .condition("not-running")
                        .build();
                    let mut wait = docker.wait_container(&wait_id, Some(options));
                    match wait.next().await {
                        Some(Ok(resp)) => Some(resp.status_code),
                        _ => None,
                    }
                };
                let _ = event_tx.send(RunnerEvent::Exited { code });
            });

            Ok(RunningRunner {
                container_id,
                events: event_rx.into(),
                stdin: stdin_tx.into(),
            })
        }

        async fn failed_start(&self, container_id: &str, error: String) -> RunnerRunError {
            match self.remove(container_id).await {
                Ok(()) => RunnerRunError::Other(error),
                Err(cleanup) => {
                    RunnerRunError::Other(format!("{error}; cleanup failed: {cleanup}"))
                }
            }
        }

        async fn reconcile_failed_create(&self, spec: &RunnerSpec) {
            let inspected = self
                .docker
                .inspect_container(
                    &spec.name,
                    None::<bollard::query_parameters::InspectContainerOptions>,
                )
                .await;
            if let Ok(inspected) = inspected {
                let labels = inspected
                    .config
                    .and_then(|config| config.labels)
                    .unwrap_or_default();
                if matches_create_attempt(spec, &labels) {
                    if let Some(id) = inspected.id {
                        if let Err(error) = self.remove(&id).await {
                            log::warn!("ambiguous create cleanup {id} failed: {error}");
                        }
                    }
                }
            }
        }
    }

    #[async_trait]
    impl ContainerApi for BollardContainerApi {
        async fn run(&self, spec: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
            let api = Arc::new(Self {
                docker: self.docker.clone(),
            });
            let worker = Arc::clone(&api);
            let spec = stamp_create_attempt(spec);
            handoff_started_runner(api, async move { worker.run_inner(spec).await }).await
        }

        async fn pull_image(&self, image: &str) -> Result<(), String> {
            let options = CreateImageOptionsBuilder::default()
                .from_image(image)
                .build();
            // Drain the progress stream to completion; any frame-level error
            // aborts the pull (no partial-success semantics).
            let mut stream = self.docker.create_image(Some(options), None, None);
            while let Some(item) = stream.next().await {
                item.map_err(|e| format!("pull {image} failed: {e}"))?;
            }
            Ok(())
        }

        async fn kill(&self, container_id: &str) -> Result<(), String> {
            self.docker
                .kill_container(
                    container_id,
                    Some(
                        KillContainerOptionsBuilder::default()
                            .signal("SIGKILL")
                            .build(),
                    ),
                )
                .await
                .map_err(|e| format!("kill_container failed: {e}"))
        }

        async fn labels(
            &self,
            container_id: &str,
        ) -> Result<Option<BTreeMap<String, String>>, String> {
            let mut filters = std::collections::HashMap::new();
            filters.insert("id".to_string(), vec![container_id.to_string()]);
            let found = self.summaries(filters).await?;
            Ok(found.into_iter().next().map(|summary| {
                summary
                    .labels
                    .unwrap_or_default()
                    .into_iter()
                    .collect::<BTreeMap<_, _>>()
            }))
        }

        async fn list_owned(&self) -> Result<Vec<OwnedContainer>, String> {
            // Ask the daemon, not our own memory. This is the query a name
            // convention cannot answer, and the reason orphans were invisible.
            let mut filters = std::collections::HashMap::new();
            filters.insert(
                "label".to_string(),
                vec![format!("{OWNER_LABEL}={OWNER_VALUE}")],
            );
            let found = self.summaries(filters).await?;
            Ok(found
                .into_iter()
                .filter_map(|summary| {
                    let id = summary.id?;
                    Some(OwnedContainer {
                        id,
                        labels: summary
                            .labels
                            .unwrap_or_default()
                            .into_iter()
                            .collect::<BTreeMap<_, _>>(),
                    })
                })
                .collect())
        }

        async fn remove(&self, container_id: &str) -> Result<(), String> {
            match self
                .docker
                .remove_container(
                    container_id,
                    Some(
                        RemoveContainerOptionsBuilder::default()
                            .force(true)
                            .v(true)
                            .build(),
                    ),
                )
                .await
            {
                Ok(()) => Ok(()),
                // Idempotent: an already-gone container is success.
                Err(bollard::errors::Error::DockerResponseServerError {
                    status_code: 404, ..
                }) => Ok(()),
                Err(e) => Err(format!("remove_container failed: {e}")),
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn spec(mount: Option<RunnerMount>, extra_mounts: Vec<VolumeMount>) -> RunnerSpec {
            RunnerSpec {
                name: "n".into(),
                image: "i".into(),
                cmd: vec![],
                env: vec![],
                working_dir: WORKSPACE_TARGET.into(),
                mount,
                seccomp_json: None,
                memory_bytes: 1,
                nano_cpus: 1,
                pids_limit: 1,
                network_mode: "none".into(),
                labels: BTreeMap::new(),
                entrypoint: None,
                user: None,
                extra_mounts,
                runtime: None,
                cap_drop: Vec::new(),
                cap_add: Vec::new(),
                read_only_rootfs: false,
                tmpfs: Vec::new(),
                writable_dirs: Vec::new(),
            }
        }

        #[test]
        fn the_create_body_carries_the_isolation_bounds() {
            let mut hardened = spec(
                Some(RunnerMount::Volume {
                    volume: "cognia_workspaces".into(),
                    subpath: Some("ws-1".into()),
                }),
                vec![],
            );
            hardened.cap_drop = vec!["ALL".into()];
            hardened.cap_add = vec!["SETUID".into(), "CHOWN".into()];
            hardened.read_only_rootfs = true;
            hardened.tmpfs = vec!["/tmp".into(), "/run:rw,noexec".into()];
            hardened.writable_dirs = vec!["/home/agent".into()];

            let body = create_body_for(&hardened);
            assert_eq!(body.volumes, Some(vec!["/home/agent".to_string()]));
            let host = body.host_config.expect("host config");
            assert_eq!(host.cap_drop, Some(vec!["ALL".to_string()]));
            assert_eq!(
                host.cap_add,
                Some(vec!["SETUID".to_string(), "CHOWN".to_string()])
            );
            assert_eq!(host.readonly_rootfs, Some(true));
            let tmpfs = host.tmpfs.expect("tmpfs map");
            assert_eq!(tmpfs["/tmp"], "");
            assert_eq!(tmpfs["/run"], "rw,noexec");
            assert!(host
                .security_opt
                .unwrap()
                .iter()
                .any(|opt| opt == "no-new-privileges:true"));
            // The workspace mount is the only mount — never the host's
            // Docker socket or another host path.
            let mounts = host.mounts.unwrap();
            assert_eq!(mounts.len(), 1);
            assert_eq!(mounts[0].target.as_deref(), Some("/workspace"));
        }

        #[test]
        fn ambiguous_create_cleanup_never_matches_a_later_same_id_attempt() {
            let mut runner = spec(None, vec![]);
            runner.labels = ownership_labels("same", "instance", "deployment");
            let first = stamp_create_attempt(runner.clone());
            let next = stamp_create_attempt(runner.clone());
            let first_labels = first.labels.clone().into_iter().collect();
            let next_labels = next.labels.clone().into_iter().collect();
            assert!(matches_create_attempt(&first, &first_labels));
            assert!(!matches_create_attempt(&first, &next_labels));
            assert!(!matches_create_attempt(&runner, &first_labels));
            let mut foreign = first_labels;
            foreign.insert(OWNER_LABEL.into(), "another-owner".into());
            assert!(!matches_create_attempt(&first, &foreign));
        }

        #[test]
        fn the_create_body_omits_bounds_a_spec_did_not_ask_for() {
            let body = create_body_for(&spec(None, vec![]));
            assert_eq!(body.volumes, None);
            let host = body.host_config.expect("host config");
            assert_eq!(host.cap_drop, None);
            assert_eq!(host.cap_add, None);
            assert_eq!(host.readonly_rootfs, Some(false));
            assert_eq!(host.tmpfs, None);
        }

        #[test]
        fn a_legacy_runner_mounts_its_workspace_and_nothing_else() {
            let mounts = mounts_for(&spec(
                Some(RunnerMount::Volume {
                    volume: "cognia_workspaces".into(),
                    subpath: Some("ws-1".into()),
                }),
                vec![],
            ));
            assert_eq!(mounts.len(), 1);
            // Exactly the serialized mount a legacy runner always sent.
            assert_eq!(
                serde_json::to_value(&mounts[0]).unwrap(),
                serde_json::json!({
                    "Target": "/workspace",
                    "Source": "cognia_workspaces",
                    "Type": "volume",
                    "VolumeOptions": { "Subpath": "ws-1" }
                })
            );
        }

        #[test]
        fn a_sandbox_mounts_the_bundle_read_only_beside_its_workspace() {
            let bundle = VolumeMount {
                volume: "cognia-d-bundle-abc-musl".into(),
                target: "/cognia".into(),
                read_only: true,
            };
            let mounts = mounts_for(&spec(
                Some(RunnerMount::Bind {
                    host_dir: "/srv/ws".into(),
                }),
                vec![bundle],
            ));
            assert_eq!(mounts[0].target.as_deref(), Some("/workspace"));
            assert_eq!(
                mounts[1].source.as_deref(),
                Some("cognia-d-bundle-abc-musl")
            );
            assert_eq!(mounts[1].read_only, Some(true));

            let staging = mounts_for(&spec(
                None,
                vec![VolumeMount {
                    volume: "v".into(),
                    target: "/cognia".into(),
                    read_only: false,
                }],
            ));
            assert_eq!(staging.len(), 1);
            assert_eq!(staging[0].read_only, Some(false));
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(any(test, feature = "test-support"))]
pub mod test_support {
    use super::*;

    /// What a scripted container prints before it exits by itself.
    pub struct ScriptedExit {
        pub stdout: Vec<u8>,
        pub stderr: Vec<u8>,
        pub code: i64,
    }

    type ExitScript = Box<dyn Fn(&RunnerSpec) -> Option<ScriptedExit> + Send + Sync>;

    /// Scriptable in-memory daemon: `run` hands back channels the test
    /// drives; `kill` closes the event stream with the configured code.
    pub struct FakeContainerApi {
        pub specs: Mutex<Vec<RunnerSpec>>,
        pub kills: Mutex<Vec<String>>,
        pub removes: Mutex<Vec<String>>,
        /// What the daemon would report for each container.
        pub labels_by_container: Mutex<HashMap<String, BTreeMap<String, String>>>,
        /// Handles for containers started through this fake, by container id.
        pub handles: Mutex<HashMap<String, FakeHandle>>,
        pub fail_run: Mutex<Option<String>>,
        /// Optional admission barrier for deterministic concurrent-spawn tests.
        pub run_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
        pub run_started: tokio::sync::Notify,
        pub remove_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
        pub remove_started: tokio::sync::Notify,
        pub fail_remove: Mutex<Option<String>>,
        pub fail_kill: Mutex<Option<String>>,
        pub fail_labels: Mutex<Option<String>>,
        pub kill_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
        pub kill_started: tokio::sync::Notify,
        pub volume_remove_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
        pub volume_remove_started: tokio::sync::Notify,
        pub fail_volume_remove: Mutex<Option<String>>,
        /// When true, `run` reports ImageMissing until `pull_image` succeeds.
        pub missing_image: Mutex<bool>,
        pub pulls: Mutex<Vec<String>>,
        pub fail_pull: Mutex<Option<String>>,
        // ── SandboxDockerApi ────────────────────────────────────────────
        /// `/info` runtimes, or the error `/info` fails with.
        pub runtimes: Mutex<Result<Vec<String>, String>>,
        pub runtime_execs: Mutex<Vec<RunnerExecSpec>>,
        pub stopped_runtimes: Mutex<std::collections::BTreeSet<String>>,
        pub restarted_runtimes: Mutex<Vec<String>>,
        pub volumes: Mutex<BTreeMap<String, BTreeMap<String, String>>>,
        pub volumes_in_use: Mutex<std::collections::BTreeSet<String>>,
        pub fail_volume: Mutex<Option<String>>,
        /// Images `run` reports missing until an authenticated pull of that
        /// image succeeds.
        pub missing_images: Mutex<std::collections::BTreeSet<String>>,
        pub auth_pulls: Mutex<Vec<(String, Option<RegistryAuth>)>>,
        pub fail_auth_pull: Mutex<HashMap<String, String>>,
        /// Containers the script answers for exit on their own (staging and
        /// probe containers); every other container waits for the test.
        pub exit_script: Mutex<Option<ExitScript>>,
        counter: Mutex<u64>,
    }

    pub struct FakeHandle {
        pub events: mpsc::UnboundedSender<RunnerEvent>,
        pub stdin: Mutex<Option<mpsc::UnboundedReceiver<Vec<u8>>>>,
    }

    impl FakeContainerApi {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                specs: Mutex::new(Vec::new()),
                kills: Mutex::new(Vec::new()),
                removes: Mutex::new(Vec::new()),
                labels_by_container: Mutex::new(HashMap::new()),
                handles: Mutex::new(HashMap::new()),
                fail_run: Mutex::new(None),
                run_gate: Mutex::new(None),
                run_started: tokio::sync::Notify::new(),
                remove_gate: Mutex::new(None),
                remove_started: tokio::sync::Notify::new(),
                fail_remove: Mutex::new(None),
                fail_kill: Mutex::new(None),
                fail_labels: Mutex::new(None),
                kill_gate: Mutex::new(None),
                kill_started: tokio::sync::Notify::new(),
                volume_remove_gate: Mutex::new(None),
                volume_remove_started: tokio::sync::Notify::new(),
                fail_volume_remove: Mutex::new(None),
                missing_image: Mutex::new(false),
                pulls: Mutex::new(Vec::new()),
                fail_pull: Mutex::new(None),
                runtimes: Mutex::new(Ok(vec!["runc".to_string()])),
                runtime_execs: Mutex::new(Vec::new()),
                stopped_runtimes: Mutex::new(std::collections::BTreeSet::new()),
                restarted_runtimes: Mutex::new(Vec::new()),
                volumes: Mutex::new(BTreeMap::new()),
                volumes_in_use: Mutex::new(std::collections::BTreeSet::new()),
                fail_volume: Mutex::new(None),
                missing_images: Mutex::new(std::collections::BTreeSet::new()),
                auth_pulls: Mutex::new(Vec::new()),
                fail_auth_pull: Mutex::new(HashMap::new()),
                exit_script: Mutex::new(None),
                counter: Mutex::new(0),
            })
        }

        pub fn script_exits(
            &self,
            script: impl Fn(&RunnerSpec) -> Option<ScriptedExit> + Send + Sync + 'static,
        ) {
            *self.exit_script.lock() = Some(Box::new(script));
        }

        pub fn handle_events(&self, container_id: &str) -> mpsc::UnboundedSender<RunnerEvent> {
            self.handles
                .lock()
                .get(container_id)
                .expect("container handle")
                .events
                .clone()
        }

        pub fn take_stdin(&self, container_id: &str) -> mpsc::UnboundedReceiver<Vec<u8>> {
            self.handles
                .lock()
                .get(container_id)
                .expect("container handle")
                .stdin
                .lock()
                .take()
                .expect("stdin already taken")
        }
    }

    #[async_trait]
    impl ContainerApi for FakeContainerApi {
        async fn run(&self, spec: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
            let gate = self.run_gate.lock().clone();
            if let Some(gate) = gate {
                self.run_started.notify_one();
                gate.acquire().await.expect("test run gate open").forget();
            }
            if *self.missing_image.lock() || self.missing_images.lock().contains(&spec.image) {
                return Err(RunnerRunError::ImageMissing(format!(
                    "No such image: {}",
                    spec.image
                )));
            }
            if let Some(err) = self.fail_run.lock().clone() {
                return Err(RunnerRunError::Other(err));
            }
            let container_id = {
                let mut counter = self.counter.lock();
                *counter += 1;
                format!("ctr-{}", *counter)
            };
            self.labels_by_container
                .lock()
                .insert(container_id.clone(), spec.labels.clone());
            let scripted = self
                .exit_script
                .lock()
                .as_ref()
                .and_then(|script| script(&spec));
            self.specs.lock().push(spec);
            let (event_tx, event_rx) = mpsc::unbounded_channel();
            let (stdin_tx, stdin_rx) = mpsc::unbounded_channel();
            if let Some(exit) = scripted {
                if !exit.stdout.is_empty() {
                    let _ = event_tx.send(RunnerEvent::Stdout(exit.stdout));
                }
                if !exit.stderr.is_empty() {
                    let _ = event_tx.send(RunnerEvent::Stderr(exit.stderr));
                }
                let _ = event_tx.send(RunnerEvent::Exited {
                    code: Some(exit.code),
                });
            }
            self.handles.lock().insert(
                container_id.clone(),
                FakeHandle {
                    events: event_tx,
                    stdin: Mutex::new(Some(stdin_rx)),
                },
            );
            Ok(RunningRunner {
                container_id,
                events: event_rx.into(),
                stdin: stdin_tx.into(),
            })
        }

        async fn pull_image(&self, image: &str) -> Result<(), String> {
            if let Some(err) = self.fail_pull.lock().clone() {
                return Err(err);
            }
            self.pulls.lock().push(image.to_string());
            *self.missing_image.lock() = false;
            Ok(())
        }

        async fn kill(&self, container_id: &str) -> Result<(), String> {
            let gate = self.kill_gate.lock().clone();
            if let Some(gate) = gate {
                self.kill_started.notify_one();
                gate.acquire().await.expect("test kill gate open").forget();
            }
            if let Some(error) = self.fail_kill.lock().clone() {
                return Err(error);
            }
            self.kills.lock().push(container_id.to_string());
            // A real daemon kill terminates the attached stream — emulate by
            // sending the exit event.
            if let Some(handle) = self.handles.lock().get(container_id) {
                let _ = handle.events.send(RunnerEvent::Exited { code: Some(137) });
            }
            Ok(())
        }

        async fn labels(
            &self,
            container_id: &str,
        ) -> Result<Option<BTreeMap<String, String>>, String> {
            if let Some(error) = self.fail_labels.lock().clone() {
                return Err(error);
            }
            Ok(self.labels_by_container.lock().get(container_id).cloned())
        }

        async fn list_owned(&self) -> Result<Vec<OwnedContainer>, String> {
            Ok(self
                .labels_by_container
                .lock()
                .iter()
                .filter(|(_, labels)| is_owned(labels))
                .map(|(id, labels)| OwnedContainer {
                    id: id.clone(),
                    labels: labels.clone(),
                })
                .collect())
        }

        async fn remove(&self, container_id: &str) -> Result<(), String> {
            let gate = self.remove_gate.lock().clone();
            if let Some(gate) = gate {
                self.remove_started.notify_one();
                gate.acquire()
                    .await
                    .expect("test remove gate open")
                    .forget();
            }
            if let Some(error) = self.fail_remove.lock().clone() {
                return Err(error);
            }
            self.labels_by_container.lock().remove(container_id);
            self.removes.lock().push(container_id.to_string());
            Ok(())
        }
    }

    #[async_trait]
    impl SandboxDockerApi for FakeContainerApi {
        async fn inspect_runtime(&self, id: &str) -> Result<Option<RuntimeContainerState>, String> {
            Ok(self
                .labels_by_container
                .lock()
                .get(id)
                .cloned()
                .map(|labels| RuntimeContainerState {
                    running: !self.stopped_runtimes.lock().contains(id),
                    labels,
                }))
        }
        async fn start_runtime(&self, id: &str) -> Result<(), String> {
            if !self.labels_by_container.lock().contains_key(id) {
                return Err("runtime missing".into());
            }
            self.stopped_runtimes.lock().remove(id);
            self.restarted_runtimes.lock().push(id.into());
            Ok(())
        }
        async fn stop_runtime(&self, id: &str) -> Result<(), String> {
            self.stopped_runtimes.lock().insert(id.into());
            Ok(())
        }
        async fn exec_runtime(&self, spec: RunnerExecSpec) -> Result<RunningRunner, String> {
            let (event_tx, event_rx) = mpsc::unbounded_channel();
            let (stdin_tx, stdin_rx) = mpsc::unbounded_channel();
            let action = spec.command.get(1).map(String::as_str).unwrap_or("");
            let session = spec
                .command
                .windows(2)
                .find(|args| args[0] == "--session")
                .map(|args| args[1].as_str())
                .unwrap_or("");
            match action {
                "health" => {
                    let runtime_key = self
                        .labels_by_container
                        .lock()
                        .get(&spec.container_id)
                        .and_then(|labels| labels.get("cognia.runtime-key"))
                        .cloned();
                    let _ = event_tx.send(RunnerEvent::Stdout(
                        serde_json::to_vec(
                            &serde_json::json!({"ready":true,"runtimeKey":runtime_key}),
                        )
                        .unwrap(),
                    ));
                    let _ = event_tx.send(RunnerEvent::Exited { code: Some(0) });
                }
                "signal-agent" => {
                    if let Some(handle) = self.handles.lock().get(&format!("session:{session}")) {
                        let _ = handle.events.send(RunnerEvent::Exited { code: Some(143) });
                    }
                    let _ = event_tx.send(RunnerEvent::Exited { code: Some(0) });
                }
                "renew-agent" => {
                    let _ = event_tx.send(RunnerEvent::Exited { code: Some(0) });
                }
                "connect-port" => {
                    let mut input = stdin_rx;
                    tokio::spawn(async move {
                        while let Some(bytes) = input.recv().await {
                            if event_tx.send(RunnerEvent::Stdout(bytes)).is_err() {
                                return;
                            }
                        }
                        let _ = event_tx.send(RunnerEvent::Exited { code: Some(0) });
                    });
                }
                "connect-agent" => {
                    self.handles.lock().insert(
                        format!("session:{session}"),
                        FakeHandle {
                            events: event_tx,
                            stdin: Mutex::new(Some(stdin_rx)),
                        },
                    );
                }
                _ => return Err(format!("unscripted runtime action {action}")),
            }
            let container_id = spec.container_id.clone();
            self.runtime_execs.lock().push(spec);
            Ok(RunningRunner {
                container_id,
                events: event_rx.into(),
                stdin: stdin_tx.into(),
            })
        }

        async fn runtimes(&self) -> Result<Vec<String>, String> {
            self.runtimes.lock().clone()
        }

        async fn ensure_volume(
            &self,
            name: &str,
            labels: &BTreeMap<String, String>,
        ) -> Result<(), String> {
            if let Some(err) = self.fail_volume.lock().clone() {
                return Err(err);
            }
            self.volumes
                .lock()
                .entry(name.to_string())
                .or_insert_with(|| labels.clone());
            Ok(())
        }

        async fn list_owned_volumes(&self) -> Result<Vec<OwnedVolume>, String> {
            Ok(self
                .volumes
                .lock()
                .iter()
                .filter(|(_, labels)| is_owned(labels))
                .map(|(name, labels)| OwnedVolume {
                    name: name.clone(),
                    labels: labels.clone(),
                })
                .collect())
        }

        async fn remove_volume(&self, name: &str) -> Result<VolumeRemoval, String> {
            let gate = self.volume_remove_gate.lock().clone();
            if let Some(gate) = gate {
                self.volume_remove_started.notify_one();
                gate.acquire()
                    .await
                    .expect("test volume remove gate open")
                    .forget();
            }
            if self.volumes_in_use.lock().contains(name) {
                return Ok(VolumeRemoval::InUse);
            }
            let removed = match self.volumes.lock().remove(name) {
                Some(_) => VolumeRemoval::Removed,
                None => VolumeRemoval::Gone,
            };
            if let Some(error) = self.fail_volume_remove.lock().clone() {
                return Err(error);
            }
            Ok(removed)
        }

        async fn pull_image_with_auth(
            &self,
            image: &str,
            auth: Option<RegistryAuth>,
        ) -> Result<(), String> {
            self.auth_pulls.lock().push((image.to_string(), auth));
            if let Some(err) = self.fail_auth_pull.lock().get(image).cloned() {
                return Err(err);
            }
            self.missing_images.lock().remove(image);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::FakeContainerApi;
    use super::*;
    use crate::exec_backend::test_support::RecordingAgentEmitter;
    use crate::exec_backend::EmitterEventSink;
    use crate::exec_backend::{
        spawn_with_events, EXIT_CHANNEL, SPAWN_CHANNEL, STATE_CHANGE_CHANNEL, STDERR_CHANNEL,
        STDOUT_CHANNEL,
    };

    fn test_config(volume: Option<&str>) -> ContainerBackendConfig {
        ContainerBackendConfig {
            image: "ghcr.io/example/cognia-runner:test".into(),
            workspaces_dir: PathBuf::from("/workspaces"),
            workspaces_volume: volume.map(String::from),
            seccomp_json: Some("{\"defaultAction\":\"SCMP_ACT_ALLOW\"}".into()),
            memory_bytes: 2048 * 1024 * 1024,
            nano_cpus: 2_000_000_000,
            pids_limit: 512,
            network_mode: "bridge".into(),
            deployment_id: "deployment-A".into(),
        }
    }

    fn spawn_config(id: &str) -> ExternalAgentSpawnConfig {
        let mut env = HashMap::new();
        env.insert("B_KEY".to_string(), "2".to_string());
        env.insert("A_KEY".to_string(), "1".to_string());
        ExternalAgentSpawnConfig {
            id: id.into(),
            command: "claude-code-acp".into(),
            args: vec!["--stdio".into()],
            env,
            cwd: Some("/workspaces/ws-1".into()),
            framing: Default::default(),
            sandbox: None,
        }
    }

    async fn wait_for<F: Fn() -> bool>(cond: F, what: &str) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("timeout waiting for {what}");
    }

    // ── Spec construction ────────────────────────────────────────────────────

    // --- ownership -------------------------------------------------------

    fn foreign_labels() -> BTreeMap<String, String> {
        BTreeMap::from([("com.example.owner".to_string(), "someone-else".to_string())])
    }

    #[tokio::test]
    async fn spawn_stamps_ownership_onto_the_container_itself() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::with_instance_id(
            api.clone(),
            test_config(Some("cognia_workspaces")),
            "instance-A".into(),
        );
        let emitter = RecordingAgentEmitter::new();
        spawn_with_events(backend.as_ref(), emitter, spawn_config("a 1"))
            .await
            .expect("spawn");

        let specs = api.specs.lock();
        let labels = &specs[0].labels;
        assert_eq!(
            labels.get(OWNER_LABEL).map(String::as_str),
            Some(OWNER_VALUE)
        );
        assert_eq!(labels.get(AGENT_ID_LABEL).map(String::as_str), Some("a 1"));
        assert_eq!(
            labels.get(INSTANCE_LABEL).map(String::as_str),
            Some("instance-A")
        );
        assert_eq!(
            labels.get(SCHEMA_LABEL).map(String::as_str),
            Some(SCHEMA_VERSION)
        );
    }

    #[tokio::test]
    async fn refuses_to_remove_a_container_it_does_not_own() {
        let api = FakeContainerApi::new();
        api.labels_by_container
            .lock()
            .insert("someone-elses".to_string(), foreign_labels());
        let api_dyn: Arc<dyn ContainerApi> = api.clone();

        let err = remove_owned(&api_dyn, "someone-elses")
            .await
            .expect_err("must refuse");
        assert!(err.contains("refusing to touch"), "{err}");
        assert!(api.removes.lock().is_empty(), "nothing may be removed");
    }

    #[tokio::test]
    async fn removing_an_already_gone_container_is_a_no_op_not_an_error() {
        let api = FakeContainerApi::new();
        let api_dyn: Arc<dyn ContainerApi> = api.clone();
        remove_owned(&api_dyn, "vanished")
            .await
            .expect("idempotent");
        assert!(api.removes.lock().is_empty());
    }

    #[tokio::test]
    async fn kill_refuses_a_recycled_id_that_is_no_longer_ours() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::with_instance_id(
            api.clone(),
            test_config(Some("cognia_workspaces")),
            "instance-A".into(),
        );
        let emitter = RecordingAgentEmitter::new();
        spawn_with_events(backend.as_ref(), emitter, spawn_config("a 1"))
            .await
            .expect("spawn");

        // The daemon now reports that id as belonging to someone else — the
        // shape a recycled container id takes.
        let container_id = api
            .specs
            .lock()
            .first()
            .map(|_| "ctr-1".to_string())
            .unwrap();
        api.labels_by_container
            .lock()
            .insert(container_id.clone(), foreign_labels());

        let err = ExecBackend::kill(backend.as_ref(), "a 1")
            .await
            .expect_err("must refuse");
        assert!(err.contains("refusing to touch"), "{err}");
    }

    #[tokio::test]
    async fn reaps_a_previous_run_but_leaves_this_one_alone() {
        let api = FakeContainerApi::new();
        api.labels_by_container.lock().insert(
            "mine".to_string(),
            ownership_labels("agent-live", "instance-A", "deployment-A"),
        );
        api.labels_by_container.lock().insert(
            "orphan".to_string(),
            ownership_labels("agent-dead", "instance-PREVIOUS", "deployment-A"),
        );
        api.labels_by_container
            .lock()
            .insert("theirs".to_string(), foreign_labels());

        let backend = ContainerBackend::with_instance_id(
            api.clone(),
            test_config(Some("cognia_workspaces")),
            "instance-A".into(),
        );
        let reaped = backend.reap_orphans().await.expect("reap");

        assert_eq!(reaped, vec!["orphan".to_string()]);
        let removed = api.removes.lock().clone();
        assert_eq!(removed, vec!["orphan".to_string()]);
    }

    // Two cognia-server deployments sharing one daemon (two compose
    // instances on a host, or two tenants whose socket proxies reach the
    // same dockerd) each see the other's runners as "owned by a process that
    // is not me". Before the deployment label, that was enough to reap them:
    // booting instance B removed every live agent of instance A.
    #[tokio::test]
    async fn reaping_never_touches_another_deployments_live_runners() {
        let api = FakeContainerApi::new();
        api.labels_by_container.lock().insert(
            "other-deployment-live".to_string(),
            ownership_labels("agent-live", "instance-B", "deployment-B"),
        );
        api.labels_by_container.lock().insert(
            "own-orphan".to_string(),
            ownership_labels("agent-dead", "instance-PREVIOUS", "deployment-A"),
        );

        let backend = ContainerBackend::with_instance_id(
            api.clone(),
            test_config(Some("cognia_workspaces")),
            "instance-A".into(),
        );
        let reaped = backend.reap_orphans().await.expect("reap");

        assert_eq!(reaped, vec!["own-orphan".to_string()]);
        assert!(api
            .labels_by_container
            .lock()
            .contains_key("other-deployment-live"));
    }

    // A container created by a build that predates the deployment label has
    // no way to say whose it is. Guessing "mine" is the exact failure above,
    // so it is left alone and remains visible to the operator.
    #[tokio::test]
    async fn reaping_leaves_containers_without_a_deployment_label_alone() {
        let api = FakeContainerApi::new();
        let mut legacy = ownership_labels("agent-dead", "instance-PREVIOUS", "deployment-A");
        legacy.remove(DEPLOYMENT_LABEL);
        api.labels_by_container
            .lock()
            .insert("legacy".to_string(), legacy);

        let backend = ContainerBackend::with_instance_id(
            api.clone(),
            test_config(Some("cognia_workspaces")),
            "instance-A".into(),
        );

        assert!(backend.reap_orphans().await.expect("reap").is_empty());
        assert!(api.removes.lock().is_empty());
    }

    #[test]
    fn deployment_ids_are_label_safe_or_refused() {
        assert_eq!(
            validate_deployment_id("  cognia-prod.1_a  ").unwrap(),
            "cognia-prod.1_a"
        );
        assert!(validate_deployment_id("").is_err());
        assert!(validate_deployment_id("   ").is_err());
        assert!(validate_deployment_id("has space").is_err());
        assert!(validate_deployment_id("slash/y").is_err());
        assert!(validate_deployment_id(&"x".repeat(64)).is_err());
        assert!(validate_deployment_id(&"x".repeat(63)).is_ok());
    }

    #[tokio::test]
    async fn reaping_finds_nothing_on_a_clean_daemon() {
        let api = FakeContainerApi::new();
        let backend =
            ContainerBackend::with_instance_id(api.clone(), test_config(None), "instance-A".into());
        assert!(backend.reap_orphans().await.expect("reap").is_empty());
    }

    #[test]
    fn ownership_is_decided_by_the_owner_label_alone() {
        assert!(is_owned(&ownership_labels("a", "b", "c")));
        assert!(!is_owned(&foreign_labels()));
        assert!(!is_owned(&BTreeMap::new()));
    }

    #[test]
    fn each_process_gets_its_own_instance_id() {
        assert_ne!(default_instance_id(), default_instance_id());
    }

    #[test]
    fn concurrent_backend_instances_have_unique_label_safe_ids() {
        let threads: Vec<_> = (0..4)
            .map(|_| {
                std::thread::spawn(|| (0..256).map(|_| default_instance_id()).collect::<Vec<_>>())
            })
            .collect();
        let ids: std::collections::BTreeSet<_> = threads
            .into_iter()
            .flat_map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(ids.len(), 1024);
        for id in ids {
            assert_eq!(validate_deployment_id(&id).unwrap(), id);
        }
    }

    #[tokio::test]
    async fn spawn_builds_a_locked_down_runner_spec() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api.clone(), test_config(Some("cognia_workspaces")));
        let emitter = RecordingAgentEmitter::new();

        let id = spawn_with_events(backend.as_ref(), emitter.clone(), spawn_config("a 1"))
            .await
            .expect("spawn");
        assert_eq!(id, "a 1");

        let specs = api.specs.lock();
        assert_eq!(specs.len(), 1);
        let spec = &specs[0];
        assert_eq!(spec.name, "cognia-agent-a-1"); // sanitized
        assert_eq!(spec.image, "ghcr.io/example/cognia-runner:test");
        assert_eq!(spec.cmd, vec!["claude-code-acp", "--stdio"]);
        assert_eq!(spec.env, vec!["A_KEY=1", "B_KEY=2"]); // sorted
        assert_eq!(spec.working_dir, WORKSPACE_TARGET);
        assert_eq!(
            spec.mount,
            Some(RunnerMount::Volume {
                volume: "cognia_workspaces".into(),
                subpath: Some("ws-1".into())
            })
        );
        assert!(spec.seccomp_json.is_some());
        assert_eq!(spec.memory_bytes, 2048 * 1024 * 1024);
        assert_eq!(spec.nano_cpus, 2_000_000_000);
        assert_eq!(spec.pids_limit, 512);
        assert_eq!(spec.network_mode, "bridge");
        assert_eq!(backend.kind(), "container");
        // Off path (ADR-0182): a legacy runner sets none of the runtime
        // environment fields, so the daemon request is what it always was.
        assert_eq!(spec.entrypoint, None);
        assert_eq!(spec.user, None);
        assert!(spec.extra_mounts.is_empty());
        assert_eq!(spec.runtime, None);
    }

    #[tokio::test]
    async fn bind_mount_mode_without_a_volume() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api.clone(), test_config(None));
        let emitter = RecordingAgentEmitter::new();
        spawn_with_events(backend.as_ref(), emitter, spawn_config("b1"))
            .await
            .expect("spawn");
        assert_eq!(
            api.specs.lock()[0].mount,
            Some(RunnerMount::Bind {
                host_dir: "/workspaces/ws-1".into()
            })
        );
    }

    #[tokio::test]
    async fn volume_mode_rejects_cwd_outside_the_workspace_root() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api, test_config(Some("v")));
        let mut config = spawn_config("evil");
        config.cwd = Some("/etc".into());
        let sink = crate::exec_backend::EmitterEventSink::new(RecordingAgentEmitter::new());
        let err = backend.spawn(config, sink).await.unwrap_err();
        assert!(err.contains("outside the workspace root"), "{err}");
    }

    #[tokio::test]
    async fn spawn_requires_a_cwd() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api, test_config(Some("v")));
        let mut config = spawn_config("no-cwd");
        config.cwd = None;
        let sink = crate::exec_backend::EmitterEventSink::new(RecordingAgentEmitter::new());
        let err = backend.spawn(config, sink).await.unwrap_err();
        assert!(err.contains("requires a workspace cwd"), "{err}");
    }

    // ── Lifecycle + event choreography (parity with LocalProcessBackend) ────

    #[tokio::test]
    async fn full_lifecycle_events_match_the_local_backend_contract() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        let emitter = RecordingAgentEmitter::new();

        let id = spawn_with_events(backend.as_ref(), emitter.clone(), spawn_config("agent-1"))
            .await
            .expect("spawn");

        // spawn(starting) → state-change(Running) choreography.
        {
            let events = emitter.events();
            assert_eq!(events[0].0, SPAWN_CHANNEL);
            assert_eq!(events[1].0, STATE_CHANGE_CHANNEL);
            assert_eq!(events[1].1["state"], "Running");
        }
        assert_eq!(
            backend.status(&id).await,
            Some(ExternalAgentProcessState::Running)
        );
        assert_eq!(backend.is_running(&id).await, Ok(true));
        assert!(backend.list().await.contains(&id));

        let info = backend.get_info(&id).await.expect("info");
        assert_eq!(info["id"], "agent-1");
        assert_eq!(info["containerId"], "ctr-1");
        assert_eq!(info["state"], "Running");
        assert!(info["pid"].is_null());

        // send → the runner's stdin receives newline-framed bytes.
        backend.send(&id, "ping").await.expect("send");
        let mut stdin = api.take_stdin("ctr-1");
        assert_eq!(stdin.recv().await.unwrap(), b"ping\n".to_vec());

        // Demux: chunked stdout/stderr arrive as line events, CRLF trimmed.
        let events_tx = api.handle_events("ctr-1");
        events_tx
            .send(RunnerEvent::Stdout(b"par".to_vec()))
            .unwrap();
        events_tx
            .send(RunnerEvent::Stdout(b"tial line\r\nsecond\n".to_vec()))
            .unwrap();
        events_tx
            .send(RunnerEvent::Stderr(b"warn: x\n".to_vec()))
            .unwrap();
        wait_for(
            || {
                let events = emitter.events();
                events.iter().filter(|(ch, _)| ch == STDOUT_CHANNEL).count() == 2
                    && events.iter().any(|(ch, _)| ch == STDERR_CHANNEL)
            },
            "stdout/stderr line events",
        )
        .await;
        {
            let events = emitter.events();
            let stdout: Vec<_> = events
                .iter()
                .filter(|(ch, _)| ch == STDOUT_CHANNEL)
                .map(|(_, p)| p["data"].as_str().unwrap().to_string())
                .collect();
            assert_eq!(stdout, vec!["partial line", "second"]);
        }

        // Exit: trailing partial line flushed, Stopped + exit emitted,
        // registry forgets the id, container removed.
        events_tx
            .send(RunnerEvent::Stdout(b"no newline".to_vec()))
            .unwrap();
        events_tx
            .send(RunnerEvent::Exited { code: Some(3) })
            .unwrap();
        wait_for(
            || emitter.events().iter().any(|(ch, _)| ch == EXIT_CHANNEL),
            "exit event",
        )
        .await;
        let events = emitter.events();
        assert!(events
            .iter()
            .any(|(ch, p)| ch == STDOUT_CHANNEL && p["data"] == "no newline"));
        let exit = events.iter().find(|(ch, _)| ch == EXIT_CHANNEL).unwrap();
        assert_eq!(exit.1["code"], 3);
        assert!(events
            .iter()
            .any(|(ch, p)| ch == STATE_CHANGE_CHANNEL && p["state"] == "Stopped"));
        wait_for(
            || backend.runners.agents.lock().is_empty(),
            "registry cleanup",
        )
        .await;
        wait_for(
            || api.removes.lock().contains(&"ctr-1".to_string()),
            "container removal",
        )
        .await;
        assert!(backend.status(&id).await.is_none());
    }

    #[tokio::test]
    async fn kill_terminates_the_container_and_surfaces_exit() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        let emitter = RecordingAgentEmitter::new();
        let id = spawn_with_events(backend.as_ref(), emitter.clone(), spawn_config("k1"))
            .await
            .expect("spawn");

        backend.kill(&id).await.expect("kill");
        assert_eq!(api.kills.lock().clone(), vec!["ctr-1".to_string()]);
        // The fake daemon closes the stream with 137 → reader emits exit.
        wait_for(
            || emitter.events().iter().any(|(ch, _)| ch == EXIT_CHANNEL),
            "exit after kill",
        )
        .await;
        let events = emitter.events();
        let exit = events.iter().find(|(ch, _)| ch == EXIT_CHANNEL).unwrap();
        assert_eq!(exit.1["code"], 137);
        wait_for(
            || backend.runners.agents.lock().is_empty(),
            "registry forgets",
        )
        .await;
    }

    #[tokio::test]
    async fn failed_kill_restores_the_previous_state_and_remains_retryable() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        backend
            .spawn(
                spawn_config("retry-kill"),
                EmitterEventSink::new(RecordingAgentEmitter::new()),
            )
            .await
            .unwrap();
        backend.set_running("retry-kill").await.unwrap();
        *api.fail_labels.lock() = Some("ownership lookup unavailable".into());
        assert!(backend
            .kill("retry-kill")
            .await
            .unwrap_err()
            .contains("ownership lookup unavailable"));
        assert_eq!(
            backend.status("retry-kill").await,
            Some(ExternalAgentProcessState::Running)
        );
        *api.fail_labels.lock() = None;
        *api.fail_kill.lock() = Some("daemon kill unavailable".into());
        assert!(backend
            .kill("retry-kill")
            .await
            .unwrap_err()
            .contains("daemon kill unavailable"));
        assert_eq!(
            backend.status("retry-kill").await,
            Some(ExternalAgentProcessState::Running)
        );
        *api.fail_kill.lock() = None;
        backend.kill("retry-kill").await.unwrap();
        wait_for(
            || !backend.runners.contains("retry-kill"),
            "successful kill retry cleanup",
        )
        .await;
    }

    #[tokio::test]
    async fn failed_kill_does_not_overwrite_a_concurrent_exit_state() {
        let api = FakeContainerApi::new();
        let kill_gate = Arc::new(tokio::sync::Semaphore::new(0));
        let remove_gate = Arc::new(tokio::sync::Semaphore::new(0));
        *api.kill_gate.lock() = Some(kill_gate.clone());
        *api.remove_gate.lock() = Some(remove_gate.clone());
        *api.fail_kill.lock() = Some("daemon kill unavailable".into());
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        backend
            .spawn(
                spawn_config("exit-race"),
                EmitterEventSink::new(RecordingAgentEmitter::new()),
            )
            .await
            .unwrap();
        backend.set_running("exit-race").await.unwrap();
        let kill = tokio::spawn({
            let backend = backend.clone();
            async move { backend.kill("exit-race").await }
        });
        api.kill_started.notified().await;
        api.handle_events("ctr-1")
            .send(RunnerEvent::Exited { code: Some(0) })
            .unwrap();
        api.remove_started.notified().await;
        kill_gate.add_permits(1);
        assert!(kill.await.unwrap().is_err());
        assert_eq!(
            backend.status("exit-race").await,
            Some(ExternalAgentProcessState::Stopped)
        );
        remove_gate.add_permits(1);
        wait_for(
            || !backend.runners.contains("exit-race"),
            "concurrent exit cleanup",
        )
        .await;
    }

    #[tokio::test]
    async fn kill_all_covers_every_agent() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        let emitter = RecordingAgentEmitter::new();
        let mut c1 = spawn_config("m1");
        c1.cwd = Some("/workspaces/a".into());
        let mut c2 = spawn_config("m2");
        c2.cwd = Some("/workspaces/b".into());
        spawn_with_events(backend.as_ref(), emitter.clone(), c1)
            .await
            .unwrap();
        spawn_with_events(backend.as_ref(), emitter.clone(), c2)
            .await
            .unwrap();
        backend.kill_all().await.expect("kill_all");
        assert_eq!(api.kills.lock().len(), 2);
    }

    #[tokio::test]
    async fn duplicate_ids_and_missing_agents_error() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api, test_config(Some("v")));
        let emitter = RecordingAgentEmitter::new();
        spawn_with_events(backend.as_ref(), emitter.clone(), spawn_config("dup"))
            .await
            .unwrap();
        let sink = crate::exec_backend::EmitterEventSink::new(emitter.clone());
        let err = backend.spawn(spawn_config("dup"), sink).await.unwrap_err();
        assert!(err.contains("already exists"), "{err}");

        assert!(backend.send("ghost", "x").await.is_err());
        assert!(backend.kill("ghost").await.is_err());
        assert!(backend.is_running("ghost").await.is_err());
        assert!(backend.get_info("ghost").await.is_err());
        assert!(backend.set_running("ghost").await.is_err());
        assert!(backend.set_failed("ghost").await.is_err());
        assert!(backend.status("ghost").await.is_none());
    }

    #[tokio::test]
    async fn a_pending_creation_reserves_its_id_and_can_be_cancelled() {
        let api = FakeContainerApi::new();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *api.run_gate.lock() = Some(gate.clone());
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        let first = tokio::spawn({
            let backend = backend.clone();
            async move {
                backend
                    .spawn(
                        spawn_config("pending"),
                        EmitterEventSink::new(RecordingAgentEmitter::new()),
                    )
                    .await
            }
        });
        api.run_started.notified().await;
        assert_eq!(
            backend.status("pending").await,
            Some(ExternalAgentProcessState::Starting)
        );
        let duplicate = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            backend.spawn(
                spawn_config("pending"),
                EmitterEventSink::new(RecordingAgentEmitter::new()),
            ),
        )
        .await
        .expect("duplicate must not enter daemon create");
        assert!(duplicate.unwrap_err().contains("already exists"));
        backend.kill("pending").await.unwrap();
        assert!(first.await.unwrap().unwrap_err().contains("cancelled"));
        assert_eq!(
            backend.status("pending").await,
            Some(ExternalAgentProcessState::Stopping)
        );
        assert!(api.specs.lock().is_empty());
        gate.add_permits(1);
        wait_for(
            || !backend.runners.contains("pending"),
            "cancelled creation cleanup completes before id reuse",
        )
        .await;
        assert!(api.removes.lock().contains(&"ctr-1".to_string()));
        gate.add_permits(1);
        backend
            .spawn(
                spawn_config("pending"),
                EmitterEventSink::new(RecordingAgentEmitter::new()),
            )
            .await
            .unwrap();
        backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn aborted_creation_releases_its_id_for_retry() {
        let api = FakeContainerApi::new();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *api.run_gate.lock() = Some(gate.clone());
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        let first = tokio::spawn({
            let backend = backend.clone();
            async move {
                backend
                    .spawn(
                        spawn_config("abort"),
                        EmitterEventSink::new(RecordingAgentEmitter::new()),
                    )
                    .await
            }
        });
        api.run_started.notified().await;
        assert_eq!(backend.list().await, vec!["abort".to_string()]);
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        assert_eq!(
            backend.status("abort").await,
            Some(ExternalAgentProcessState::Stopping)
        );
        assert!(backend
            .spawn(
                spawn_config("abort"),
                EmitterEventSink::new(RecordingAgentEmitter::new())
            )
            .await
            .unwrap_err()
            .contains("already exists"));
        gate.add_permits(1);
        wait_for(
            || !backend.runners.contains("abort"),
            "aborted creation cleanup",
        )
        .await;
        assert!(api.removes.lock().contains(&"ctr-1".to_string()));
        *api.run_gate.lock() = None;
        backend
            .spawn(
                spawn_config("abort"),
                EmitterEventSink::new(RecordingAgentEmitter::new()),
            )
            .await
            .unwrap();
        backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_after_daemon_completion_before_handoff_removes_the_runner() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        backend
            .spawn(
                spawn_config("handoff"),
                EmitterEventSink::new(RecordingAgentEmitter::new()),
            )
            .await
            .unwrap();
        let spec = api.specs.lock()[0].clone();
        let ready = Arc::new(tokio::sync::Notify::new());
        let worker_api = api.clone();
        let worker_ready = ready.clone();
        let mut handoff = Box::pin(handoff_started_runner(api.clone(), async move {
            let running = worker_api.run(spec).await;
            worker_ready.notify_one();
            running
        }));
        // Poll only to launch the worker, never to accept its result.
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(handoff.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        ready.notified().await;
        drop(handoff);
        wait_for(
            || api.removes.lock().contains(&"ctr-2".to_string()),
            "unaccepted runner cleanup",
        )
        .await;
        assert!(!api.removes.lock().contains(&"ctr-1".to_string()));
        backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn normal_exit_keeps_the_id_reserved_until_daemon_cleanup_finishes() {
        let api = FakeContainerApi::new();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *api.remove_gate.lock() = Some(gate.clone());
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        let emitter = RecordingAgentEmitter::new();
        backend
            .spawn(spawn_config("same"), EmitterEventSink::new(emitter.clone()))
            .await
            .unwrap();
        api.handle_events("ctr-1")
            .send(RunnerEvent::Exited { code: Some(0) })
            .unwrap();
        api.remove_started.notified().await;
        assert!(emitter
            .events()
            .iter()
            .any(|(channel, _)| channel == EXIT_CHANNEL));
        assert_eq!(
            backend.status("same").await,
            Some(ExternalAgentProcessState::Stopped)
        );
        assert!(backend
            .spawn(spawn_config("same"), EmitterEventSink::new(emitter.clone()))
            .await
            .unwrap_err()
            .contains("already exists"));
        assert_eq!(api.specs.lock().len(), 1);
        gate.add_permits(1);
        wait_for(
            || !backend.runners.contains("same"),
            "normal exit cleanup releases id",
        )
        .await;
        *api.remove_gate.lock() = None;
        backend
            .spawn(spawn_config("same"), EmitterEventSink::new(emitter))
            .await
            .unwrap();
        backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn failed_normal_exit_cleanup_stays_reserved_and_kill_all_retries_it() {
        let api = FakeContainerApi::new();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *api.remove_gate.lock() = Some(gate.clone());
        *api.fail_remove.lock() = Some("daemon temporarily unavailable".into());
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        backend
            .spawn(
                spawn_config("cleanup"),
                EmitterEventSink::new(RecordingAgentEmitter::new()),
            )
            .await
            .unwrap();
        api.handle_events("ctr-1")
            .send(RunnerEvent::Exited { code: Some(0) })
            .unwrap();
        api.remove_started.notified().await;
        gate.add_permits(1);
        // This explicit retry observes the same daemon error and must retain
        // the stopped state so a later retry can recover without a restart.
        *api.remove_gate.lock() = None;
        let error = backend.kill("cleanup").await.unwrap_err();
        assert!(error.contains("daemon temporarily unavailable"));
        assert_eq!(
            backend.status("cleanup").await,
            Some(ExternalAgentProcessState::Stopped)
        );
        assert!(backend
            .spawn(
                spawn_config("cleanup"),
                EmitterEventSink::new(RecordingAgentEmitter::new())
            )
            .await
            .unwrap_err()
            .contains("already exists"));
        *api.fail_remove.lock() = None;
        backend.kill_all().await.unwrap();
        assert!(backend.list().await.is_empty());
        assert!(api.labels_by_container.lock().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn kill_during_exit_delivery_cannot_release_the_id_early() {
        struct ExitBarrierSink {
            entered: tokio::sync::Notify,
            resume: Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl ExternalAgentEventSink for ExitBarrierSink {
            fn stdout_line(&self, _id: &str, _line: &str) {}
            fn stderr_line(&self, _id: &str, _line: &str) {}
            fn exited(&self, _id: &str, _code: Option<i32>, _signal: Option<String>) {
                self.entered.notify_one();
                self.resume
                    .lock()
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
            }
        }
        let (resume, receiver) = std::sync::mpsc::channel();
        let sink = Arc::new(ExitBarrierSink {
            entered: tokio::sync::Notify::new(),
            resume: Mutex::new(receiver),
        });
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        backend
            .spawn(spawn_config("exit-event"), sink.clone())
            .await
            .unwrap();
        api.handle_events("ctr-1")
            .send(RunnerEvent::Exited { code: Some(0) })
            .unwrap();
        sink.entered.notified().await;
        let killed = backend.kill("exit-event").await;
        let kept_reserved = backend.runners.contains("exit-event");
        let removed_before_exit = !api.removes.lock().is_empty();
        resume.send(()).unwrap();
        killed.unwrap();
        assert!(
            kept_reserved,
            "kill must retain id while the old exit event is being delivered"
        );
        assert!(!removed_before_exit);
        wait_for(
            || !backend.runners.contains("exit-event"),
            "exit delivery and cleanup complete",
        )
        .await;
    }

    #[tokio::test]
    async fn an_old_collector_never_removes_a_replacement_runner() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        let sink = EmitterEventSink::new(RecordingAgentEmitter::new());
        backend
            .spawn(spawn_config("same"), sink.clone())
            .await
            .unwrap();
        let spec = api.specs.lock()[0].clone();
        let replacement = api.run(spec).await.unwrap();
        backend
            .runners
            .adopt(spawn_config("same"), replacement, None, sink);
        api.handle_events("ctr-1")
            .send(RunnerEvent::Exited { code: Some(0) })
            .unwrap();
        wait_for(
            || api.removes.lock().contains(&"ctr-1".to_string()),
            "old collector cleanup",
        )
        .await;
        assert_eq!(
            backend.get_info("same").await.unwrap()["containerId"],
            "ctr-2"
        );
        assert!(!api.removes.lock().contains(&"ctr-2".to_string()));
        backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn delayed_old_session_cleanup_cannot_remove_replacement_in_same_container() {
        struct SessionCleanup {
            calls: std::sync::atomic::AtomicUsize,
            entered: tokio::sync::Notify,
            completed: tokio::sync::Notify,
            gate: tokio::sync::Semaphore,
        }
        #[async_trait]
        impl ContainerApi for SessionCleanup {
            async fn run(&self, _: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
                Err(RunnerRunError::Other("unused".into()))
            }
            async fn pull_image(&self, _: &str) -> Result<(), String> {
                Err("unused".into())
            }
            async fn kill(&self, _: &str) -> Result<(), String> {
                Ok(())
            }
            async fn labels(&self, _: &str) -> Result<Option<BTreeMap<String, String>>, String> {
                Ok(Some(ownership_labels("workspace", "host", "deployment")))
            }
            async fn list_owned(&self) -> Result<Vec<OwnedContainer>, String> {
                Ok(Vec::new())
            }
            async fn remove(&self, _: &str) -> Result<(), String> {
                if self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    self.entered.notify_one();
                    self.gate.acquire().await.unwrap().forget();
                    self.completed.notify_one();
                }
                Ok(())
            }
        }
        fn session() -> (RunningRunner, mpsc::UnboundedSender<RunnerEvent>) {
            let (events, receiver) = mpsc::unbounded_channel();
            let (stdin, _) = mpsc::unbounded_channel();
            (
                RunningRunner {
                    container_id: "shared-workspace-container".into(),
                    events: receiver.into(),
                    stdin: stdin.into(),
                },
                events,
            )
        }
        let cleanup = Arc::new(SessionCleanup {
            calls: std::sync::atomic::AtomicUsize::new(0),
            entered: tokio::sync::Notify::new(),
            completed: tokio::sync::Notify::new(),
            gate: tokio::sync::Semaphore::new(0),
        });
        let registry = RunnerRegistry::new(cleanup.clone());
        let sink = EmitterEventSink::new(RecordingAgentEmitter::new());
        let (old, old_events) = session();
        registry.adopt_scoped(
            spawn_config("same"),
            old,
            None,
            sink.clone(),
            cleanup.clone(),
        );
        old_events
            .send(RunnerEvent::Exited { code: Some(0) })
            .unwrap();
        cleanup.entered.notified().await;
        registry.kill("same").await.unwrap();
        assert!(!registry.contains("same"));
        let (new, new_events) = session();
        registry.adopt_scoped(spawn_config("same"), new, None, sink, cleanup.clone());
        cleanup.gate.add_permits(1);
        cleanup.completed.notified().await;
        assert!(
            registry.contains("same"),
            "old collector removed the replacement session"
        );
        new_events
            .send(RunnerEvent::Exited { code: Some(0) })
            .unwrap();
        wait_for(|| !registry.contains("same"), "replacement session cleanup").await;
    }

    #[tokio::test]
    async fn missing_image_is_pulled_once_then_spawn_retries() {
        let api = FakeContainerApi::new();
        *api.missing_image.lock() = true;
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        let emitter = RecordingAgentEmitter::new();
        let id = spawn_with_events(backend.as_ref(), emitter.clone(), spawn_config("pull-1"))
            .await
            .expect("spawn after auto-pull");
        assert_eq!(id, "pull-1");
        assert_eq!(
            api.pulls.lock().clone(),
            vec!["ghcr.io/example/cognia-runner:test".to_string()]
        );
        // The retry actually created the runner.
        assert_eq!(api.specs.lock().len(), 1);
        assert_eq!(backend.is_running(&id).await, Ok(true));
    }

    #[tokio::test]
    async fn failed_pull_fails_the_spawn() {
        let api = FakeContainerApi::new();
        *api.missing_image.lock() = true;
        *api.fail_pull.lock() = Some("registry unreachable".into());
        let backend = ContainerBackend::new(api.clone(), test_config(Some("v")));
        let emitter = RecordingAgentEmitter::new();
        let err = spawn_with_events(backend.as_ref(), emitter.clone(), spawn_config("pull-2"))
            .await
            .unwrap_err();
        assert!(err.contains("registry unreachable"), "{err}");
        assert!(api.pulls.lock().is_empty());
        let events = emitter.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1["state"], "Failed");
    }

    #[tokio::test]
    async fn run_failure_bubbles_and_choreography_reports_failed() {
        let api = FakeContainerApi::new();
        *api.fail_run.lock() = Some("no such image".into());
        let backend = ContainerBackend::new(api, test_config(Some("v")));
        let emitter = RecordingAgentEmitter::new();
        let err = spawn_with_events(backend.as_ref(), emitter.clone(), spawn_config("f1"))
            .await
            .unwrap_err();
        assert!(err.contains("no such image"));
        let events = emitter.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1["state"], "Failed");
    }

    #[tokio::test]
    async fn set_running_and_set_failed_transition_state() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api, test_config(Some("v")));
        let sink = crate::exec_backend::EmitterEventSink::new(RecordingAgentEmitter::new());
        backend.spawn(spawn_config("s1"), sink).await.unwrap();
        assert_eq!(
            backend.status("s1").await,
            Some(ExternalAgentProcessState::Starting)
        );
        backend.set_running("s1").await.unwrap();
        assert_eq!(backend.is_running("s1").await, Ok(true));
        backend.set_failed("s1").await.unwrap();
        assert_eq!(
            backend.status("s1").await,
            Some(ExternalAgentProcessState::Failed)
        );
    }

    // ── Config parsing ───────────────────────────────────────────────────────

    #[test]
    fn line_buffer_handles_split_crlf_and_flush() {
        let mut buf = LineBuffer::new();
        assert!(buf.push(b"hel").is_empty());
        assert_eq!(buf.push(b"lo\r\nwor"), vec!["hello".to_string()]);
        assert_eq!(buf.push(b"ld\n"), vec!["world".to_string()]);
        assert_eq!(buf.flush(), None);
        buf.push(b"tail");
        assert_eq!(buf.flush(), Some("tail".to_string()));
    }

    #[test]
    fn sanitize_container_name_replaces_unsafe_chars() {
        assert_eq!(sanitize_container_name("a/b:c 1"), "cognia-agent-a-b-c-1");
        assert_eq!(
            sanitize_container_name("ok_id.9-x"),
            "cognia-agent-ok_id.9-x"
        );
    }

    // Env-based tests mutate process env — serialize them via the crate's
    // shared test lock (see `crate::test_env_lock`).
    use crate::test_env_lock::env_lock;

    #[tokio::test]
    async fn config_from_env_requires_image_and_workspace() {
        let _guard = env_lock().await;
        std::env::remove_var(RUNNER_IMAGE_ENV);
        std::env::remove_var(WORKSPACES_DIR_ENV);
        assert!(ContainerBackendConfig::from_env("deployment-test")
            .unwrap_err()
            .contains(RUNNER_IMAGE_ENV));
        std::env::set_var(RUNNER_IMAGE_ENV, "img");
        assert!(ContainerBackendConfig::from_env("deployment-test")
            .unwrap_err()
            .contains(WORKSPACES_DIR_ENV));
        std::env::set_var(WORKSPACES_DIR_ENV, "/workspaces");
        std::env::set_var(WORKSPACES_VOLUME_ENV, "vol");
        std::env::set_var(RUNNER_MEMORY_MB_ENV, "1024");
        std::env::set_var(RUNNER_CPUS_ENV, "1.5");
        std::env::set_var(RUNNER_PIDS_ENV, "128");
        std::env::remove_var(RUNNER_SECCOMP_ENV);
        let config = ContainerBackendConfig::from_env("deployment-test").expect("config");
        assert_eq!(config.image, "img");
        assert_eq!(config.workspaces_volume.as_deref(), Some("vol"));
        assert_eq!(config.memory_bytes, 1024 * 1024 * 1024);
        assert_eq!(config.nano_cpus, 1_500_000_000);
        assert_eq!(config.pids_limit, 128);
        assert_eq!(config.network_mode, "bridge");
        assert_eq!(config.deployment_id, "deployment-test");
        // The operator's explicit deployment id wins over the derived default,
        // and a malformed one is a boot error rather than a mangled label.
        std::env::set_var(DEPLOYMENT_ID_ENV, " tenant-b ");
        assert_eq!(
            ContainerBackendConfig::from_env("deployment-test")
                .expect("config")
                .deployment_id,
            "tenant-b"
        );
        std::env::set_var(DEPLOYMENT_ID_ENV, "tenant b");
        assert!(ContainerBackendConfig::from_env("deployment-test")
            .unwrap_err()
            .contains(DEPLOYMENT_ID_ENV));
        std::env::remove_var(DEPLOYMENT_ID_ENV);
        assert!(ContainerBackendConfig::from_env("")
            .unwrap_err()
            .contains("default deployment id"));
        // Unreadable seccomp path fails loudly.
        std::env::set_var(RUNNER_SECCOMP_ENV, "definitely-missing-profile.json");
        assert!(ContainerBackendConfig::from_env("deployment-test")
            .unwrap_err()
            .contains(RUNNER_SECCOMP_ENV));
        std::env::remove_var(RUNNER_SECCOMP_ENV);
        std::env::remove_var(RUNNER_IMAGE_ENV);
        std::env::remove_var(WORKSPACES_DIR_ENV);
        std::env::remove_var(WORKSPACES_VOLUME_ENV);
        std::env::remove_var(RUNNER_MEMORY_MB_ENV);
        std::env::remove_var(RUNNER_CPUS_ENV);
        std::env::remove_var(RUNNER_PIDS_ENV);
    }

    #[tokio::test]
    async fn exec_backend_from_env_selection() {
        let _guard = env_lock().await;
        std::env::remove_var(EXEC_BACKEND_ENV);
        assert_eq!(
            exec_backend_from_env("deployment-test")
                .expect("default")
                .kind(),
            "local-process"
        );
        std::env::set_var(EXEC_BACKEND_ENV, "local-process");
        assert_eq!(
            exec_backend_from_env("deployment-test")
                .expect("local")
                .kind(),
            "local-process"
        );
        std::env::set_var(EXEC_BACKEND_ENV, "warp-drive");
        match exec_backend_from_env("deployment-test") {
            Err(err) => assert!(err.contains("warp-drive"), "{err}"),
            Ok(_) => panic!("unknown backend value must be rejected"),
        }
        std::env::set_var(EXEC_BACKEND_ENV, "container");
        // Without the feature: a build error message. With it: a config
        // error (no image env set here) — either way container mode never
        // silently degrades to local processes.
        std::env::remove_var(RUNNER_IMAGE_ENV);
        assert!(exec_backend_from_env("deployment-test").is_err());
        // Same contract for the kubernetes flavor (feature `k8s-exec` /
        // missing config): loud failure, no silent local-process fallback.
        std::env::set_var(EXEC_BACKEND_ENV, "kubernetes");
        assert!(exec_backend_from_env("deployment-test").is_err());
        std::env::remove_var(EXEC_BACKEND_ENV);
    }
}

// Real-daemon integration test (WSL2 / Linux CI): needs a Docker daemon and
// `COGNIA_TEST_DOCKER=1`; uses a stock alpine image as the "runner".
#[cfg(all(test, feature = "container-exec"))]
mod docker_integration {
    use super::*;
    use crate::exec_backend::test_support::RecordingAgentEmitter;
    use crate::exec_backend::{spawn_with_events, EXIT_CHANNEL, STDOUT_CHANNEL};

    #[tokio::test]
    async fn echo_roundtrip_against_a_real_daemon() {
        if std::env::var("COGNIA_TEST_DOCKER").ok().as_deref() != Some("1") {
            eprintln!("skip: COGNIA_TEST_DOCKER!=1");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let config = ContainerBackendConfig {
            image: std::env::var(RUNNER_IMAGE_ENV).unwrap_or_else(|_| "alpine:3.20".into()),
            workspaces_dir: tmp.path().to_path_buf(),
            workspaces_volume: None,
            seccomp_json: None,
            memory_bytes: 256 * 1024 * 1024,
            nano_cpus: 1_000_000_000,
            pids_limit: 64,
            network_mode: "none".into(),
            deployment_id: "docker-integration-test".into(),
        };
        let api = bollard_api::BollardContainerApi::connect().expect("docker");
        let backend = ContainerBackend::new(api, config);
        let emitter = RecordingAgentEmitter::new();
        let spawn = ExternalAgentSpawnConfig {
            id: format!("it-{}", std::process::id()),
            command: "sh".into(),
            args: vec![
                "-c".into(),
                "while read line; do echo \"echo:$line\"; done".into(),
            ],
            env: HashMap::new(),
            cwd: Some(tmp.path().display().to_string()),
            framing: Default::default(),
            sandbox: None,
        };
        let id = spawn_with_events(backend.as_ref(), emitter.clone(), spawn)
            .await
            .expect("spawn");
        backend.send(&id, "ping").await.expect("send");
        let mut saw = false;
        for _ in 0..200 {
            if emitter
                .events()
                .iter()
                .any(|(ch, p)| ch == STDOUT_CHANNEL && p["data"] == "echo:ping")
            {
                saw = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(saw, "stdin → stdout roundtrip through the container");
        backend.kill(&id).await.expect("kill");
        for _ in 0..200 {
            if emitter.events().iter().any(|(ch, _)| ch == EXIT_CHANNEL) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("no exit event after kill");
    }

    /// The per-tier confinement proof for container runners: the host's
    /// Docker socket is never mounted, so it cannot be reached from inside —
    /// a container that could reach it would be root on the host's daemon.
    #[tokio::test]
    async fn docker_socket_is_unreachable_inside_a_runner() {
        if std::env::var("COGNIA_TEST_DOCKER").ok().as_deref() != Some("1") {
            eprintln!("skip: COGNIA_TEST_DOCKER!=1");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let config = ContainerBackendConfig {
            image: std::env::var(RUNNER_IMAGE_ENV).unwrap_or_else(|_| "alpine:3.20".into()),
            workspaces_dir: tmp.path().to_path_buf(),
            workspaces_volume: None,
            seccomp_json: None,
            memory_bytes: 256 * 1024 * 1024,
            nano_cpus: 1_000_000_000,
            pids_limit: 64,
            network_mode: "none".into(),
            deployment_id: "docker-integration-test".into(),
        };
        let api = bollard_api::BollardContainerApi::connect().expect("docker");
        let backend = ContainerBackend::new(api, config);
        let emitter = RecordingAgentEmitter::new();
        let spawn = ExternalAgentSpawnConfig {
            id: format!("it-sock-{}", std::process::id()),
            command: "sh".into(),
            args: vec![
                "-c".into(),
                "test ! -e /var/run/docker.sock && test ! -S ~/.docker/run/docker.sock".into(),
            ],
            env: HashMap::new(),
            cwd: Some(tmp.path().display().to_string()),
            framing: Default::default(),
            sandbox: None,
        };
        spawn_with_events(backend.as_ref(), emitter.clone(), spawn)
            .await
            .expect("spawn");
        for _ in 0..200 {
            if let Some((_, payload)) = emitter.events().iter().find(|(ch, _)| ch == EXIT_CHANNEL) {
                assert_eq!(
                    payload["code"], 0,
                    "the host's docker socket is reachable inside the runner"
                );
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("no exit event for the socket probe");
    }

    /// Real-daemon lifecycle checks use an already-present image. No pull or
    /// daemon-global configuration changes are needed to exercise cleanup.
    #[tokio::test]
    async fn failed_and_cancelled_creation_leave_no_daemon_containers() {
        if std::env::var("COGNIA_TEST_DOCKER").ok().as_deref() != Some("1") {
            eprintln!("skip: COGNIA_TEST_DOCKER!=1");
            return;
        }
        let api: Arc<dyn ContainerApi> = bollard_api::BollardContainerApi::connect().unwrap();
        let instance = default_instance_id();
        let id = format!("cleanup-{}", instance);
        let tmp = tempfile::tempdir().unwrap();
        let spec = RunnerSpec {
            name: sanitize_container_name(&id),
            image: std::env::var(RUNNER_IMAGE_ENV)
                .expect("set an already-present COGNIA_RUNNER_IMAGE"),
            cmd: vec!["/bin/sh".into(), "-c".into(), "cat".into()],
            env: vec![],
            working_dir: WORKSPACE_TARGET.into(),
            // Lifecycle checks do not require host files; this also runs
            // against a VM daemon where the host temp directory is not shared.
            mount: None,
            seccomp_json: None,
            memory_bytes: 256 * 1024 * 1024,
            nano_cpus: 1_000_000_000,
            pids_limit: 64,
            network_mode: "none".into(),
            labels: ownership_labels(&id, &instance, "docker-lifecycle-test"),
            entrypoint: Some(vec![]),
            user: None,
            extra_mounts: vec![],
            runtime: None,
            cap_drop: vec!["ALL".into()],
            cap_add: vec![],
            read_only_rootfs: false,
            tmpfs: vec![],
            writable_dirs: vec![],
        };
        let mut invalid = spec.clone();
        invalid.cmd = vec!["/definitely-not-an-installed-executable".into()];
        let error = match api.run(invalid).await {
            Ok(runner) => {
                api.remove(&runner.container_id).await.unwrap();
                panic!("invalid command unexpectedly started");
            }
            Err(error) => error.into_message(),
        };
        assert!(error.contains("start_container failed"), "{error}");
        assert!(!api
            .list_owned()
            .await
            .unwrap()
            .iter()
            .any(|container| container.labels.get(AGENT_ID_LABEL) == Some(&id)));

        let (created_tx, created_rx) = tokio::sync::oneshot::channel();
        let resume = Arc::new(tokio::sync::Notify::new());
        let worker_resume = resume.clone();
        let worker_api = api.clone();
        let cancel_spec = spec.clone();
        let pending = tokio::spawn(handoff_started_runner(api.clone(), async move {
            let running = worker_api.run(cancel_spec).await?;
            let _ = created_tx.send(running.container_id.clone());
            worker_resume.notified().await;
            Ok(running)
        }));
        let cancelled_id = created_rx.await.unwrap();
        pending.abort();
        assert!(matches!(pending.await, Err(error) if error.is_cancelled()));
        resume.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while api.labels(&cancelled_id).await.unwrap().is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cancelled container cleanup");

        let mut final_spec = spec;
        final_spec.cmd = vec!["/bin/sh".into(), "-c".into(), "printf 'ready\\n'".into()];
        let running = api.run(final_spec).await.unwrap();
        let container_id = running.container_id.clone();
        let registry = RunnerRegistry::new(api.clone());
        let _reservation = registry.reserve(&id).unwrap();
        registry.adopt(
            ExternalAgentSpawnConfig {
                id: id.clone(),
                command: "/bin/sh".into(),
                args: vec![],
                env: HashMap::new(),
                cwd: Some(tmp.path().display().to_string()),
                framing: Default::default(),
                sandbox: None,
            },
            running,
            None,
            crate::exec_backend::EmitterEventSink::new(RecordingAgentEmitter::new()),
        );
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while api.labels(&container_id).await.unwrap().is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("adopted exit cleanup");
        assert!(registry.list().is_empty());
    }
}
