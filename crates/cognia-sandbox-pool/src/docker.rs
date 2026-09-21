//! The Step ① sandbox driver: one container per agent on one Docker daemon
//! (ADR-0182/0183).
//!
//! A spawn that carries a placement takes this path instead of the legacy
//! runner. What happens, in order:
//!
//! 1. ask the daemon which OCI runtimes it has, so admission knows what
//!    isolation tiers can actually be attested;
//! 2. re-admit the spec ([`crate::admission`]);
//! 3. stage the agent bundle's libc-independent half into a named volume;
//! 4. run [`cognia_sandboxd`]'s `probe` inside the user's image, with that
//!    volume mounted read-only, to learn its libc, its shell, the target user
//!    and which bundled commands it can run;
//! 5. map the spawn's command onto one of those ([`crate::command`]);
//! 6. stage the probed libc tree into the volume the agent will mount;
//! 7. start the user's image with `init-agent` as its entrypoint, which
//!    switches to the target user and execs the agent with inherited stdio —
//!    so ACP over container attach works exactly as it does for the legacy
//!    runner, and [`RunnerRegistry`] handles the agent identically.
//!
//! Steps 3, 4 and 6 are skipped once their results are on the daemon: the
//! volumes are reference-counted by name and the probe is cached per (user
//! image, bundle) in the environment store.
//!
//! # Transitional in Step ①
//!
//! Two things here are deliberately weaker than ADR-0182's end state, are
//! labeled as such on the type, in the placement the UI renders, and in a test:
//!
//! - **Egress.** `off` really means no network. `allowlist` and `on` get the
//!   legacy runner's network with nothing filtering it, because the per-tenant
//!   egress proxy is ADR-0185. The placement says `egress.enforced: false`.
//! - **Agent rootfs.** Helper containers (`install`, `probe`) are closed
//!   programs and run `cap-drop ALL` + a read-only rootfs. The agent
//!   container keeps a writable rootfs: the image is user-authored, its own
//!   entrypoint conventions and mid-task package installs write where they
//!   will, and the spec has no channel yet to declare writable roots. What it
//!   does get is `cap-drop ALL` plus the few capabilities `init-agent`
//!   needs, `no-new-privileges`, and the size class's PID/CPU/memory bounds.
//!
//! Provider credentials never ride the spawn environment into a sandbox:
//! [`container_env`] drops the ambient-credential names the local launcher
//! clears (`cognia_sandboxd::env::AMBIENT_CREDENTIAL_ENV`) before the
//! container sees them, so `init-agent` also scrubs an image-baked copy. A
//! managed gateway task's lease (`COGNIA_GATEWAY_TASK_CONFIG` /
//! `COGNIA_GATEWAY_TOKEN`) is not in that list — it is minted per task and is
//! exactly the ingress the ambient names would bypass. The placement says
//! `credentials.mode: "gateway-lease"` for such a task, `"none"` otherwise.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use cognia_environment::image::PinnedImage;
use cognia_environment::spec::{
    DeclaredUser, EgressTier, EnvironmentSpec, IsolationTier, SandboxLifecycleKind, SpecUser,
};
use cognia_external_agent::container_backend::{
    default_instance_id, deployment_id_from_env, ownership_labels, reap_owned_orphans,
    remove_owned, sanitize_container_name, ContainerApi, RegistryAuth, RunnerEvent,
    RunnerHostSettings, RunnerMount, RunnerRegistry, RunnerReservation, RunnerRunError, RunnerSpec,
    RunningRunner, SandboxDockerApi, VolumeMount, VolumeRemoval, DEPLOYMENT_LABEL, OWNER_LABEL,
    OWNER_VALUE, SCHEMA_LABEL, SCHEMA_VERSION, WORKSPACE_TARGET,
};
use cognia_external_agent::exec_backend::ExecBackend;
use cognia_external_agent::process::{
    ExternalAgentEventSink, ExternalAgentProcessState, ExternalAgentSpawnConfig,
};
use cognia_external_agent::sandbox_routing_backend::{
    SandboxExecBackend, SandboxPlacement, SandboxSpawnError,
};
use cognia_sandboxd::env::{
    encode_runtime_config_env, LifecyclePhase, RuntimeConfigV1, AMBIENT_CREDENTIAL_ENV,
};
use cognia_sandboxd::layout::{Libc, INJECTION_ROOT};
use cognia_sandboxd::passwd::UserSpec;
use cognia_sandboxd::probe::{Ownership, ProbeCode, ProbeReport, PROBE_REPORT_VERSION};
use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::admission::{AdmittedSandbox, SandboxAdmission};
use crate::command::{bundled_invocation, BundledInvocation};
use crate::probe_cache::ProbeCacheEntry;
use crate::status::SandboxDriverStatus;

mod persistent;
mod ports;

/// Label carrying the bundle digest a staged volume holds, so a sweep can tell
/// a volume for a retired bundle from one still in use.
pub const BUNDLE_DIGEST_LABEL: &str = "cognia.bundle-digest";

/// Label carrying which stage a volume holds (`core`, `glibc`, `musl`).
pub const BUNDLE_STAGE_LABEL: &str = "cognia.bundle-stage";

pub use crate::probe_cache::PROBE_CACHE_VERSION;

/// The uid a plain-container sandbox runs as when nothing declares a user
/// (ADR-0183 "Which user the agent runs as").
pub const CONTAINER_TIER_UID: u32 = 10001;

/// The OCI runtime a gVisor sandbox asks the daemon for.
pub const GVISOR_RUNTIME: &str = "runsc";

/// How this driver names itself to a console.
pub const DRIVER_NAME: &str = "docker";

/// Staging copies a few hundred MiB between local filesystems.
const STAGE_TIMEOUT: Duration = Duration::from_secs(300);

/// The probe reads a handful of files and writes one marker.
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);

/// How much of a helper container's output is kept. A probe report is a few
/// KiB; anything near this is a container printing something else entirely.
const MAX_CAPTURED_OUTPUT: usize = 1024 * 1024;

/// Bound preparation pressure, not the number of running agents. Waiting
/// spawns retain their identity and remain cancellable.
const MAX_CONCURRENT_PREPARES: usize = 4;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(30);

/// How this Host lays out sandbox containers. The workspace, limits and
/// network defaults are the legacy runner's, read from the same variables, so
/// the two can never disagree about where a workspace is.
#[derive(Clone, Debug)]
pub struct DockerSandboxConfig {
    pub deployment_id: String,
    /// Identifies THIS process on every container it creates.
    pub instance_id: String,
    pub host: RunnerHostSettings,
}

impl DockerSandboxConfig {
    pub fn from_env(default_deployment_id: &str) -> Result<Self, String> {
        Ok(Self {
            deployment_id: deployment_id_from_env(default_deployment_id)?,
            instance_id: default_instance_id(),
            host: RunnerHostSettings::from_env()?,
        })
    }
}

/// Which half of the bundle a volume holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    /// The manifest, the supervisor, the static tools and the CA bundle. What
    /// the probe needs, and all it is allowed to see.
    Core,
    /// Core plus one libc tree: what an agent mounts. Core is staged into it
    /// as well rather than nested under a second mount, so each volume the
    /// agent container mounts is self-contained.
    Libc(Libc),
}

impl Stage {
    fn suffix(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Libc(libc) => libc.as_str(),
        }
    }

    /// The `install` invocations that fill a volume of this stage, in order.
    fn installs(self) -> Vec<Vec<String>> {
        let core = vec![
            "install".to_string(),
            "--stage".to_string(),
            "core".to_string(),
        ];
        match self {
            Self::Core => vec![core],
            Self::Libc(libc) => vec![
                core,
                vec![
                    "install".to_string(),
                    "--stage".to_string(),
                    "libc".to_string(),
                    "--libc".to_string(),
                    libc.as_str().to_string(),
                ],
            ],
        }
    }
}

/// Why a helper container did not produce a result.
enum RunFailure {
    /// The image is not on the daemon and could not be pulled.
    Pull(String),
    /// The daemon refused to create or start the container.
    Start(String),
    Timeout,
}

struct Completed {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    code: Option<i64>,
}

impl Completed {
    fn stderr_tail(&self) -> String {
        let text = String::from_utf8_lossy(&self.stderr);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            String::from_utf8_lossy(&self.stdout).trim().to_string()
        } else {
            trimmed.to_string()
        }
    }
}

/// One container per agent, on one Docker daemon.
pub struct DockerSandboxBackend {
    api: Arc<dyn SandboxDockerApi>,
    /// The same daemon through the narrower trait the shared helpers take.
    container: Arc<dyn ContainerApi>,
    admission: Arc<dyn SandboxAdmission>,
    config: DockerSandboxConfig,
    runners: RunnerRegistry,
    /// One lock per bundle volume: `install` stages through a pid-derived
    /// name, and every staging container is PID 1, so two concurrent installs
    /// into one volume would share it.
    stage_locks: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
    /// Preparation holds a shared lease across gaps between Docker mounts.
    /// A sweep takes an exclusive lease before deleting a retired bundle.
    bundle_locks: Mutex<HashMap<String, Weak<tokio::sync::RwLock<()>>>>,
    prepare_slots: Arc<tokio::sync::Semaphore>,
    port_slots: Arc<tokio::sync::Semaphore>,
    own: Weak<Self>,
    /// Volumes this process has already filled. The install itself is
    /// idempotent (it records the manifest digest in a marker), so this only
    /// saves a container start.
    staged: Mutex<BTreeSet<String>>,
}

