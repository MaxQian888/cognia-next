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

use std::collections::HashMap;
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
}

impl ContainerBackendConfig {
    /// Resolve from the environment. Fails loudly on a missing image or an
    /// unreadable seccomp profile — a silently-degraded T2 boot is the bug.
    pub fn from_env() -> Result<Self, String> {
        let image = std::env::var(RUNNER_IMAGE_ENV)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| format!("{RUNNER_IMAGE_ENV} is required in container exec mode"))?;
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
            image,
            workspaces_dir,
            workspaces_volume,
            seccomp_json,
            memory_bytes: memory_mb.saturating_mul(1024 * 1024),
            nano_cpus: (cpus * 1_000_000_000f64) as i64,
            pids_limit: pids,
            network_mode,
        })
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

/// Everything the daemon needs to run one agent container.
#[derive(Clone, Debug)]
pub struct RunnerSpec {
    pub name: String,
    pub image: String,
    pub cmd: Vec<String>,
    /// `KEY=VALUE`, sorted for determinism.
    pub env: Vec<String>,
    pub working_dir: String,
    pub mount: RunnerMount,
    pub seccomp_json: Option<String>,
    pub memory_bytes: i64,
    pub nano_cpus: i64,
    pub pids_limit: i64,
    pub network_mode: String,
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

/// A started container with attached stdio.
pub struct RunningRunner {
    pub container_id: String,
    pub events: mpsc::UnboundedReceiver<RunnerEvent>,
    pub stdin: mpsc::UnboundedSender<Vec<u8>>,
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
}

// ---------------------------------------------------------------------------
// ContainerBackend — the ExecBackend state machine
// ---------------------------------------------------------------------------

struct AgentEntry {
    container_id: String,
    state: ExternalAgentProcessState,
    stdin: mpsc::UnboundedSender<Vec<u8>>,
    config: ExternalAgentSpawnConfig,
    exit_code: Option<i64>,
}

pub struct ContainerBackend {
    api: Arc<dyn ContainerApi>,
    config: ContainerBackendConfig,
    agents: Arc<Mutex<HashMap<String, AgentEntry>>>,
}

impl ContainerBackend {
    pub fn new(api: Arc<dyn ContainerApi>, config: ContainerBackendConfig) -> Arc<Self> {
        Arc::new(Self {
            api,
            config,
            agents: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Resolve the workspace mount for `cwd`. In volume mode the cwd must
    /// live under the workspace root (the SpawnPolicy already canonicalizes;
    /// this is defense in depth for direct callers).
    fn resolve_mount(&self, cwd: &str) -> Result<RunnerMount, String> {
        match &self.config.workspaces_volume {
            Some(volume) => {
                let rel = Path::new(cwd)
                    .strip_prefix(&self.config.workspaces_dir)
                    .map_err(|_| {
                        format!(
                            "cwd {cwd} is outside the workspace root {}",
                            self.config.workspaces_dir.display()
                        )
                    })?;
                let subpath = rel
                    .to_string_lossy()
                    .replace('\\', "/")
                    .trim_matches('/')
                    .to_string();
                Ok(RunnerMount::Volume {
                    volume: volume.clone(),
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
}

fn sanitize_container_name(agent_id: &str) -> String {
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
        if self.agents.lock().contains_key(&id) {
            return Err(format!("Agent {id} already exists"));
        }
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
            mount,
            seccomp_json: self.config.seccomp_json.clone(),
            memory_bytes: self.config.memory_bytes,
            nano_cpus: self.config.nano_cpus,
            pids_limit: self.config.pids_limit,
            network_mode: self.config.network_mode.clone(),
        };

        let running = match self.api.run(spec.clone()).await {
            Ok(running) => running,
            Err(RunnerRunError::ImageMissing(_)) => {
                // Pull once, retry once. A second miss (or a pull failure)
                // is terminal — no loop, no backoff: spawn latency is user-
                // visible and the caller can retry.
                self.api.pull_image(&self.config.image).await?;
                self.api
                    .run(spec)
                    .await
                    .map_err(RunnerRunError::into_message)?
            }
            Err(err) => return Err(err.into_message()),
        };
        let container_id = running.container_id.clone();
        self.agents.lock().insert(
            id.clone(),
            AgentEntry {
                container_id: container_id.clone(),
                state: ExternalAgentProcessState::Starting,
                stdin: running.stdin,
                config,
                exit_code: None,
            },
        );

        // Reader: demuxed chunks → line events → sink; Exited → choreography
        // parity with the local supervisor (Stopped + exit via the sink, then
        // the registry forgets the id and the container is removed).
        let agents = Arc::clone(&self.agents);
        let api = Arc::clone(&self.api);
        let agent_id = id.clone();
        let mut events = running.events;
        tokio::spawn(async move {
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
            let container_id = {
                let mut map = agents.lock();
                if let Some(entry) = map.get_mut(&agent_id) {
                    entry.state = ExternalAgentProcessState::Stopped;
                    entry.exit_code = exit_code;
                }
                map.remove(&agent_id).map(|e| e.container_id)
            };
            sink.exited(&agent_id, exit_code.map(|c| c as i32), None);
            if let Some(cid) = container_id {
                let _ = api.remove(&cid).await;
            }
        });

        Ok(id)
    }

    async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let stdin = {
            let map = self.agents.lock();
            let entry = map.get(id).ok_or(format!("Agent {id} not found"))?;
            entry.stdin.clone()
        };
        let mut bytes = message.as_bytes().to_vec();
        bytes.push(b'\n');
        stdin
            .send(bytes)
            .map_err(|_| format!("Agent {id} stdin is closed"))
    }

    async fn kill(&self, id: &str) -> Result<(), String> {
        let container_id = {
            let mut map = self.agents.lock();
            let entry = map.get_mut(id).ok_or(format!("Agent {id} not found"))?;
            entry.state = ExternalAgentProcessState::Stopping;
            entry.container_id.clone()
        };
        // The attached-stream reader observes the exit and emits
        // Stopped + exit + registry cleanup; remove() here is idempotent
        // backup for a reader that already finished.
        self.api.kill(&container_id).await?;
        Ok(())
    }

    async fn kill_all(&self) -> Result<(), String> {
        let ids: Vec<String> = self.agents.lock().keys().cloned().collect();
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

    async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        self.agents.lock().get(id).map(|e| e.state.clone())
    }

    async fn list(&self) -> Vec<String> {
        self.agents.lock().keys().cloned().collect()
    }

    async fn is_running(&self, id: &str) -> Result<bool, String> {
        self.agents
            .lock()
            .get(id)
            .map(|e| e.state == ExternalAgentProcessState::Running)
            .ok_or(format!("Agent {id} not found"))
    }

    async fn get_info(&self, id: &str) -> Result<Value, String> {
        let map = self.agents.lock();
        let entry = map.get(id).ok_or(format!("Agent {id} not found"))?;
        // Same shape as the local process manager, plus the container id
        // (`pid` has no meaning across the daemon boundary).
        Ok(json!({
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
        }))
    }

    async fn set_running(&self, id: &str) -> Result<(), String> {
        let mut map = self.agents.lock();
        let entry = map.get_mut(id).ok_or(format!("Agent {id} not found"))?;
        entry.state = ExternalAgentProcessState::Running;
        Ok(())
    }

    async fn set_failed(&self, id: &str) -> Result<(), String> {
        let mut map = self.agents.lock();
        let entry = map.get_mut(id).ok_or(format!("Agent {id} not found"))?;
        entry.state = ExternalAgentProcessState::Failed;
        Ok(())
    }

    fn kind(&self) -> &'static str {
        "container"
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
pub fn exec_backend_from_env() -> Result<Arc<dyn ExecBackend>, String> {
    match std::env::var(EXEC_BACKEND_ENV).ok().as_deref() {
        Some("container") => {
            #[cfg(feature = "container-exec")]
            {
                let config = ContainerBackendConfig::from_env()?;
                let api = bollard_api::BollardContainerApi::connect()?;
                Ok(ContainerBackend::new(api, config))
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
                let config = ContainerBackendConfig::from_env()?;
                if config.workspaces_volume.is_none() {
                    return Err(format!(
                        "{WORKSPACES_VOLUME_ENV} must name the workspaces PVC in kubernetes exec mode"
                    ));
                }
                let api = super::kube_backend::kube_api::KubeContainerApi::connect()?;
                Ok(ContainerBackend::new(api, config))
            }
            #[cfg(not(feature = "k8s-exec"))]
            {
                Err(format!(
                    "{EXEC_BACKEND_ENV}=kubernetes but this binary was built without the `k8s-exec` feature"
                ))
            }
        }
        None | Some("") | Some("local-process") => {
            Ok(super::exec_backend::LocalProcessBackend::new())
        }
        Some(other) => Err(format!("unknown {EXEC_BACKEND_ENV} value: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Bollard implementation (feature `container-exec`)
// ---------------------------------------------------------------------------

#[cfg(feature = "container-exec")]
pub mod bollard_api {
    use super::*;
    use bollard::container::LogOutput;
    use bollard::models::{
        ContainerCreateBody, HostConfig, Mount, MountTypeEnum, MountVolumeOptions,
    };
    use bollard::query_parameters::{
        AttachContainerOptionsBuilder, CreateContainerOptionsBuilder, CreateImageOptionsBuilder,
        KillContainerOptionsBuilder, RemoveContainerOptionsBuilder, StartContainerOptions,
        WaitContainerOptionsBuilder,
    };
    use bollard::Docker;
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    pub struct BollardContainerApi {
        docker: Docker,
    }

    impl BollardContainerApi {
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
                typ: Some(MountTypeEnum::VOLUME),
                source: Some(volume.clone()),
                target: Some(WORKSPACE_TARGET.to_string()),
                volume_options: Some(MountVolumeOptions {
                    subpath: subpath.clone(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            RunnerMount::Bind { host_dir } => Mount {
                typ: Some(MountTypeEnum::BIND),
                source: Some(host_dir.clone()),
                target: Some(WORKSPACE_TARGET.to_string()),
                ..Default::default()
            },
        }
    }

    #[async_trait]
    impl ContainerApi for BollardContainerApi {
        async fn run(&self, spec: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
            let mut security_opt = vec!["no-new-privileges:true".to_string()];
            if let Some(json) = &spec.seccomp_json {
                security_opt.push(format!("seccomp={json}"));
            }
            let body = ContainerCreateBody {
                image: Some(spec.image.clone()),
                cmd: Some(spec.cmd.clone()),
                env: Some(spec.env.clone()),
                working_dir: Some(spec.working_dir.clone()),
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                open_stdin: Some(true),
                stdin_once: Some(false),
                tty: Some(false),
                host_config: Some(HostConfig {
                    mounts: Some(vec![to_mount(&spec.mount)]),
                    security_opt: Some(security_opt),
                    memory: Some(spec.memory_bytes),
                    nano_cpus: Some(spec.nano_cpus),
                    pids_limit: Some(spec.pids_limit),
                    network_mode: Some(spec.network_mode.clone()),
                    ..Default::default()
                }),
                ..Default::default()
            };
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
                Err(e) => return Err(RunnerRunError::Other(format!("create_container failed: {e}"))),
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
            let attached = self
                .docker
                .attach_container(&container_id, Some(attach_options))
                .await
                .map_err(|e| RunnerRunError::Other(format!("attach_container failed: {e}")))?;

            self.docker
                .start_container(&container_id, None::<StartContainerOptions>)
                .await
                .map_err(|e| RunnerRunError::Other(format!("start_container failed: {e}")))?;

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
                events: event_rx,
                stdin: stdin_tx,
            })
        }

        async fn pull_image(&self, image: &str) -> Result<(), String> {
            let options = CreateImageOptionsBuilder::default().from_image(image).build();
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Scriptable in-memory daemon: `run` hands back channels the test
    /// drives; `kill` closes the event stream with the configured code.
    pub struct FakeContainerApi {
        pub specs: Mutex<Vec<RunnerSpec>>,
        pub kills: Mutex<Vec<String>>,
        pub removes: Mutex<Vec<String>>,
        /// Handles for containers started through this fake, by container id.
        pub handles: Mutex<HashMap<String, FakeHandle>>,
        pub fail_run: Mutex<Option<String>>,
        /// When true, `run` reports ImageMissing until `pull_image` succeeds.
        pub missing_image: Mutex<bool>,
        pub pulls: Mutex<Vec<String>>,
        pub fail_pull: Mutex<Option<String>>,
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
                handles: Mutex::new(HashMap::new()),
                fail_run: Mutex::new(None),
                missing_image: Mutex::new(false),
                pulls: Mutex::new(Vec::new()),
                fail_pull: Mutex::new(None),
                counter: Mutex::new(0),
            })
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
            if *self.missing_image.lock() {
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
            self.specs.lock().push(spec);
            let (event_tx, event_rx) = mpsc::unbounded_channel();
            let (stdin_tx, stdin_rx) = mpsc::unbounded_channel();
            self.handles.lock().insert(
                container_id.clone(),
                FakeHandle {
                    events: event_tx,
                    stdin: Mutex::new(Some(stdin_rx)),
                },
            );
            Ok(RunningRunner {
                container_id,
                events: event_rx,
                stdin: stdin_tx,
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
            self.kills.lock().push(container_id.to_string());
            // A real daemon kill terminates the attached stream — emulate by
            // sending the exit event.
            if let Some(handle) = self.handles.lock().get(container_id) {
                let _ = handle.events.send(RunnerEvent::Exited { code: Some(137) });
            }
            Ok(())
        }

        async fn remove(&self, container_id: &str) -> Result<(), String> {
            self.removes.lock().push(container_id.to_string());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::FakeContainerApi;
    use super::*;
    use crate::external_agent::exec_backend::test_support::RecordingAgentEmitter;
    use crate::external_agent::exec_backend::{
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
            RunnerMount::Volume {
                volume: "cognia_workspaces".into(),
                subpath: Some("ws-1".into())
            }
        );
        assert!(spec.seccomp_json.is_some());
        assert_eq!(spec.memory_bytes, 2048 * 1024 * 1024);
        assert_eq!(spec.nano_cpus, 2_000_000_000);
        assert_eq!(spec.pids_limit, 512);
        assert_eq!(spec.network_mode, "bridge");
        assert_eq!(backend.kind(), "container");
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
            RunnerMount::Bind {
                host_dir: "/workspaces/ws-1".into()
            }
        );
    }

    #[tokio::test]
    async fn volume_mode_rejects_cwd_outside_the_workspace_root() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api, test_config(Some("v")));
        let mut config = spawn_config("evil");
        config.cwd = Some("/etc".into());
        let sink = crate::external_agent::exec_backend::EmitterEventSink::new(
            RecordingAgentEmitter::new(),
        );
        let err = backend.spawn(config, sink).await.unwrap_err();
        assert!(err.contains("outside the workspace root"), "{err}");
    }

    #[tokio::test]
    async fn spawn_requires_a_cwd() {
        let api = FakeContainerApi::new();
        let backend = ContainerBackend::new(api, test_config(Some("v")));
        let mut config = spawn_config("no-cwd");
        config.cwd = None;
        let sink = crate::external_agent::exec_backend::EmitterEventSink::new(
            RecordingAgentEmitter::new(),
        );
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
        wait_for(|| backend.agents.lock().is_empty(), "registry cleanup").await;
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
        wait_for(|| backend.agents.lock().is_empty(), "registry forgets").await;
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
        let sink = crate::external_agent::exec_backend::EmitterEventSink::new(emitter.clone());
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
        let sink = crate::external_agent::exec_backend::EmitterEventSink::new(
            RecordingAgentEmitter::new(),
        );
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

    // Env-based tests mutate process env — serialize via the shared slot lock.

    #[tokio::test]
    async fn config_from_env_requires_image_and_workspace() {
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        std::env::remove_var(RUNNER_IMAGE_ENV);
        std::env::remove_var(WORKSPACES_DIR_ENV);
        assert!(ContainerBackendConfig::from_env()
            .unwrap_err()
            .contains(RUNNER_IMAGE_ENV));
        std::env::set_var(RUNNER_IMAGE_ENV, "img");
        assert!(ContainerBackendConfig::from_env()
            .unwrap_err()
            .contains(WORKSPACES_DIR_ENV));
        std::env::set_var(WORKSPACES_DIR_ENV, "/workspaces");
        std::env::set_var(WORKSPACES_VOLUME_ENV, "vol");
        std::env::set_var(RUNNER_MEMORY_MB_ENV, "1024");
        std::env::set_var(RUNNER_CPUS_ENV, "1.5");
        std::env::set_var(RUNNER_PIDS_ENV, "128");
        std::env::remove_var(RUNNER_SECCOMP_ENV);
        let config = ContainerBackendConfig::from_env().expect("config");
        assert_eq!(config.image, "img");
        assert_eq!(config.workspaces_volume.as_deref(), Some("vol"));
        assert_eq!(config.memory_bytes, 1024 * 1024 * 1024);
        assert_eq!(config.nano_cpus, 1_500_000_000);
        assert_eq!(config.pids_limit, 128);
        assert_eq!(config.network_mode, "bridge");
        // Unreadable seccomp path fails loudly.
        std::env::set_var(RUNNER_SECCOMP_ENV, "definitely-missing-profile.json");
        assert!(ContainerBackendConfig::from_env()
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
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        std::env::remove_var(EXEC_BACKEND_ENV);
        assert_eq!(
            exec_backend_from_env().expect("default").kind(),
            "local-process"
        );
        std::env::set_var(EXEC_BACKEND_ENV, "local-process");
        assert_eq!(
            exec_backend_from_env().expect("local").kind(),
            "local-process"
        );
        std::env::set_var(EXEC_BACKEND_ENV, "warp-drive");
        match exec_backend_from_env() {
            Err(err) => assert!(err.contains("warp-drive"), "{err}"),
            Ok(_) => panic!("unknown backend value must be rejected"),
        }
        std::env::set_var(EXEC_BACKEND_ENV, "container");
        // Without the feature: a build error message. With it: a config
        // error (no image env set here) — either way container mode never
        // silently degrades to local processes.
        std::env::remove_var(RUNNER_IMAGE_ENV);
        assert!(exec_backend_from_env().is_err());
        // Same contract for the kubernetes flavor (feature `k8s-exec` /
        // missing config): loud failure, no silent local-process fallback.
        std::env::set_var(EXEC_BACKEND_ENV, "kubernetes");
        assert!(exec_backend_from_env().is_err());
        std::env::remove_var(EXEC_BACKEND_ENV);
    }
}

// Real-daemon integration test (WSL2 / Linux CI): needs a Docker daemon and
// `COGNIA_TEST_DOCKER=1`; uses a stock alpine image as the "runner".
#[cfg(all(test, feature = "container-exec"))]
mod docker_integration {
    use super::*;
    use crate::external_agent::exec_backend::test_support::RecordingAgentEmitter;
    use crate::external_agent::exec_backend::{spawn_with_events, EXIT_CHANNEL, STDOUT_CHANNEL};

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
}