impl DockerSandboxBackend {
    pub fn new(
        api: Arc<dyn SandboxDockerApi>,
        admission: Arc<dyn SandboxAdmission>,
        config: DockerSandboxConfig,
    ) -> Arc<Self> {
        let container: Arc<dyn ContainerApi> = api.clone();
        Arc::new_cyclic(|own| Self {
            own: own.clone(),
            runners: RunnerRegistry::new(Arc::clone(&container)),
            api,
            container,
            admission,
            config,
            stage_locks: Mutex::new(HashMap::new()),
            bundle_locks: Mutex::new(HashMap::new()),
            prepare_slots: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PREPARES)),
            staged: Mutex::new(BTreeSet::new()),
            port_slots: Arc::new(tokio::sync::Semaphore::new(64)),
        })
    }

    /// Tiers this daemon can attest. A plain container always; gVisor when
    /// `runsc` is registered, which is how a single-host deployment offers the
    /// stronger tier without being configured for it (ADR-0182).
    pub async fn available_tiers(&self) -> Result<Vec<IsolationTier>, SandboxSpawnError> {
        let runtimes = self.api.runtimes().await.map_err(|error| {
            SandboxSpawnError::fault(
                "sandbox_daemon_unreachable",
                format!("the container daemon did not answer: {error}"),
            )
        })?;
        let mut tiers = vec![IsolationTier::Container];
        if runtimes.iter().any(|name| name == GVISOR_RUNTIME) {
            tiers.push(IsolationTier::Gvisor);
        }
        Ok(tiers)
    }

    fn volume_name(&self, bundle_digest: &str, stage: Stage) -> String {
        format!(
            "cognia-{}-bundle-{}-{}",
            self.config.deployment_id,
            digest12(bundle_digest),
            stage.suffix()
        )
    }

    /// Labels for a bundle volume. Unlike a container it carries no instance
    /// label: a volume is shared by every process of this deployment, which is
    /// what makes staging a once-per-bundle cost rather than a per-boot one.
    fn volume_labels(&self, bundle_digest: &str, stage: Stage) -> BTreeMap<String, String> {
        BTreeMap::from([
            (OWNER_LABEL.to_string(), OWNER_VALUE.to_string()),
            (
                DEPLOYMENT_LABEL.to_string(),
                self.config.deployment_id.clone(),
            ),
            (SCHEMA_LABEL.to_string(), SCHEMA_VERSION.to_string()),
            (BUNDLE_DIGEST_LABEL.to_string(), bundle_digest.to_string()),
            (BUNDLE_STAGE_LABEL.to_string(), stage.suffix().to_string()),
        ])
    }

    fn stage_lock(&self, volume: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.stage_locks.lock();
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(volume).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(volume.to_string(), Arc::downgrade(&lock));
        lock
    }

    fn bundle_lock(&self, digest: &str) -> Arc<tokio::sync::RwLock<()>> {
        let mut locks = self.bundle_locks.lock();
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(digest).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::RwLock::new(()));
        locks.insert(digest.to_string(), Arc::downgrade(&lock));
        lock
    }

    /// Fill (or confirm) the volume for `stage` and return its name.
    async fn ensure_staged(
        &self,
        bundle: &PinnedImage,
        stage: Stage,
        leases: OperationLeases,
    ) -> Result<String, SandboxSpawnError> {
        let volume = self.volume_name(&bundle.digest, stage);
        if self.staged.lock().contains(&volume) {
            return Ok(volume);
        }
        let lock = self.stage_lock(&volume);
        let guard = Arc::new(lock.lock_owned().await);
        if self.staged.lock().contains(&volume) {
            return Ok(volume);
        }

        self.api
            .ensure_volume(&volume, &self.volume_labels(&bundle.digest, stage))
            .await
            .map_err(|error| {
                SandboxSpawnError::fault(
                    "sandbox_volume_unavailable",
                    format!("the bundle volume {volume} could not be created: {error}"),
                )
            })?;

        let auth = self.admission.registry_auth(&bundle.registry)?;
        for install in stage.installs() {
            let spec = RunnerSpec {
                name: sanitize_container_name(&format!("stage-{volume}-{}", install[2])),
                image: bundle.canonical(),
                // The bundle image's own entrypoint is the supervisor.
                entrypoint: None,
                cmd: install
                    .iter()
                    .cloned()
                    .chain([
                        "--from".to_string(),
                        cognia_sandboxd::layout::BUNDLE_ROOT.to_string(),
                        "--to".to_string(),
                        INJECTION_ROOT.to_string(),
                    ])
                    .collect(),
                env: Vec::new(),
                working_dir: "/".to_string(),
                // No workspace: staging reads the bundle image and writes the
                // volume, and must not be able to touch project files.
                mount: None,
                seccomp_json: self.config.host.seccomp_json.clone(),
                memory_bytes: self.config.host.memory_bytes,
                nano_cpus: self.config.host.nano_cpus,
                pids_limit: self.config.host.pids_limit,
                // Nothing in `install` talks to the network; the daemon pulls.
                network_mode: "none".to_string(),
                labels: ownership_labels(
                    &format!("bundle-stage-{}", stage.suffix()),
                    &self.config.instance_id,
                    &self.config.deployment_id,
                ),
                user: Some("0".to_string()),
                extra_mounts: vec![VolumeMount {
                    volume: volume.clone(),
                    target: INJECTION_ROOT.to_string(),
                    read_only: false,
                }],
                runtime: None,
                // `install` writes only inside the mounted volume and the
                // files it creates are root-owned, so it needs no
                // capabilities and no writable rootfs at all.
                cap_drop: vec!["ALL".to_string()],
                cap_add: Vec::new(),
                read_only_rootfs: true,
                tmpfs: vec!["/tmp".to_string()],
                writable_dirs: Vec::new(),
            };
            let completed = self
                .run_once(
                    spec,
                    auth.clone(),
                    STAGE_TIMEOUT,
                    OperationLeases {
                        _stage: Some(guard.clone()),
                        ..leases.clone()
                    },
                )
                .await
                .map_err(|failure| match failure {
                    RunFailure::Pull(error) => SandboxSpawnError::fault(
                        "bundle_unavailable",
                        format!("the agent bundle image could not be pulled: {error}"),
                    ),
                    RunFailure::Start(error) => SandboxSpawnError::fault(
                        "sandbox_bundle_stage_failed",
                        format!("the bundle staging container did not start: {error}"),
                    ),
                    RunFailure::Timeout => SandboxSpawnError::fault(
                        "sandbox_bundle_stage_failed",
                        "staging the agent bundle timed out".to_string(),
                    ),
                })?;
            if completed.code != Some(0) {
                return Err(SandboxSpawnError::fault(
                    "sandbox_bundle_stage_failed",
                    format!(
                        "staging the agent bundle exited {:?}: {}",
                        completed.code,
                        completed.stderr_tail()
                    ),
                ));
            }
        }
        self.staged.lock().insert(volume.clone());
        Ok(volume)
    }

    /// The probe report for this (user image, bundle, user) — cached when one
    /// is still valid, and run in the user's image when not.
    async fn probe_image(
        &self,
        admitted: &AdmittedSandbox,
        core_volume: &str,
        mount: &RunnerMount,
        cwd: &str,
        target: (&UserSpec, bool),
        leases: OperationLeases,
    ) -> Result<ProbeReport, SandboxSpawnError> {
        let (user, match_owner) = target;
        let image = self.admission.runtime_image(&admitted.spec)?;
        let image_digest = admitted
            .spec
            .image
            .registry_image()
            .map(|image| image.digest)
            .or_else(|| admitted.spec.image.image_id().map(str::to_string))
            .expect("validated image identity");
        let bundle = admitted.admission.bundle.image();

        // Recheck after waiting: another cold spawn may have populated the
        // cache. Still validate the user and workspace owner on every hit.
        let lock = self.stage_lock(&format!("probe:{}:{}", image_digest, bundle.digest));
        let guard = Arc::new(lock.lock_owned().await);
        let owner = host_owner(Path::new(cwd));

        if let Some(entry) = self.admission.cached_probe(&image_digest, &bundle.digest) {
            if let Some(report) = cached_report(&entry, user, match_owner, owner) {
                return refuse_probe(&report).map_or(Ok(report), Err);
            }
        }

        let mut cmd = vec![
            "probe".to_string(),
            "--root".to_string(),
            "/".to_string(),
            "--bundle".to_string(),
            INJECTION_ROOT.to_string(),
            "--workspace".to_string(),
            WORKSPACE_TARGET.to_string(),
            // Print the report instead of writing it: every volume the probe
            // container mounts is read-only.
            "--out".to_string(),
            "-".to_string(),
            "--user".to_string(),
            user.to_string(),
        ];
        if match_owner {
            cmd.push("--match-workspace-owner".to_string());
        }

        let spec = RunnerSpec {
            name: sanitize_container_name(&format!("probe-{}", digest12(&image_digest))),
            image: image.clone(),
            entrypoint: Some(vec![format!("{INJECTION_ROOT}/bin/cognia-sandboxd")]),
            cmd,
            env: Vec::new(),
            working_dir: "/".to_string(),
            // The workspace is mounted as the agent will have it: permission
            // bits say nothing about a read-only mount, so the probe proves
            // writability by writing, and needs the real thing to do it.
            mount: Some(mount.clone()),
            seccomp_json: self.config.host.seccomp_json.clone(),
            memory_bytes: self.config.host.memory_bytes,
            nano_cpus: self.config.host.nano_cpus,
            pids_limit: self.config.host.pids_limit,
            network_mode: "none".to_string(),
            labels: ownership_labels(
                "image-probe",
                &self.config.instance_id,
                &self.config.deployment_id,
            ),
            // Root, so it can read `/etc/passwd` and answer for a user other
            // than itself. It reads the image and writes one marker file.
            user: Some("0".to_string()),
            extra_mounts: vec![VolumeMount {
                volume: core_volume.to_string(),
                target: INJECTION_ROOT.to_string(),
                read_only: true,
            }],
            runtime: runtime_for(admitted.admission.actual_tier),
            // The probe reads the image and writes its writability marker
            // into the workspace mount — as root, into a directory owned by
            // the target uid, which takes DAC_OVERRIDE. Everything else is
            // dropped, and nothing outside the mounts is writable.
            cap_drop: vec!["ALL".to_string()],
            cap_add: vec!["DAC_OVERRIDE".to_string()],
            read_only_rootfs: true,
            tmpfs: vec!["/tmp".to_string()],
            writable_dirs: Vec::new(),
        };

        let auth = admitted
            .spec
            .image
            .registry_image()
            .map(|image| self.admission.registry_auth(&image.registry))
            .transpose()?
            .flatten();
        let completed = self
            .run_once(
                spec,
                auth,
                PROBE_TIMEOUT,
                OperationLeases {
                    _stage: Some(guard),
                    ..leases
                },
            )
            .await
            .map_err(|failure| match failure {
                // An image that cannot be pulled is an answer about the image,
                // not about the infrastructure: running somewhere else would
                // silently do less than the project asked for.
                RunFailure::Pull(error) => SandboxSpawnError::refused(
                    "sandbox_image_unavailable",
                    format!("{} could not be pulled: {error}", image),
                ),
                RunFailure::Start(error) => SandboxSpawnError::fault(
                    "sandbox_container_start_failed",
                    format!("the probe container did not start: {error}"),
                ),
                RunFailure::Timeout => SandboxSpawnError::refused(
                    "sandbox_probe_timeout",
                    format!("probing {} timed out", image),
                ),
            })?;

        let report: Option<ProbeReport> = serde_json::from_slice(&completed.stdout).ok();
        let report = match (report, completed.code) {
            (Some(report), code)
                if report.version == PROBE_REPORT_VERSION
                    && (code == Some(0) || !report.problems.is_empty()) =>
            {
                report
            }
            // The exit code is the contract even when the report is not
            // readable (an image whose shell is the wrong architecture cannot
            // run the probe at all, and the daemon reports 126).
            (_, Some(code)) => {
                let code = ProbeCode::from_exit_code(code as i32);
                return Err(SandboxSpawnError::refused(
                    code.map(probe_code_name)
                        .unwrap_or("sandbox_probe_failed")
                        .to_string(),
                    format!(
                        "{} cannot host the agent: {}",
                        image,
                        completed.stderr_tail()
                    ),
                ));
            }
            (_, None) => {
                return Err(SandboxSpawnError::refused(
                    "sandbox_probe_failed",
                    format!("probing {} produced no result", image),
                ))
            }
        };

        // A workspace problem belongs to this workspace, not to the image, so
        // it is never what a later spawn reads back.
        if !report
            .problems
            .iter()
            .any(|problem| problem.code == ProbeCode::WorkspaceNotWritable)
        {
            self.admission.record_probe(
                &image_digest,
                &bundle.digest,
                &cache_entry(user, match_owner, owner, &report),
            );
        }
        refuse_probe(&report).map_or(Ok(report), Err)
    }

    /// Own the entire helper operation. A cancelled receiver stops waiting
    /// immediately, but the worker retains scheduling and volume leases until
    /// an already-submitted create settles and its container is removed.
    async fn run_once(
        &self,
        spec: RunnerSpec,
        auth: Option<RegistryAuth>,
        timeout: Duration,
        leases: OperationLeases,
    ) -> Result<Completed, RunFailure> {
        let backend = self.own.upgrade().expect("backend owned during operation");
        let (mut result_tx, result_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            // Never cancel a daemon create whose outcome is not yet known.
            let running = match backend.start_inner(spec, auth).await {
                Ok(running) => running,
                Err(error) => {
                    let _ = result_tx.send(Err(error));
                    return;
                }
            };
            let mut cleanup = HelperCleanup {
                api: backend.container.clone(),
                container_id: Some(running.container_id.clone()),
                leases,
            };
            let completed = tokio::select! {
                biased;
                _ = result_tx.closed() => None,
                completed = collect(running) => Some(completed),
            };
            cleanup.remove().await;
            if let Some(completed) = completed {
                let _ = result_tx.send(Ok(completed));
            }
        });
        tokio::time::timeout(timeout, result_rx)
            .await
            .map_err(|_| RunFailure::Timeout)?
            .map_err(|error| RunFailure::Start(format!("helper worker failed: {error}")))?
    }

    /// Transfer a final runner only after its receiver acknowledges ownership.
    /// The worker keeps its preparation slot through abandoned create cleanup.
    async fn start(
        &self,
        spec: RunnerSpec,
        auth: Option<RegistryAuth>,
        leases: OperationLeases,
    ) -> Result<RunningRunner, RunFailure> {
        let backend = self.own.upgrade().expect("backend owned during operation");
        let (result_tx, result_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let running = match backend.start_inner(spec, auth).await {
                Ok(running) => running,
                Err(error) => {
                    let _ = result_tx.send(Err(error));
                    return;
                }
            };
            let mut cleanup = HelperCleanup {
                api: backend.container.clone(),
                container_id: Some(running.container_id.clone()),
                leases,
            };
            let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
            let _ = result_tx.send(Ok((running, accepted_tx)));
            if accepted_rx.await.is_ok() {
                cleanup.container_id.take();
            } else {
                cleanup.remove().await;
            }
        });
        let (running, accepted) = result_rx
            .await
            .map_err(|error| RunFailure::Start(format!("sandbox worker failed: {error}")))??;
        let _ = accepted.send(());
        Ok(running)
    }

    /// Pull once for an explicit missing image, keeping each daemon request
    /// alive until it settles. Call only from an operation that owns its leases.
    async fn start_inner(
        &self,
        spec: RunnerSpec,
        auth: Option<RegistryAuth>,
    ) -> Result<RunningRunner, RunFailure> {
        match self.api.run(spec.clone()).await {
            Ok(running) => Ok(running),
            Err(RunnerRunError::ImageMissing(_)) => {
                let lock = self.stage_lock(&format!("pull:{}", spec.image));
                let _guard = lock.lock().await;
                // Another waiter may have pulled it. A failed create is
                // retried only for an explicit image-missing response.
                match self.api.run(spec.clone()).await {
                    Ok(running) => return Ok(running),
                    Err(RunnerRunError::ImageMissing(_)) => {}
                    Err(error) => return Err(RunFailure::Start(error.into_message())),
                }
                // Pull once, retry once. No loop and no backoff: spawn latency
                // is user-visible and the caller can retry.
                self.api
                    .pull_image_with_auth(&spec.image, auth)
                    .await
                    .map_err(RunFailure::Pull)?;
                self.api
                    .run(spec)
                    .await
                    .map_err(|error| RunFailure::Start(error.into_message()))
            }
            Err(error) => Err(RunFailure::Start(error.into_message())),
        }
    }

    /// Remove bundle volumes of this deployment for a bundle it no longer
    /// offers. A volume another container still mounts is not an error: the
    /// reference count is saying "not yet", and the next sweep will get it.
    /// Preparation also retains a lease between mounts, before Docker has a
    /// reference to protect. Sweeping never waits on an active preparation.
    async fn sweep_bundle_volumes(&self) -> Vec<String> {
        let offered: BTreeSet<String> = self
            .admission
            .offered_bundle_digests()
            .into_iter()
            .collect();
        let volumes = match self.api.list_owned_volumes().await {
            Ok(volumes) => volumes,
            Err(error) => {
                log::warn!("bundle volume sweep skipped: {error}");
                return Vec::new();
            }
        };
        let mut removed = Vec::new();
        for volume in volumes {
            let Some(digest) = volume.labels.get(BUNDLE_DIGEST_LABEL) else {
                continue;
            };
            if volume.labels.get(DEPLOYMENT_LABEL) != Some(&self.config.deployment_id)
                || offered.contains(digest)
            {
                continue;
            }
            let Ok(lease) = self.bundle_lock(digest).try_write_owned() else {
                continue;
            };
            // Listing volumes yields to concurrent catalog refreshes. Never
            // remove a bundle re-offered since the initial snapshot.
            if self.admission.offered_bundle_digests().contains(digest) {
                continue;
            }
            let backend = self.own.upgrade().expect("backend owned during sweep");
            // A cancelled sweep cannot release the lease while a submitted
            // deletion may still complete and race a newly admitted spawn.
            let removal = tokio::spawn(async move {
                let _lease = lease;
                // An error can mean the DELETE response was lost after the
                // daemon removed the volume. Pessimistically invalidate before
                // submission; install's on-volume marker makes restaging safe
                // when the volume actually survived (for example, InUse).
                backend.staged.lock().remove(&volume.name);
                match backend.api.remove_volume(&volume.name).await {
                    Ok(VolumeRemoval::Removed) => Some(volume.name),
                    Ok(_) => None,
                    Err(error) => {
                        log::warn!("cannot remove bundle volume {}: {error}", volume.name);
                        None
                    }
                }
            })
            .await;
            match removal {
                Ok(Some(name)) => removed.push(name),
                Ok(None) => {}
                Err(error) => log::warn!("bundle volume sweep worker failed: {error}"),
            }
        }
        removed
    }
}

/// Shared leases survive the caller and every cleanup retry. A unique helper
/// name alone would still allow concurrent installers to write one volume.
#[derive(Clone, Default)]
struct OperationLeases {
    _prepare: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
    _reservation: Option<Arc<RunnerReservation>>,
    _stage: Option<Arc<tokio::sync::OwnedMutexGuard<()>>>,
    _bundle: Option<Arc<tokio::sync::OwnedRwLockReadGuard<()>>>,
}

struct CancelSpawnOnDrop {
    reservation: Arc<RunnerReservation>,
    armed: bool,
}

impl Drop for CancelSpawnOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.reservation.cancel();
        }
    }
}

/// Own a helper until removal completes, including future cancellation.
struct HelperCleanup {
    api: Arc<dyn ContainerApi>,
    container_id: Option<String>,
    leases: OperationLeases,
}

impl HelperCleanup {
    async fn remove(&mut self) {
        let Some(id) = self.container_id.as_ref() else {
            return;
        };
        match tokio::time::timeout(CLEANUP_TIMEOUT, remove_owned(&self.api, id)).await {
            Ok(Ok(_)) => {
                self.container_id.take();
            }
            Ok(Err(error)) => log::warn!("helper removal failed for {id}: {error}"),
            Err(_) => log::warn!("helper removal timed out for {id}"),
        }
    }
}

impl Drop for HelperCleanup {
    fn drop(&mut self) {
        let Some(id) = self.container_id.take() else {
            return;
        };
        let api = self.api.clone();
        let leases = self.leases.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _leases = leases;
                // Removal is forced by the daemon seam; it also stops a
                // helper whose caller disappeared while collecting output.
                match tokio::time::timeout(CLEANUP_TIMEOUT, remove_owned(&api, &id)).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => {
                        log::warn!("abandoned helper removal failed for {id}: {error}")
                    }
                    Err(_) => log::warn!("abandoned helper removal timed out for {id}"),
                }
            });
        } else {
            log::warn!("helper {id} requires orphan cleanup after runtime shutdown");
        }
    }
}

/// Collect a container's output until it exits.
async fn collect(mut running: RunningRunner) -> Completed {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code = None;
    while let Some(event) = running.events.recv().await {
        match event {
            RunnerEvent::Stdout(chunk) => extend_capped(&mut stdout, &chunk),
            RunnerEvent::Stderr(chunk) => extend_capped(&mut stderr, &chunk),
            RunnerEvent::Exited { code: exit } => {
                code = exit;
                break;
            }
        }
    }
    Completed {
        stdout,
        stderr,
        code,
    }
}

fn extend_capped(buffer: &mut Vec<u8>, chunk: &[u8]) {
    let room = MAX_CAPTURED_OUTPUT.saturating_sub(buffer.len());
    if room > 0 {
        buffer.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
}

/// The first 12 hex characters of a digest, as a name component.
fn digest12(digest: &str) -> String {
    digest
        .rsplit(':')
        .next()
        .unwrap_or(digest)
        .chars()
        .take(12)
        .collect()
}

/// The stable code a probe problem is reported under.
fn probe_code_name(code: ProbeCode) -> &'static str {
    match code {
        ProbeCode::ArchMismatch => "bundle_arch_mismatch",
        ProbeCode::LibcUnsupported => "probe_libc_unsupported",
        ProbeCode::GlibcTooOld => "probe_glibc_too_old",
        ProbeCode::NoShell => "probe_no_shell",
        ProbeCode::UserMissing => "probe_user_missing",
        ProbeCode::WorkspaceNotWritable => "probe_workspace_not_writable",
    }
}

/// The refusal a report carries, if any. A probe problem is never a fault: the
/// image, or this workspace in it, cannot host the agent, and no other
/// execution path would change that.
fn refuse_probe(report: &ProbeReport) -> Option<SandboxSpawnError> {
    if let Some(problem) = report.problems.first() {
        return Some(SandboxSpawnError::refused(
            probe_code_name(problem.code),
            problem.message.clone(),
        ));
    }
    if report.libc.is_none() {
        return Some(SandboxSpawnError::refused(
            "probe_libc_unsupported",
            "the image's C library could not be identified",
        ));
    }
    None
}

/// What a cached probe entry records beyond the report: the inputs that change
/// it. The workspace owner is in there because a named user is remapped onto
/// it, so a report taken against a differently-owned workspace answers a
/// different question.
fn cache_entry(
    user: &UserSpec,
    match_owner: bool,
    owner: Option<Ownership>,
    report: &ProbeReport,
) -> Value {
    ProbeCacheEntry::new(user, match_owner, owner, report.clone()).to_value()
}

fn cached_report(
    entry: &Value,
    user: &UserSpec,
    match_owner: bool,
    owner: Option<Ownership>,
) -> Option<ProbeReport> {
    ProbeCacheEntry::from_value(entry)?
        .report_for(user, match_owner, owner)
        .cloned()
}

/// The uid observed on the host. On Linux — every deployment that runs this in
/// production — the server and the sandbox see one filesystem through one
/// kernel, so this is the uid the probe will report. A desktop daemon inside a
/// VM may map uids, and the probe cache then simply misses; correctness comes
/// from `init-agent`, which stats the workspace itself.
#[cfg(unix)]
fn host_owner(path: &Path) -> Option<Ownership> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|metadata| Ownership {
        uid: metadata.uid(),
        gid: metadata.gid(),
    })
}

#[cfg(not(unix))]
fn host_owner(_path: &Path) -> Option<Ownership> {
    None
}

fn runtime_for(tier: IsolationTier) -> Option<String> {
    match tier {
        IsolationTier::Gvisor => Some(GVISOR_RUNTIME.to_string()),
        _ => None,
    }
}

/// The identity the agent runs as, and whether a name is remapped onto the
/// workspace owner (ADR-0183 `updateRemoteUserUID`).
fn target_user(user: &SpecUser, tier: IsolationTier) -> (UserSpec, bool) {
    match user.declared.as_ref() {
        // A name is an identity the image defines; its uid may not own the
        // workspace, and that is exactly the case the remap exists for.
        Some(DeclaredUser {
            name: Some(name), ..
        }) => (UserSpec::Name(name.clone()), true),
        // A numeric uid is taken as meant and never remapped.
        Some(DeclaredUser { uid: Some(uid), .. }) => (UserSpec::Uid(*uid), false),
        _ => (UserSpec::Uid(default_uid(tier)), false),
    }
}

fn default_uid(tier: IsolationTier) -> u32 {
    match tier {
        // The isolation boundary contains root on the stronger tiers, and
        // agents routinely install packages mid-task.
        IsolationTier::Gvisor | IsolationTier::Vm => 0,
        IsolationTier::Container => CONTAINER_TIER_UID,
    }
}

/// Step ① does not filter egress. `off` is honoured by cutting the network
/// entirely; the other tiers get the legacy runner's network until the
/// per-tenant egress proxy exists (ADR-0185). [`egress_enforced`] is the one
/// place that says so, and the placement carries its answer.
fn egress_enforced(tier: EgressTier) -> bool {
    matches!(tier, EgressTier::Off)
}

/// Keep the image environment intact until sandboxd applies the declared
/// container and remote layers. Flattening at Docker create loses image PATH
/// interpolation and cannot represent remoteEnv null unsets.
fn runtime_config(
    spec: &EnvironmentSpec,
    config: &ExternalAgentSpawnConfig,
) -> Result<RuntimeConfigV1, SandboxSpawnError> {
    let mut runtime = RuntimeConfigV1 {
        container_env: spec.container_env.clone(),
        remote_env: spec.remote_env.clone(),
        spawn_env: config
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        lifecycle_commands: serde_json::from_value(
            serde_json::to_value(&spec.lifecycle_commands).expect("lifecycle commands serialize"),
        )
        .expect("environment and supervisor lifecycle schemas agree"),
        lifecycle_phases: vec![
            LifecyclePhase::OnCreate,
            LifecyclePhase::UpdateContent,
            LifecyclePhase::PostCreate,
            LifecyclePhase::PostStart,
            LifecyclePhase::PostAttach,
        ],
        workspace_folder: spec
            .workspace_folder
            .clone()
            .unwrap_or_else(|| WORKSPACE_TARGET.to_string()),
        ..RuntimeConfigV1::default()
    };
    if let Some(timeout) = spec.lifecycle_timeout_ms {
        runtime.lifecycle_timeout_ms = timeout;
    }
    for name in AMBIENT_CREDENTIAL_ENV {
        runtime.container_env.remove(name);
        runtime.remote_env.remove(name);
        runtime.spawn_env.remove(name);
    }
    Ok(runtime)
}

fn container_env(
    spec: &EnvironmentSpec,
    config: &ExternalAgentSpawnConfig,
) -> Result<Vec<String>, SandboxSpawnError> {
    encode_runtime_config_env(&runtime_config(spec, config)?).map_err(|error| {
        SandboxSpawnError::refused("sandbox_runtime_config_invalid", error.to_string())
    })
}

/// How this spawn's model credentials reach the sandbox, for the placement
/// the UI renders. A managed gateway task carries a per-task lease; anything
/// else carries no provider credentials at all.
fn credentials_mode(config: &ExternalAgentSpawnConfig) -> &'static str {
    if config.env.contains_key("COGNIA_GATEWAY_TASK_CONFIG")
        || config.env.contains_key("COGNIA_GATEWAY_TOKEN")
    {
        "gateway-lease"
    } else {
        "none"
    }
}

/// What the UI shows for an agent that got a sandbox.
fn sandbox_placement(
    admitted: &AdmittedSandbox,
    report: &ProbeReport,
    libc: Libc,
    invocation: &BundledInvocation,
    config: &ExternalAgentSpawnConfig,
) -> Value {
    let spec = &admitted.spec;
    let bundle = &admitted.admission.bundle;
    json!({
        "kind": "sandbox",
        "driver": "docker",
        "specDigest": spec.spec_digest,
        "image": spec.image.identity(),
        "sizeClassId": admitted.admission.size_class.id,
        "isolationTier": admitted.admission.actual_tier.as_str(),
        "bundle": {
            "digest": bundle.digest,
            "releaseTag": bundle.release_tag,
            "libc": libc.as_str(),
        },
        "command": invocation.name,
        "user": report.user.as_ref().map(|user| json!({
            "name": user.name,
            "uid": user.uid,
            "gid": user.gid,
            "remappedFrom": report.user_remapped_from.map(|from| json!({
                "uid": from.uid,
                "gid": from.gid,
            })),
        })),
        // Both labeled transitional in Step ①; see the module docs.
        "egress": {
            "tier": spec.egress.tier,
            "enforced": egress_enforced(spec.egress.tier),
        },
        "credentials": { "mode": credentials_mode(config) },
    })
}

#[async_trait]
impl SandboxDriverStatus for DockerSandboxBackend {
    fn driver(&self) -> &'static str {
        DRIVER_NAME
    }

    fn deployment_id(&self) -> &str {
        &self.config.deployment_id
    }

    fn instance_id(&self) -> &str {
        &self.config.instance_id
    }

    async fn available_tiers(&self) -> Result<Vec<IsolationTier>, SandboxSpawnError> {
        DockerSandboxBackend::available_tiers(self).await
    }
}

impl DockerSandboxBackend {
    async fn prepare_spawn(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
        leases: OperationLeases,
    ) -> Result<String, SandboxSpawnError> {
        let id = config.id.clone();
        let Some(placement) = config.sandbox.as_ref() else {
            return Err(SandboxSpawnError::refused(
                "sandbox_placement_required",
                "a sandbox spawn must carry its runtime environment placement",
            ));
        };
        let SandboxPlacement::Container { .. } = placement;
        let cwd = config.cwd.clone().ok_or_else(|| {
            SandboxSpawnError::refused(
                "sandbox_workspace_required",
                "a sandbox runs the agent in its workspace and needs a cwd",
            )
        })?;
        let mount =
            self.config.host.resolve_mount(&cwd).map_err(|error| {
                SandboxSpawnError::refused("sandbox_workspace_outside_root", error)
            })?;

        let tiers = self.available_tiers().await?;
        let admitted = self.admission.admit(placement.spec(), &tiers)?;
        if !tiers.contains(&admitted.admission.actual_tier) {
            // Admission picks from what it was handed, so this is unreachable;
            // it is here because silently running a weaker tier than the
            // placement records is the one failure nothing downstream notices.
            return Err(SandboxSpawnError::refused(
                "isolation_tier_unavailable",
                format!(
                    "this daemon cannot attest {}",
                    admitted.admission.actual_tier.as_str()
                ),
            ));
        }
        let bundle = admitted.admission.bundle.image();
        let leases = OperationLeases {
            _bundle: Some(Arc::new(
                self.bundle_lock(&bundle.digest).read_owned().await,
            )),
            ..leases
        };
        let (user, match_owner) = target_user(&admitted.spec.user, admitted.admission.actual_tier);

        let core_volume = self
            .ensure_staged(&bundle, Stage::Core, leases.clone())
            .await?;
        let report = self
            .probe_image(
                &admitted,
                &core_volume,
                &mount,
                &cwd,
                (&user, match_owner),
                leases.clone(),
            )
            .await?;
        let libc = report.libc.expect("a report without a libc is refused");

        let invocation = bundled_invocation(&config.command, &config.args, &report.commands)
            .ok_or_else(|| {
                SandboxSpawnError::refused(
                    "sandbox_command_unavailable",
                    format!(
                        "the agent bundle has no {} for {}",
                        config.command,
                        libc.as_str()
                    ),
                )
            })?;

        let libc_volume = self
            .ensure_staged(&bundle, Stage::Libc(libc), leases.clone())
            .await?;

        let mut cmd = vec![
            "init-agent".to_string(),
            "--root".to_string(),
            "/".to_string(),
            "--bundle".to_string(),
            INJECTION_ROOT.to_string(),
            "--user".to_string(),
            user.to_string(),
        ];
        if match_owner {
            cmd.push("--match-owner-of".to_string());
            cmd.push(WORKSPACE_TARGET.to_string());
        }
        cmd.push("--".to_string());
        cmd.push(format!(
            "{INJECTION_ROOT}/{}/bin/{}",
            libc.as_str(),
            invocation.name
        ));
        cmd.extend(invocation.args.iter().cloned());

        let size_class = &admitted.admission.size_class;
        let spec = RunnerSpec {
            name: sanitize_container_name(&id),
            image: self.admission.runtime_image(&admitted.spec)?,
            entrypoint: Some(vec![format!("{INJECTION_ROOT}/bin/cognia-sandboxd")]),
            cmd,
            env: container_env(&admitted.spec, &config)?,
            working_dir: WORKSPACE_TARGET.to_string(),
            mount: Some(mount),
            seccomp_json: self.config.host.seccomp_json.clone(),
            memory_bytes: i64::from(size_class.memory_mib).saturating_mul(1024 * 1024),
            nano_cpus: i64::from(size_class.cpu_millis).saturating_mul(1_000_000),
            pids_limit: self.config.host.pids_limit,
            network_mode: match admitted.spec.egress.tier {
                EgressTier::Off => "none".to_string(),
                EgressTier::Allowlist | EgressTier::On => self.config.host.network_mode.clone(),
            },
            labels: {
                let mut labels =
                    ownership_labels(&id, &self.config.instance_id, &self.config.deployment_id);
                labels.insert("cognia.project-id".into(), admitted.spec.project_id.clone());
                labels.insert(
                    "cognia.spec-digest".into(),
                    admitted.spec.spec_digest.clone(),
                );
                labels
            },
            // Root so `init-agent` can switch to the target user; it exits 125
            // rather than running the agent as root by accident.
            user: Some("0".to_string()),
            extra_mounts: vec![VolumeMount {
                volume: libc_volume,
                target: INJECTION_ROOT.to_string(),
                read_only: true,
            }],
            runtime: runtime_for(admitted.admission.actual_tier),
            // The privilege `init-agent` actually uses: the setuid/gid switch
            // to the target user, and the home handover's lchown through a
            // home that may be mode 0700 (CHOWN + DAC_OVERRIDE + FOWNER).
            // Everything else — NET_ADMIN, SYS_ADMIN, the rest — is dropped.
            cap_drop: vec!["ALL".to_string()],
            cap_add: vec![
                "SETUID".to_string(),
                "SETGID".to_string(),
                "CHOWN".to_string(),
                "DAC_OVERRIDE".to_string(),
                "FOWNER".to_string(),
            ],
            // Writable: the image is user-authored, so its own entrypoint
            // conventions and mid-task package installs (apt, npm -g) write
            // where they will. Until the spec can declare writable roots,
            // the confinement here is the capability set, not the rootfs —
            // the helper containers above, which run only our binaries, are
            // the read-only ones.
            read_only_rootfs: false,
            tmpfs: vec!["/tmp".to_string()],
            writable_dirs: Vec::new(),
        };

        let auth = admitted
            .spec
            .image
            .registry_image()
            .map(|image| self.admission.registry_auth(&image.registry))
            .transpose()?
            .flatten();
        let placement = sandbox_placement(&admitted, &report, libc, &invocation, &config);
        if admitted.spec.lifecycle == SandboxLifecycleKind::Persistent {
            let (running, cleanup) = self
                .start_persistent(spec, auth, &admitted.spec, &config, leases)
                .await?;
            sink.sandbox_placement(&id, &placement);
            return Ok(self
                .runners
                .adopt_scoped(config, running, Some(placement), sink, cleanup));
        }
        let running = self
            .start(spec, auth, leases)
            .await
            .map_err(|failure| match failure {
                RunFailure::Pull(error) => SandboxSpawnError::refused(
                    "sandbox_image_unavailable",
                    format!("the project image could not be pulled: {error}"),
                ),
                RunFailure::Start(error) => SandboxSpawnError::fault(
                    "sandbox_container_start_failed",
                    format!("the sandbox did not start: {error}"),
                ),
                RunFailure::Timeout => SandboxSpawnError::fault(
                    "sandbox_container_start_failed",
                    "starting the sandbox timed out".to_string(),
                ),
            })?;

        sink.sandbox_placement(&id, &placement);
        Ok(self.runners.adopt(config, running, Some(placement), sink))
    }
}

#[async_trait]
impl SandboxExecBackend for DockerSandboxBackend {
    async fn spawn_sandboxed(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, SandboxSpawnError> {
        let reservation = Arc::new(
            self.runners
                .reserve(&config.id)
                .map_err(|error| SandboxSpawnError::refused("sandbox_agent_exists", error))?,
        );
        let mut cancellation = CancelSpawnOnDrop {
            reservation: reservation.clone(),
            armed: true,
        };
        let result = tokio::select! {
            biased;
            _ = reservation.cancelled() => Err(SandboxSpawnError::refused(
                "sandbox_spawn_cancelled", "the sandbox start was cancelled",
            )),
            result = async {
                let slot = self.prepare_slots.clone().acquire_owned().await.expect("preparation semaphore stays open");
                self.prepare_spawn(config, sink, OperationLeases {
                    _prepare: Some(Arc::new(slot)), _reservation: Some(reservation.clone()),
                    ..OperationLeases::default()
                }).await
            } => result,
        };
        cancellation.armed = result.is_err();
        result
    }

    fn multi_tenant(&self) -> bool {
        self.admission.multi_tenant()
    }
}

#[async_trait]
impl ExecBackend for DockerSandboxBackend {
    /// Reached only when this backend is used without the router. A spawn with
    /// a placement still works; one without has no environment to run in.
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
        let mut reaped = reap_owned_orphans(
            &self.container,
            &self.config.instance_id,
            &self.config.deployment_id,
        )
        .await?;
        reaped.extend(self.sweep_bundle_volumes().await);
        Ok(reaped)
    }

    fn routes_sandboxes(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_environment::catalog::{OfferedBundle, SizeClass};
    use cognia_environment::policy::Admission;
    use cognia_environment::spec::{
        DeclaredUserSource, EgressSpec, EnvironmentSource, IsolationRequirement, LifecycleCommands,
        SandboxLifecycleKind, SpecBundle, SpecImage,
    };
    use cognia_external_agent::container_backend::test_support::{FakeContainerApi, ScriptedExit};
    use cognia_external_agent::container_backend::AGENT_ID_LABEL;
    use cognia_external_agent::exec_backend::test_support::RecordingAgentEmitter;
    use cognia_external_agent::exec_backend::{EmitterEventSink, PLACEMENT_CHANNEL};
    use cognia_external_agent::sandbox_routing_backend::SandboxErrorKind;
    use cognia_sandboxd::layout::Arch;
    use cognia_sandboxd::manifest::{BundleCommand, GlibcVersion};
    use cognia_sandboxd::passwd::ResolvedUser;
    use cognia_sandboxd::probe::ProbeProblem;
    use std::collections::HashMap;
    use std::path::PathBuf;

    const IMAGE_DIGEST: &str =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const BUNDLE_DIGEST: &str =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const CWD: &str = "/srv/workspaces/ws-1";

    /// Scripted admission: the driver's tests are about containers, and
    /// admission has its own tests in `cognia-environment`.
    pub(super) struct FakeAdmission {
        pub(super) outcome: Mutex<Result<AdmittedSandbox, SandboxSpawnError>>,
        probes: Mutex<HashMap<(String, String), Value>>,
        offered: Mutex<Vec<String>>,
        tiers_seen: Mutex<Vec<Vec<IsolationTier>>>,
        multi_tenant: bool,
    }

    impl FakeAdmission {
        fn admitting(admitted: AdmittedSandbox) -> Arc<Self> {
            Arc::new(Self {
                outcome: Mutex::new(Ok(admitted)),
                probes: Mutex::new(HashMap::new()),
                offered: Mutex::new(vec![BUNDLE_DIGEST.to_string()]),
                tiers_seen: Mutex::new(Vec::new()),
                multi_tenant: false,
            })
        }
    }

    impl SandboxAdmission for FakeAdmission {
        fn stored_spec(&self, digest: &str) -> Option<Value> {
            self.outcome
                .lock()
                .as_ref()
                .ok()
                .filter(|admitted| admitted.spec.spec_digest == digest)
                .and_then(|admitted| serde_json::to_value(&admitted.spec).ok())
        }

        fn multi_tenant(&self) -> bool {
            self.multi_tenant
        }

        fn admit(
            &self,
            _spec: &Value,
            available_tiers: &[IsolationTier],
        ) -> Result<AdmittedSandbox, SandboxSpawnError> {
            self.tiers_seen.lock().push(available_tiers.to_vec());
            self.outcome.lock().clone()
        }

        fn registry_auth(
            &self,
            _registry: &str,
        ) -> Result<Option<RegistryAuth>, SandboxSpawnError> {
            Ok(None)
        }

        fn cached_probe(&self, user_image_digest: &str, bundle_digest: &str) -> Option<Value> {
            self.probes
                .lock()
                .get(&(user_image_digest.to_string(), bundle_digest.to_string()))
                .cloned()
        }

        fn record_probe(&self, user_image_digest: &str, bundle_digest: &str, entry: &Value) {
            self.probes.lock().insert(
                (user_image_digest.to_string(), bundle_digest.to_string()),
                entry.clone(),
            );
        }

        fn offered_bundle_digests(&self) -> Vec<String> {
            self.offered.lock().clone()
        }
    }

    fn host() -> RunnerHostSettings {
        RunnerHostSettings {
            workspaces_dir: PathBuf::from("/srv/workspaces"),
            workspaces_volume: None,
            seccomp_json: None,
            memory_bytes: 2048 * 1024 * 1024,
            nano_cpus: 2_000_000_000,
            pids_limit: 512,
            network_mode: "bridge".to_string(),
        }
    }

    fn config() -> DockerSandboxConfig {
        DockerSandboxConfig {
            deployment_id: "dep1".to_string(),
            instance_id: "inst1".to_string(),
            host: host(),
        }
    }

    fn decode_agent_environment(env: &[String]) -> RuntimeConfigV1 {
        let entries = env
            .iter()
            .map(|entry| {
                let (key, value) = entry.split_once('=').unwrap();
                (key.to_string(), value.to_string())
            })
            .collect();
        cognia_sandboxd::env::decode_runtime_config_env(&entries)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn runtime_preserves_remote_unsets_interpolation_cwd_and_lifecycle() {
        let mut spec = spec(EgressTier::Off, None);
        spec.container_env
            .insert("PATH".into(), "${containerEnv:PATH}:/project/bin".into());
        spec.remote_env.insert("OLD".into(), None);
        spec.remote_env.insert(
            "PATH".into(),
            Some("${containerEnv:PATH}:/tools/bin".into()),
        );
        spec.workspace_folder = Some("/workspace/app".into());
        spec.lifecycle_timeout_ms = Some(12_000);
        spec.lifecycle_commands.post_create = Some(cognia_environment::spec::CommandSpec::Argv {
            argv: vec!["npm".into(), "ci".into()],
        });
        let spawn = spawn_config("config-test", "node", &[], &spec);
        let encoded = container_env(&spec, &spawn).unwrap();
        assert!(encoded
            .iter()
            .all(|entry| entry.starts_with("COGNIA_SANDBOXD_RUNTIME_CONFIG_")));
        let runtime = decode_agent_environment(&encoded);
        assert_eq!(runtime.remote_env["OLD"], None);
        assert_eq!(runtime.workspace_folder, "/workspace/app");
        assert_eq!(runtime.lifecycle_timeout_ms, 12_000);
        assert_eq!(
            runtime.container_env["PATH"],
            "${containerEnv:PATH}:/project/bin"
        );
        assert!(runtime.lifecycle_commands.post_create.is_some());
    }

    pub(super) fn spec(egress: EgressTier, declared: Option<DeclaredUser>) -> EnvironmentSpec {
        EnvironmentSpec {
            version: 1,
            spec_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
                .to_string(),
            project_id: "proj-1".to_string(),
            source: EnvironmentSource::ProjectSetting {
                catalog_entry_id: "node-22".to_string(),
            },
            image: SpecImage::Registry(cognia_environment::spec::RegistrySpecImage {
                registry: "ghcr.io".to_string(),
                repository: "acme/dev".to_string(),
                digest: IMAGE_DIGEST.to_string(),
                catalog_entry_id: Some("node-22".to_string()),
                build_key: None,
            }),
            bundle: SpecBundle {
                digest: BUNDLE_DIGEST.to_string(),
                release_tag: "v1.2.3".to_string(),
                pinned: false,
            },
            isolation: IsolationRequirement {
                minimum: IsolationTier::Container,
            },
            size_class_id: "small".to_string(),
            lifecycle: SandboxLifecycleKind::Ephemeral,
            user: SpecUser { declared },
            container_env: BTreeMap::from([("PROJECT_FLAG".to_string(), "1".to_string())]),
            remote_env: BTreeMap::new(),
            workspace_folder: None,
            lifecycle_timeout_ms: None,
            lifecycle_commands: LifecycleCommands::default(),
            forward_ports: Vec::new(),
            egress: EgressSpec {
                tier: egress,
                preset_ids: Vec::new(),
                approved_domains: Vec::new(),
            },
            browser_sidecar: false,
            workspace_config_digest: None,
            explain: None,
        }
    }

    pub(super) fn admitted(spec: EnvironmentSpec, tier: IsolationTier) -> AdmittedSandbox {
        AdmittedSandbox {
            admission: Admission {
                spec_digest: spec.spec_digest.clone(),
                actual_tier: tier,
                size_class: SizeClass {
                    id: "small".to_string(),
                    label: "Small".to_string(),
                    cpu_millis: 1500,
                    memory_mib: 4096,
                    ephemeral_storage_mib: 10_240,
                    volume_mib: 20_480,
                    gpu: None,
                },
                bundle: OfferedBundle {
                    registry: "ghcr.io".to_string(),
                    repository: "cognia/agent-bundle".to_string(),
                    digest: BUNDLE_DIGEST.to_string(),
                    release_tag: "v1.2.3".to_string(),
                },
            },
            spec,
        }
    }

    pub(super) fn command(name: &str, package: Option<&str>) -> BundleCommand {
        BundleCommand {
            name: name.to_string(),
            package: package.map(str::to_string),
        }
    }

    pub(super) fn report(commands: Vec<BundleCommand>, problems: Vec<ProbeProblem>) -> ProbeReport {
        ProbeReport {
            version: PROBE_REPORT_VERSION,
            arch: Arch::Amd64,
            libc: Some(Libc::Glibc),
            glibc_version: Some(GlibcVersion {
                major: 2,
                minor: 36,
            }),
            interpreter: Some("/lib64/ld-linux-x86-64.so.2".to_string()),
            shell: Some("/bin/sh".to_string()),
            user: Some(ResolvedUser {
                name: Some("vscode".to_string()),
                uid: 10001,
                gid: 10001,
                groups: vec![10001],
                home: Some("/home/vscode".to_string()),
            }),
            user_remapped_from: Some(Ownership {
                uid: 1000,
                gid: 1000,
            }),
            workspace_owner: Some(Ownership {
                uid: 10001,
                gid: 10001,
            }),
            home_writable: Some(true),
            workspace_writable: true,
            ca_bundle: Some("/etc/ssl/certs/ca-certificates.crt".to_string()),
            runtimes: vec!["codex".to_string()],
            commands,
            problems,
        }
    }

    pub(super) fn spawn_config(
        id: &str,
        command: &str,
        args: &[&str],
        spec: &EnvironmentSpec,
    ) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: id.to_string(),
            command: command.to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            env: HashMap::from([("ANTHROPIC_API_KEY".to_string(), "sk-test".to_string())]),
            cwd: Some(CWD.to_string()),
            framing: Default::default(),
            sandbox: Some(SandboxPlacement::Container {
                spec: serde_json::to_value(spec).expect("a spec serializes"),
                isolation_mandatory: false,
            }),
        }
    }

    /// Scripts the fake so `install` and `probe` containers finish by
    /// themselves and the agent container keeps running, as a real one does.
    fn script(api: &Arc<FakeContainerApi>, probe: ProbeReport, probe_code: i64) {
        let json = serde_json::to_vec(&probe).expect("a report serializes");
        api.script_exits(move |spec| match spec.cmd.first().map(String::as_str) {
            Some("install") => Some(ScriptedExit {
                stdout: b"AlreadyCurrent\n".to_vec(),
                stderr: Vec::new(),
                code: 0,
            }),
            Some("probe") => Some(ScriptedExit {
                stdout: json.clone(),
                stderr: Vec::new(),
                code: probe_code,
            }),
            _ => None,
        });
    }

    pub(super) struct Harness {
        pub(super) api: Arc<FakeContainerApi>,
        pub(super) admission: Arc<FakeAdmission>,
        pub(super) backend: Arc<DockerSandboxBackend>,
        emitter: Arc<RecordingAgentEmitter>,
    }

    impl Harness {
        pub(super) fn new(admitted: AdmittedSandbox, probe: ProbeReport, probe_code: i64) -> Self {
            let api = FakeContainerApi::new();
            script(&api, probe, probe_code);
            let admission = FakeAdmission::admitting(admitted);
            let backend = DockerSandboxBackend::new(api.clone(), admission.clone(), config());
            Self {
                api,
                admission,
                backend,
                emitter: RecordingAgentEmitter::new(),
            }
        }

        pub(super) async fn spawn(
            &self,
            config: ExternalAgentSpawnConfig,
        ) -> Result<String, SandboxSpawnError> {
            self.backend
                .spawn_sandboxed(config, EmitterEventSink::new(self.emitter.clone()))
                .await
        }

        fn specs(&self) -> Vec<RunnerSpec> {
            self.api.specs.lock().clone()
        }

        fn placement(&self) -> Value {
            self.emitter
                .events()
                .into_iter()
                .find(|(channel, _)| channel == PLACEMENT_CHANNEL)
                .map(|(_, payload)| payload["placement"].clone())
                .expect("a sandbox spawn emits its placement")
        }
    }

    #[tokio::test]
    async fn persistent_agents_share_container_and_exit_without_removing_workspace() {
        let mut spec = spec(EgressTier::Off, None);
        spec.lifecycle = SandboxLifecycleKind::Persistent;
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        let (a, b) = tokio::join!(
            harness.spawn(spawn_config("persistent-a", "kiro-cli", &[], &spec)),
            harness.spawn(spawn_config("persistent-b", "kiro-cli", &[], &spec)),
        );
        a.unwrap();
        b.unwrap();
        let runtime_specs: Vec<_> = harness
            .specs()
            .into_iter()
            .filter(|s| s.cmd[0] == "serve")
            .collect();
        assert_eq!(runtime_specs.len(), 1);
        let boot = decode_agent_environment(&runtime_specs[0].env);
        assert!(
            boot.spawn_env.is_empty(),
            "retained container must not retain task credentials"
        );
        assert!(!boot.lifecycle_phases.contains(&LifecyclePhase::PostAttach));
        let info_a = harness.backend.get_info("persistent-a").await.unwrap();
        let info_b = harness.backend.get_info("persistent-b").await.unwrap();
        assert_eq!(info_a["containerId"], info_b["containerId"]);
        let container_id = info_a["containerId"].as_str().unwrap();
        harness.backend.kill("persistent-a").await.unwrap();
        for _ in 0..100 {
            if harness.backend.status("persistent-a").await.is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(harness.backend.status("persistent-a").await.is_none());
        assert!(harness.backend.status("persistent-b").await.is_some());
        assert!(!harness
            .api
            .removes
            .lock()
            .iter()
            .any(|id| id == container_id));
        assert!(!harness.api.kills.lock().iter().any(|id| id == container_id));
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn persistent_runtime_is_recovered_and_resumed_after_host_restart() {
        let mut spec = spec(EgressTier::Off, None);
        spec.lifecycle = SandboxLifecycleKind::Persistent;
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("before-restart", "kiro-cli", &[], &spec))
            .await
            .unwrap();
        let id = harness.backend.get_info("before-restart").await.unwrap()["containerId"]
            .as_str()
            .unwrap()
            .to_string();
        harness.backend.kill_all().await.unwrap();
        harness.api.stop_runtime(&id).await.unwrap();
        let mut next_config = config();
        next_config.instance_id = "next-host-process".into();
        let next =
            DockerSandboxBackend::new(harness.api.clone(), harness.admission.clone(), next_config);
        next.reap_orphans().await.unwrap();
        assert!(harness.api.labels_by_container.lock().contains_key(&id));
        next.spawn_sandboxed(
            spawn_config("after-restart", "kiro-cli", &[], &spec),
            EmitterEventSink::new(harness.emitter.clone()),
        )
        .await
        .unwrap();
        assert_eq!(
            next.get_info("after-restart").await.unwrap()["containerId"],
            id
        );
        assert_eq!(*harness.api.restarted_runtimes.lock(), vec![id]);
        assert_eq!(
            harness
                .specs()
                .iter()
                .filter(|s| s.cmd[0] == "serve")
                .count(),
            1
        );
        next.kill_all().await.unwrap();
    }

    /// Model a busy daemon accepting one create every 2ms. All work still
    /// goes through spawn_sandboxed, including admission, staging and adopt.
    async fn cold_batch() -> (u128, usize) {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *harness.api.run_gate.lock() = Some(gate.clone());
        let clock = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(2)).await;
                gate.add_permits(1);
            }
        });
        let started = std::time::Instant::now();
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..8 {
            let backend = harness.backend.clone();
            let config = spawn_config(&format!("batch-{index}"), "kiro-cli", &[], &spec);
            let sink = EmitterEventSink::new(harness.emitter.clone());
            tasks.spawn(async move { backend.spawn_sandboxed(config, sink).await });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap().unwrap();
        }
        let micros = started.elapsed().as_micros();
        clock.abort();
        let _ = clock.await;
        let helpers = harness
            .specs()
            .iter()
            .filter(|s| s.cmd[0] != "init-agent")
            .count();
        harness.backend.kill_all().await.unwrap();
        (micros, helpers)
    }

    #[tokio::test]
    async fn concurrent_cold_spawns_share_one_probe() {
        let (_, helpers) = tokio::time::timeout(Duration::from_secs(5), cold_batch())
            .await
            .unwrap();
        assert_eq!(helpers, 4, "one core install, one probe, two libc installs");
    }

    #[tokio::test]
    #[ignore = "controlled orchestration benchmark; not a Docker throughput claim"]
    async fn benchmark_cold_batch() {
        cold_batch().await;
        for sample in 0..10 {
            let (micros, helpers) = cold_batch().await;
            println!("cold_batch sample={sample} micros={micros} helpers={helpers}");
        }
    }

    #[tokio::test]
    async fn simultaneous_missing_image_starts_share_one_authenticated_pull() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("pull-fixture", "kiro-cli", &[], &spec))
            .await
            .unwrap();
        let fixture = harness.specs()[0].clone();
        let image = fixture.image.clone();
        harness.api.missing_images.lock().insert(image.clone());
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *harness.api.run_gate.lock() = Some(gate.clone());
        let auth = RegistryAuth {
            server_address: "ghcr.io".into(),
            registry_token: Some("pull-token".into()),
            ..RegistryAuth::default()
        };
        let mut tasks = Vec::new();
        for name in ["pull-first", "pull-second"] {
            let backend = harness.backend.clone();
            let mut fixture = fixture.clone();
            fixture.name = name.into();
            let auth = auth.clone();
            tasks.push(tokio::spawn(async move {
                backend
                    .start(fixture, Some(auth), OperationLeases::default())
                    .await
            }));
            harness.api.run_started.notified().await;
        }
        // Both initial creates report missing. Only the lock holder enters
        // the second presence check; the other caller waits for that pull.
        gate.add_permits(2);
        harness.api.run_started.notified().await;
        assert!(harness.api.auth_pulls.lock().is_empty());
        gate.add_permits(1);
        harness.api.run_started.notified().await;
        assert_eq!(
            harness.api.auth_pulls.lock().as_slice(),
            &[(image.clone(), Some(auth.clone()))]
        );
        gate.add_permits(1);
        harness.api.run_started.notified().await;
        gate.add_permits(1);
        let mut ids = Vec::new();
        for task in tasks {
            let running = task
                .await
                .unwrap()
                .unwrap_or_else(|_| panic!("coalesced start failed"));
            ids.push(running.container_id.clone());
            remove_owned(&harness.backend.container, &running.container_id)
                .await
                .unwrap();
        }
        assert_ne!(ids[0], ids[1]);
        assert_eq!(
            harness.api.auth_pulls.lock().as_slice(),
            &[(image, Some(auth))]
        );
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_helper_is_removed() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness.api.script_exits(|_| None);
        let backend = harness.backend.clone();
        let sink = EmitterEventSink::new(harness.emitter.clone());
        let task = tokio::spawn(async move {
            backend
                .spawn_sandboxed(spawn_config("cancelled", "kiro-cli", &[], &spec), sink)
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while harness.api.specs.lock().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            harness.api.removes.lock().len(),
            1,
            "an abandoned staging container must be removed"
        );
    }

    #[tokio::test]
    async fn cancelled_staging_retains_volume_and_identity_until_delayed_removal() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        let creates = Arc::new(tokio::sync::Semaphore::new(0));
        let removes = Arc::new(tokio::sync::Semaphore::new(0));
        *harness.api.run_gate.lock() = Some(creates.clone());
        *harness.api.remove_gate.lock() = Some(removes.clone());
        let task = tokio::spawn({
            let backend = harness.backend.clone();
            let config = spawn_config("abandoned-stage", "kiro-cli", &[], &spec);
            let sink = EmitterEventSink::new(harness.emitter.clone());
            async move { backend.spawn_sandboxed(config, sink).await }
        });
        harness.api.run_started.notified().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            harness.backend.status("abandoned-stage").await,
            Some(ExternalAgentProcessState::Stopping)
        );
        assert_eq!(
            harness.backend.prepare_slots.available_permits(),
            MAX_CONCURRENT_PREPARES - 1
        );
        let duplicate = harness
            .spawn(spawn_config("abandoned-stage", "kiro-cli", &[], &spec))
            .await
            .unwrap_err();
        assert_eq!(duplicate.code, "sandbox_agent_exists");

        // A different agent needs the same volume. It must wait through BOTH
        // the abandoned create and forced removal, before using its name or
        // writing into the volume again.
        let retry = tokio::spawn({
            let backend = harness.backend.clone();
            let config = spawn_config("retry-stage", "kiro-cli", &[], &spec);
            let sink = EmitterEventSink::new(harness.emitter.clone());
            async move { backend.spawn_sandboxed(config, sink).await }
        });
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            harness.api.run_started.notified()
        )
        .await
        .is_err());
        creates.add_permits(1);
        harness.api.remove_started.notified().await;
        assert!(harness.api.removes.lock().is_empty());
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            harness.api.run_started.notified()
        )
        .await
        .is_err());
        assert_eq!(
            harness.backend.status("abandoned-stage").await,
            Some(ExternalAgentProcessState::Stopping)
        );
        removes.add_permits(1);
        harness.api.run_started.notified().await;
        assert_eq!(
            harness.api.removes.lock().len(),
            1,
            "retry create follows completed removal"
        );
        assert!(harness.backend.status("abandoned-stage").await.is_none());
        creates.add_permits(100);
        removes.add_permits(100);
        retry.await.unwrap().unwrap();
        let staged = harness
            .specs()
            .into_iter()
            .filter(|spec| {
                spec.labels.get(AGENT_ID_LABEL).map(String::as_str) == Some("bundle-stage-core")
            })
            .collect::<Vec<_>>();
        assert_eq!(staged.len(), 2);
        assert_eq!(staged[0].name, staged[1].name);
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_final_creates_keep_all_preparation_slots_until_cleanup() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("warm", "kiro-cli", &[], &spec))
            .await
            .unwrap();
        harness.backend.kill_all().await.unwrap();
        let creates = Arc::new(tokio::sync::Semaphore::new(0));
        *harness.api.run_gate.lock() = Some(creates.clone());
        let mut tasks = Vec::new();
        for index in 0..MAX_CONCURRENT_PREPARES {
            let backend = harness.backend.clone();
            let config = spawn_config(&format!("cancel-final-{index}"), "kiro-cli", &[], &spec);
            let sink = EmitterEventSink::new(harness.emitter.clone());
            tasks.push(tokio::spawn(async move {
                backend.spawn_sandboxed(config, sink).await
            }));
            harness.api.run_started.notified().await;
        }
        for index in 0..MAX_CONCURRENT_PREPARES {
            harness
                .backend
                .kill(&format!("cancel-final-{index}"))
                .await
                .unwrap();
        }
        for task in tasks {
            assert_eq!(
                task.await.unwrap().unwrap_err().code,
                "sandbox_spawn_cancelled"
            );
        }
        assert_eq!(harness.backend.prepare_slots.available_permits(), 0);
        assert_eq!(
            harness.backend.status("cancel-final-0").await,
            Some(ExternalAgentProcessState::Stopping)
        );
        assert_eq!(
            harness
                .spawn(spawn_config("cancel-final-0", "kiro-cli", &[], &spec))
                .await
                .unwrap_err()
                .code,
            "sandbox_agent_exists"
        );

        let waiting = tokio::spawn({
            let backend = harness.backend.clone();
            let config = spawn_config("after-cancel", "kiro-cli", &[], &spec);
            let sink = EmitterEventSink::new(harness.emitter.clone());
            async move { backend.spawn_sandboxed(config, sink).await }
        });
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            harness.api.run_started.notified()
        )
        .await
        .is_err());
        creates.add_permits(MAX_CONCURRENT_PREPARES);
        harness.api.run_started.notified().await;
        assert!(!harness.api.removes.lock().is_empty());
        creates.add_permits(1);
        waiting.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while harness.backend.prepare_slots.available_permits() != MAX_CONCURRENT_PREPARES {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        for index in 0..MAX_CONCURRENT_PREPARES {
            assert!(harness
                .backend
                .status(&format!("cancel-final-{index}"))
                .await
                .is_none());
        }
        creates.add_permits(1);
        harness
            .spawn(spawn_config("cancel-final-0", "kiro-cli", &[], &spec))
            .await
            .unwrap();
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn retiring_bundle_is_not_swept_during_cancelled_final_creation() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("warm", "kiro-cli", &[], &spec))
            .await
            .unwrap();
        harness.backend.kill_all().await.unwrap();
        let creates = Arc::new(tokio::sync::Semaphore::new(0));
        *harness.api.run_gate.lock() = Some(creates.clone());
        let pending = tokio::spawn({
            let backend = harness.backend.clone();
            let config = spawn_config("retiring", "kiro-cli", &[], &spec);
            let sink = EmitterEventSink::new(harness.emitter.clone());
            async move { backend.spawn_sandboxed(config, sink).await }
        });
        harness.api.run_started.notified().await;
        harness.admission.offered.lock().clear();
        harness.api.volumes.lock().insert(
            "unrelated-retired-bundle".to_string(),
            harness.backend.volume_labels("sha256:3333", Stage::Core),
        );
        assert_eq!(
            harness.backend.sweep_bundle_volumes().await,
            vec!["unrelated-retired-bundle"],
            "sweep skips an admitted spawn's volumes without blocking unrelated retirement"
        );

        harness.backend.kill("retiring").await.unwrap();
        assert_eq!(
            pending.await.unwrap().unwrap_err().code,
            "sandbox_spawn_cancelled"
        );
        assert!(
            harness.backend.sweep_bundle_volumes().await.is_empty(),
            "a cancelled daemon create still owns its bundle until cleanup settles"
        );
        creates.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), async {
            while harness.backend.status("retiring").await.is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(harness.backend.sweep_bundle_volumes().await.len(), 2);
        assert!(harness.api.volumes.lock().is_empty());
    }

    #[tokio::test]
    async fn cancelled_sweep_retains_deletion_lease_before_reoffered_bundle_starts() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("warm", "kiro-cli", &[], &spec))
            .await
            .unwrap();
        harness.backend.kill_all().await.unwrap();
        harness.admission.offered.lock().clear();
        let removals = Arc::new(tokio::sync::Semaphore::new(0));
        *harness.api.volume_remove_gate.lock() = Some(removals.clone());
        let sweep = tokio::spawn({
            let backend = harness.backend.clone();
            async move { backend.sweep_bundle_volumes().await }
        });
        harness.api.volume_remove_started.notified().await;
        sweep.abort();
        assert!(sweep.await.unwrap_err().is_cancelled());
        assert!(
            harness
                .backend
                .bundle_lock(BUNDLE_DIGEST)
                .try_read()
                .is_err(),
            "submitted deletion retains ownership after its sweep is cancelled"
        );

        harness
            .admission
            .offered
            .lock()
            .push(BUNDLE_DIGEST.to_string());
        let before = harness.api.specs.lock().len();
        let mut pending = tokio::spawn({
            let backend = harness.backend.clone();
            let config = spawn_config("reoffered", "kiro-cli", &[], &spec);
            let sink = EmitterEventSink::new(harness.emitter.clone());
            async move { backend.spawn_sandboxed(config, sink).await }
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut pending)
                .await
                .is_err()
        );
        assert_eq!(harness.api.specs.lock().len(), before);
        removals.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(harness.api.volumes.lock().len(), 2);
        assert_eq!(
            harness.api.specs.lock().len(),
            before + 2,
            "the deleted core is restaged before starting the agent; libc remains cached"
        );
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn a_lost_volume_removal_response_does_not_leave_a_staging_cache_hit() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("warm", "kiro-cli", &[], &spec))
            .await
            .unwrap();
        harness.backend.kill_all().await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while harness.backend.prepare_slots.available_permits() != MAX_CONCURRENT_PREPARES
                || harness.backend.status("warm").await.is_some()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        harness.admission.offered.lock().clear();
        *harness.api.fail_volume_remove.lock() = Some("lost DELETE response".to_string());
        assert!(harness.backend.sweep_bundle_volumes().await.is_empty());
        assert!(harness.api.volumes.lock().is_empty());
        assert!(harness.backend.staged.lock().is_empty());

        harness
            .admission
            .offered
            .lock()
            .push(BUNDLE_DIGEST.to_string());
        let before = harness.api.specs.lock().len();
        harness
            .spawn(spawn_config("after-lost-delete", "kiro-cli", &[], &spec))
            .await
            .unwrap();
        assert_eq!(harness.api.volumes.lock().len(), 2);
        assert_eq!(
            harness.api.specs.lock().len(),
            before + 4,
            "both deleted volumes are installed again before agent creation"
        );
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn a_swept_bundle_can_be_staged_again() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        let bundle = harness
            .admission
            .outcome
            .lock()
            .as_ref()
            .unwrap()
            .admission
            .bundle
            .image();
        let volume = harness
            .backend
            .ensure_staged(&bundle, Stage::Core, OperationLeases::default())
            .await
            .unwrap();
        harness.admission.offered.lock().clear();
        assert_eq!(
            harness.backend.sweep_bundle_volumes().await,
            vec![volume.clone()]
        );
        harness.admission.offered.lock().push(bundle.digest.clone());
        harness
            .backend
            .ensure_staged(&bundle, Stage::Core, OperationLeases::default())
            .await
            .unwrap();
        assert!(
            harness.api.volumes.lock().contains_key(&volume),
            "the in-memory hit must be invalidated after removal"
        );
    }

    #[tokio::test]
    async fn preparation_is_bounded_and_queued_agents_can_be_cancelled() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *harness.api.run_gate.lock() = Some(gate.clone());
        let mut tasks = Vec::new();
        for index in 0..8 {
            let backend = harness.backend.clone();
            let spawn = spawn_config(&format!("bounded-{index}"), "kiro-cli", &[], &spec);
            let sink = EmitterEventSink::new(harness.emitter.clone());
            tasks.push(tokio::spawn(async move {
                backend.spawn_sandboxed(spawn, sink).await
            }));
            for _ in 0..10 {
                tokio::task::yield_now().await;
            }
        }
        assert_eq!(
            harness.admission.tiers_seen.lock().len(),
            MAX_CONCURRENT_PREPARES
        );
        assert_eq!(harness.backend.list().await.len(), 8);
        harness.backend.kill("bounded-7").await.unwrap();
        let error = tasks.pop().unwrap().await.unwrap().unwrap_err();
        assert_eq!(error.code, "sandbox_spawn_cancelled");
        gate.add_permits(100);
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert!(!harness
            .specs()
            .iter()
            .any(|s| s.labels.get(AGENT_ID_LABEL).map(String::as_str) == Some("bounded-7")));
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn a_probe_that_prints_success_but_exits_unsuccessfully_is_refused() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            125,
        );
        let error = harness
            .spawn(spawn_config("bad-probe", "kiro-cli", &[], &spec))
            .await
            .unwrap_err();
        assert_eq!(error.code, "sandbox_probe_failed");
        assert!(harness.admission.probes.lock().is_empty());
        assert!(!harness.specs().iter().any(|s| s.cmd[0] == "init-agent"));
    }

    #[tokio::test]
    async fn helper_deadline_also_bounds_container_start() {
        let spec = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("source", "kiro-cli", &[], &spec))
            .await
            .unwrap();
        let helper = harness.specs()[0].clone();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *harness.api.run_gate.lock() = Some(gate.clone());
        let removed_before = harness.api.removes.lock().len();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            harness.backend.run_once(
                helper,
                None,
                Duration::from_millis(5),
                OperationLeases::default(),
            ),
        )
        .await
        .expect("the helper's own deadline must cover start");
        assert!(matches!(result, Err(RunFailure::Timeout)));
        gate.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), async {
            while harness.api.removes.lock().len() == removed_before {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn a_cold_spawn_stages_the_bundle_probes_the_image_and_runs_the_agent_through_init() {
        let spec = spec(
            EgressTier::Allowlist,
            Some(DeclaredUser {
                name: Some("vscode".to_string()),
                uid: Some(1000),
                from: DeclaredUserSource::RemoteUser,
            }),
        );
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(
                vec![command("codex-acp", Some("@agentclientprotocol/codex-acp"))],
                Vec::new(),
            ),
            0,
        );

        let id = harness
            .spawn(spawn_config(
                "agent-1",
                "npx",
                &["-y", "@agentclientprotocol/codex-acp", "--stdio"],
                &spec,
            ))
            .await
            .expect("the sandbox starts");
        assert_eq!(id, "agent-1");

        let specs = harness.specs();
        let commands: Vec<Vec<String>> = specs.iter().map(|spec| spec.cmd.clone()).collect();
        assert_eq!(
            commands,
            vec![
                // The probe's volume holds only the libc-independent half.
                vec![
                    "install",
                    "--stage",
                    "core",
                    "--from",
                    "/opt/cognia",
                    "--to",
                    "/cognia"
                ],
                vec![
                    "probe",
                    "--root",
                    "/",
                    "--bundle",
                    "/cognia",
                    "--workspace",
                    "/workspace",
                    "--out",
                    "-",
                    "--user",
                    "vscode",
                    "--match-workspace-owner"
                ],
                // The agent's volume is self-contained: core, then its libc.
                vec![
                    "install",
                    "--stage",
                    "core",
                    "--from",
                    "/opt/cognia",
                    "--to",
                    "/cognia"
                ],
                vec![
                    "install",
                    "--stage",
                    "libc",
                    "--libc",
                    "glibc",
                    "--from",
                    "/opt/cognia",
                    "--to",
                    "/cognia"
                ],
                vec![
                    "init-agent",
                    "--root",
                    "/",
                    "--bundle",
                    "/cognia",
                    "--user",
                    "vscode",
                    "--match-owner-of",
                    "/workspace",
                    "--",
                    "/cognia/glibc/bin/codex-acp",
                    "--stdio"
                ],
            ]
        );

        // The staging containers see the bundle image and no workspace at all,
        // and run fully confined: no capabilities, a read-only rootfs, nothing
        // writable but the volume they fill.
        for staging in [&specs[0], &specs[2], &specs[3]] {
            assert_eq!(
                staging.image,
                "ghcr.io/cognia/agent-bundle@sha256:2222222222222222222222222222222222222222222222222222222222222222"
            );
            assert_eq!(staging.mount, None);
            assert_eq!(staging.network_mode, "none");
            assert!(!staging.extra_mounts[0].read_only);
            assert_eq!(staging.cap_drop, vec!["ALL".to_string()]);
            assert!(staging.cap_add.is_empty());
            assert!(staging.read_only_rootfs);
        }
        assert_eq!(
            specs[0].extra_mounts[0].volume,
            "cognia-dep1-bundle-222222222222-core"
        );
        assert_eq!(
            specs[2].extra_mounts[0].volume,
            "cognia-dep1-bundle-222222222222-glibc"
        );

        // The probe runs in the user's image, with the bundle read-only and
        // the workspace exactly as the agent will have it.
        let probe = &specs[1];
        assert_eq!(probe.image, format!("ghcr.io/acme/dev@{IMAGE_DIGEST}"));
        assert_eq!(
            probe.entrypoint,
            Some(vec!["/cognia/bin/cognia-sandboxd".to_string()])
        );
        assert_eq!(probe.user.as_deref(), Some("0"));
        assert_eq!(
            probe.mount,
            Some(RunnerMount::Bind {
                host_dir: CWD.to_string()
            })
        );
        assert!(probe.extra_mounts[0].read_only);
        // The probe is confined too: read-only rootfs, and of all the dropped
        // capabilities it keeps only DAC_OVERRIDE — writing the writability
        // marker into a workspace owned by the target uid needs it.
        assert_eq!(probe.cap_drop, vec!["ALL".to_string()]);
        assert_eq!(probe.cap_add, vec!["DAC_OVERRIDE".to_string()]);
        assert!(probe.read_only_rootfs);

        let agent = specs.last().expect("an agent container");
        assert_eq!(agent.name, "cognia-agent-agent-1");
        assert_eq!(agent.image, format!("ghcr.io/acme/dev@{IMAGE_DIGEST}"));
        assert_eq!(agent.working_dir, "/workspace");
        assert_eq!(agent.user.as_deref(), Some("0"));
        assert_eq!(
            agent.extra_mounts,
            vec![VolumeMount {
                volume: "cognia-dep1-bundle-222222222222-glibc".to_string(),
                target: "/cognia".to_string(),
                read_only: true,
            }]
        );
        assert_eq!(
            agent.labels.get(AGENT_ID_LABEL).map(String::as_str),
            Some("agent-1")
        );
        // Limits come from the admitted size class, not from the host's
        // legacy runner defaults.
        assert_eq!(agent.memory_bytes, 4096 * 1024 * 1024);
        assert_eq!(agent.nano_cpus, 1_500_000_000);
        assert_eq!(agent.runtime, None);
        let runtime = decode_agent_environment(&agent.env);
        assert_eq!(
            runtime
                .container_env
                .get("PROJECT_FLAG")
                .map(String::as_str),
            Some("1")
        );
        assert!(!runtime.spawn_env.contains_key("ANTHROPIC_API_KEY"));
        assert_eq!(runtime.lifecycle_phases.len(), 5);
        // Capability confinement: `init-agent` keeps only what its setuid
        // switch and the home handover use.
        assert_eq!(agent.cap_drop, vec!["ALL".to_string()]);
        assert_eq!(
            agent.cap_add,
            vec![
                "SETUID".to_string(),
                "SETGID".to_string(),
                "CHOWN".to_string(),
                "DAC_OVERRIDE".to_string(),
                "FOWNER".to_string(),
            ]
        );
        assert_eq!(agent.tmpfs, vec!["/tmp".to_string()]);
        assert_eq!(agent.pids_limit, 512);

        assert_eq!(
            harness.placement(),
            json!({
                "kind": "sandbox",
                "driver": "docker",
                "specDigest": spec.spec_digest,
                "image": format!("ghcr.io/acme/dev@{IMAGE_DIGEST}"),
                "sizeClassId": "small",
                "isolationTier": "container",
                "bundle": {
                    "digest": BUNDLE_DIGEST,
                    "releaseTag": "v1.2.3",
                    "libc": "glibc",
                },
                "command": "codex-acp",
                "user": {
                    "name": "vscode",
                    "uid": 10001,
                    "gid": 10001,
                    "remappedFrom": { "uid": 1000, "gid": 1000 },
                },
                "egress": { "tier": "allowlist", "enforced": false },
                "credentials": { "mode": "none" },
            })
        );
        // get_info repeats it, so a reconnecting UI does not need the event.
        let info = harness.backend.get_info("agent-1").await.expect("info");
        assert_eq!(info["placement"], harness.placement());
    }

    #[tokio::test]
    async fn ambient_provider_credentials_are_stripped_but_a_gateway_lease_passes() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        let mut spawn = spawn_config("agent-1", "kiro-cli", &[], &spec);
        spawn.env.extend([
            ("OPENAI_API_KEY".to_string(), "sk-openai".to_string()),
            (
                "OPENAI_BASE_URL".to_string(),
                "https://api.openai.com".to_string(),
            ),
            ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "oauth".to_string()),
            ("COGNIA_GATEWAY_KEY".to_string(), "cgx".to_string()),
            // A managed task's lease: not an ambient credential, so it must
            // reach the sandbox for the gateway route to work.
            ("COGNIA_GATEWAY_TASK_CONFIG".to_string(), "{}".to_string()),
            ("COGNIA_GATEWAY_TOKEN".to_string(), "lease".to_string()),
            ("DEEPSEEK_API_KEY".to_string(), "ds".to_string()),
            ("GITHUB_TOKEN".to_string(), "gh".to_string()),
        ]);
        harness.spawn(spawn).await.expect("the sandbox starts");

        let agent = harness.specs().last().cloned().expect("an agent container");
        let runtime = decode_agent_environment(&agent.env);
        let mut env = runtime.container_env;
        env.extend(runtime.spawn_env);
        for stripped in AMBIENT_CREDENTIAL_ENV {
            assert!(
                !env.contains_key(stripped),
                "{stripped} reached the runtime"
            );
        }
        for kept in [
            "COGNIA_GATEWAY_TASK_CONFIG",
            "COGNIA_GATEWAY_TOKEN",
            "DEEPSEEK_API_KEY",
            "GITHUB_TOKEN",
            "PROJECT_FLAG",
        ] {
            assert!(env.contains_key(kept), "{kept} was stripped");
        }
        assert_eq!(
            harness.placement()["credentials"]["mode"],
            json!("gateway-lease")
        );
    }

    #[tokio::test]
    async fn no_container_in_a_spawn_mounts_the_docker_socket() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("agent-1", "kiro-cli", &[], &spec))
            .await
            .expect("the sandbox starts");
        // Every container this driver launches — staging, probe, agent — is
        // checked, because a container that can reach the daemon's socket is
        // a container that can escape every bound above.
        for spec in harness.specs() {
            let targets: Vec<String> = spec
                .mount
                .iter()
                .filter_map(|mount| match mount {
                    RunnerMount::Bind { host_dir } => Some(host_dir.clone()),
                    _ => None,
                })
                .chain(spec.extra_mounts.iter().map(|mount| mount.target.clone()))
                .collect();
            assert!(
                targets
                    .iter()
                    .all(|target| !target.contains("docker") && !target.ends_with(".sock")),
                "{} mounts a docker socket: {targets:?}",
                spec.name
            );
        }
    }

    #[tokio::test]
    async fn a_second_spawn_reuses_the_staged_volumes_and_the_cached_probe() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("agent-1", "kiro-cli", &["acp"], &spec))
            .await
            .expect("the first sandbox starts");
        let cold = harness.specs().len();

        harness
            .spawn(spawn_config("agent-2", "kiro-cli", &["acp"], &spec))
            .await
            .expect("the second sandbox starts");
        let specs = harness.specs();
        assert_eq!(specs.len(), cold + 1, "only the agent container is new");
        assert_eq!(specs.last().unwrap().cmd.first().unwrap(), "init-agent");
        // No declared user: the plain-container tier default, never remapped.
        assert!(specs
            .last()
            .unwrap()
            .cmd
            .iter()
            .all(|arg| arg != "--match-owner-of"));
        assert!(specs
            .last()
            .unwrap()
            .cmd
            .windows(2)
            .any(|pair| pair == ["--user", "10001"]));
    }

    #[tokio::test]
    async fn a_command_the_bundle_cannot_run_is_refused_not_fallen_back() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(
                vec![command("codex-acp", Some("@agentclientprotocol/codex-acp"))],
                Vec::new(),
            ),
            0,
        );
        let error = harness
            .spawn(spawn_config(
                "agent-1",
                "gemini",
                &["--experimental-acp"],
                &spec,
            ))
            .await
            .expect_err("the bundle has no gemini for glibc");
        assert_eq!(error.code, "sandbox_command_unavailable");
        assert_eq!(error.kind, SandboxErrorKind::Refused);
        // Nothing started in the user's image.
        assert!(harness
            .specs()
            .iter()
            .all(|spec| spec.cmd.first().map(String::as_str) != Some("init-agent")));
    }

    #[tokio::test]
    async fn an_image_the_probe_rejects_refuses_with_the_probes_own_code() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            ProbeReport {
                libc: None,
                problems: vec![ProbeProblem {
                    code: ProbeCode::LibcUnsupported,
                    message: "the glibc version could not be read".to_string(),
                }],
                ..report(Vec::new(), Vec::new())
            },
            64,
        );
        let error = harness
            .spawn(spawn_config("agent-1", "kiro-cli", &[], &spec))
            .await
            .expect_err("an image with no usable libc cannot host the agent");
        assert_eq!(error.code, "probe_libc_unsupported");
        assert_eq!(error.kind, SandboxErrorKind::Refused);
        // An image-level verdict is cached: the next spawn refuses without
        // starting a container.
        assert!(harness
            .admission
            .cached_probe(IMAGE_DIGEST, BUNDLE_DIGEST)
            .is_some());
    }

    #[tokio::test]
    async fn a_workspace_verdict_is_never_cached_as_an_image_verdict() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            ProbeReport {
                workspace_writable: false,
                problems: vec![ProbeProblem {
                    code: ProbeCode::WorkspaceNotWritable,
                    message: "mode 755 owned by 0:0 does not allow uid 10001".to_string(),
                }],
                ..report(vec![command("kiro-cli", None)], Vec::new())
            },
            68,
        );
        let error = harness
            .spawn(spawn_config("agent-1", "kiro-cli", &[], &spec))
            .await
            .expect_err("an unwritable workspace refuses");
        assert_eq!(error.code, "probe_workspace_not_writable");
        assert_eq!(
            harness.admission.cached_probe(IMAGE_DIGEST, BUNDLE_DIGEST),
            None
        );
    }

    #[tokio::test]
    async fn a_daemon_that_does_not_answer_is_a_fault_the_run_can_fall_back_from() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        *harness.api.runtimes.lock() = Err("connection refused".to_string());
        let error = harness
            .spawn(spawn_config("agent-1", "kiro-cli", &[], &spec))
            .await
            .expect_err("a daemon that cannot be reached has no sandbox");
        assert_eq!(error.kind, SandboxErrorKind::Fault);
        assert_eq!(error.fallback_code(), "sandbox_fallback_daemon_unreachable");
    }

    #[tokio::test]
    async fn egress_off_cuts_the_network_and_no_other_tier_claims_enforcement() {
        for (tier, network, enforced) in [
            (EgressTier::Off, "none", true),
            (EgressTier::Allowlist, "bridge", false),
            (EgressTier::On, "bridge", false),
        ] {
            let spec = spec(tier, None);
            let harness = Harness::new(
                admitted(spec.clone(), IsolationTier::Container),
                report(vec![command("kiro-cli", None)], Vec::new()),
                0,
            );
            harness
                .spawn(spawn_config("agent-1", "kiro-cli", &[], &spec))
                .await
                .expect("the sandbox starts");
            let agent = harness.specs().last().cloned().expect("an agent container");
            assert_eq!(agent.network_mode, network, "{tier:?}");
            assert_eq!(
                harness.placement()["egress"]["enforced"],
                json!(enforced),
                "{tier:?}"
            );
        }
    }

    #[tokio::test]
    async fn gvisor_is_offered_to_admission_when_the_daemon_registers_runsc() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Gvisor),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        *harness.api.runtimes.lock() = Ok(vec!["runc".to_string(), "runsc".to_string()]);
        harness
            .spawn(spawn_config("agent-1", "kiro-cli", &[], &spec))
            .await
            .expect("the sandbox starts");
        assert_eq!(
            harness.admission.tiers_seen.lock().clone(),
            vec![vec![IsolationTier::Container, IsolationTier::Gvisor]]
        );
        let agent = harness.specs().last().cloned().expect("an agent container");
        assert_eq!(agent.runtime.as_deref(), Some("runsc"));
        // The stronger tier contains root, so an undeclared user is root.
        assert!(agent.cmd.windows(2).any(|pair| pair == ["--user", "0"]));
        assert_eq!(harness.placement()["isolationTier"], json!("gvisor"));
    }

    #[tokio::test]
    async fn a_plain_daemon_offers_only_the_container_tier() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec, IsolationTier::Container),
            report(Vec::new(), Vec::new()),
            0,
        );
        assert_eq!(
            harness.backend.available_tiers().await.unwrap(),
            vec![IsolationTier::Container]
        );
    }

    #[tokio::test]
    async fn bundle_volumes_for_a_bundle_no_longer_offered_are_swept() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("agent-1", "kiro-cli", &[], &spec))
            .await
            .expect("the sandbox starts");
        // A volume from an older release, and one belonging to another
        // deployment that happens to share the daemon.
        harness.api.volumes.lock().insert(
            "cognia-dep1-bundle-333333333333-glibc".to_string(),
            harness
                .backend
                .volume_labels("sha256:3333", Stage::Libc(Libc::Glibc)),
        );
        let mut foreign = harness.backend.volume_labels("sha256:4444", Stage::Core);
        foreign.insert(DEPLOYMENT_LABEL.to_string(), "dep2".to_string());
        harness
            .api
            .volumes
            .lock()
            .insert("cognia-dep2-bundle-444444444444-core".to_string(), foreign);

        let reaped = harness.backend.reap_orphans().await.expect("a sweep runs");
        assert_eq!(reaped, vec!["cognia-dep1-bundle-333333333333-glibc"]);
        // The current bundle's volumes and the other deployment's survive.
        let left: Vec<String> = harness.api.volumes.lock().keys().cloned().collect();
        assert_eq!(
            left,
            vec![
                "cognia-dep1-bundle-222222222222-core",
                "cognia-dep1-bundle-222222222222-glibc",
                "cognia-dep2-bundle-444444444444-core",
            ]
        );
    }

    #[tokio::test]
    async fn a_spawn_without_a_placement_or_a_workspace_is_refused() {
        let spec = spec(EgressTier::Allowlist, None);
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(Vec::new(), Vec::new()),
            0,
        );
        let mut without_placement = spawn_config("agent-1", "kiro-cli", &[], &spec);
        without_placement.sandbox = None;
        assert_eq!(
            harness.spawn(without_placement).await.unwrap_err().code,
            "sandbox_placement_required"
        );

        let mut without_cwd = spawn_config("agent-2", "kiro-cli", &[], &spec);
        without_cwd.cwd = None;
        assert_eq!(
            harness.spawn(without_cwd).await.unwrap_err().code,
            "sandbox_workspace_required"
        );

        let mut outside = spawn_config("agent-3", "kiro-cli", &[], &spec);
        outside.cwd = Some("/tmp/elsewhere".to_string());
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(Vec::new(), Vec::new()),
            0,
        );
        // Bind mode accepts any cwd; volume mode is where the root matters.
        let volume_config = DockerSandboxConfig {
            host: RunnerHostSettings {
                workspaces_volume: Some("cognia-workspaces".to_string()),
                ..host()
            },
            ..config()
        };
        let backend = DockerSandboxBackend::new(
            harness.api.clone(),
            harness.admission.clone(),
            volume_config,
        );
        let error = backend
            .spawn_sandboxed(outside, EmitterEventSink::new(harness.emitter.clone()))
            .await
            .unwrap_err();
        assert_eq!(error.code, "sandbox_workspace_outside_root");
        assert_eq!(error.kind, SandboxErrorKind::Refused);
    }

    #[test]
    fn a_cached_probe_is_only_reused_for_the_same_user_and_workspace_owner() {
        let user = UserSpec::Name("vscode".to_string());
        let owner = Some(Ownership {
            uid: 10001,
            gid: 10001,
        });
        let report = report(vec![command("kiro-cli", None)], Vec::new());
        let entry = cache_entry(&user, true, owner, &report);

        assert_eq!(
            cached_report(&entry, &user, true, owner),
            Some(report.clone())
        );
        // A different target user, a different remap answer, or a workspace
        // that changed hands all ask a different question.
        assert_eq!(
            cached_report(&entry, &UserSpec::Uid(10001), true, owner),
            None
        );
        assert_eq!(cached_report(&entry, &user, false, owner), None);
        assert_eq!(cached_report(&entry, &user, true, None), None);
        assert_eq!(
            cached_report(
                &entry,
                &user,
                true,
                Some(Ownership {
                    uid: 1000,
                    gid: 1000
                })
            ),
            None
        );
        // An entry from a future build is ignored, not misread.
        let mut newer = entry.clone();
        newer["version"] = json!(PROBE_CACHE_VERSION + 1);
        assert_eq!(cached_report(&newer, &user, true, owner), None);
    }

    #[test]
    fn a_volume_name_is_a_legal_docker_name_scoped_to_its_deployment() {
        let harness_config = config();
        let backend = DockerSandboxBackend::new(
            FakeContainerApi::new(),
            FakeAdmission::admitting(admitted(
                spec(EgressTier::Allowlist, None),
                IsolationTier::Container,
            )),
            harness_config,
        );
        assert_eq!(
            backend.volume_name(BUNDLE_DIGEST, Stage::Core),
            "cognia-dep1-bundle-222222222222-core"
        );
        assert_eq!(
            backend.volume_name(BUNDLE_DIGEST, Stage::Libc(Libc::Musl)),
            "cognia-dep1-bundle-222222222222-musl"
        );
        let name = backend.volume_name(BUNDLE_DIGEST, Stage::Core);
        assert!(name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')));
    }
}
