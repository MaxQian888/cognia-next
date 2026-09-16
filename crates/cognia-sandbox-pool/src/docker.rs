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
//! - **Credentials.** A sandbox receives the same `SpawnPolicy`-filtered
//!   environment the legacy runner received, provider keys included. The
//!   gateway's ticket-only sandbox ingress is ADR-0185 §②.7. The placement
//!   says `credentials.mode: "spawn-env"`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cognia_environment::image::PinnedImage;
use cognia_environment::spec::{
    DeclaredUser, EgressTier, EnvironmentSpec, IsolationTier, SpecUser,
};
use cognia_external_agent::container_backend::{
    default_instance_id, deployment_id_from_env, ownership_labels, reap_owned_orphans,
    remove_owned, sanitize_container_name, ContainerApi, RegistryAuth, RunnerEvent,
    RunnerHostSettings, RunnerMount, RunnerRegistry, RunnerRunError, RunnerSpec, RunningRunner,
    SandboxDockerApi, VolumeMount, VolumeRemoval, DEPLOYMENT_LABEL, OWNER_LABEL, OWNER_VALUE,
    SCHEMA_LABEL, SCHEMA_VERSION, WORKSPACE_TARGET,
};
use cognia_external_agent::exec_backend::ExecBackend;
use cognia_external_agent::process::{
    ExternalAgentEventSink, ExternalAgentProcessState, ExternalAgentSpawnConfig,
};
use cognia_external_agent::sandbox_routing_backend::{
    SandboxExecBackend, SandboxPlacement, SandboxSpawnError,
};
use cognia_sandboxd::layout::{Libc, INJECTION_ROOT, PROVIDED_ENV_VAR};
use cognia_sandboxd::passwd::UserSpec;
use cognia_sandboxd::probe::{Ownership, ProbeCode, ProbeReport, PROBE_REPORT_VERSION};
use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::admission::{AdmittedSandbox, SandboxAdmission};
use crate::command::{bundled_invocation, BundledInvocation};
use crate::probe_cache::ProbeCacheEntry;
use crate::status::SandboxDriverStatus;

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
    stage_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
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
        Arc::new(Self {
            runners: RunnerRegistry::new(Arc::clone(&container)),
            api,
            container,
            admission,
            config,
            stage_locks: Mutex::new(HashMap::new()),
            staged: Mutex::new(BTreeSet::new()),
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
        Arc::clone(
            self.stage_locks
                .lock()
                .entry(volume.to_string())
                .or_default(),
        )
    }

    /// Fill (or confirm) the volume for `stage` and return its name.
    async fn ensure_staged(
        &self,
        bundle: &PinnedImage,
        stage: Stage,
    ) -> Result<String, SandboxSpawnError> {
        let volume = self.volume_name(&bundle.digest, stage);
        if self.staged.lock().contains(&volume) {
            return Ok(volume);
        }
        let lock = self.stage_lock(&volume);
        let _guard = lock.lock().await;
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
            };
            let completed = self
                .run_once(spec, auth.clone(), STAGE_TIMEOUT)
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
        user: &UserSpec,
        match_owner: bool,
    ) -> Result<ProbeReport, SandboxSpawnError> {
        let image = admitted.spec.image.pinned();
        let bundle = admitted.admission.bundle.image();
        let owner = host_owner(Path::new(cwd));

        if let Some(entry) = self.admission.cached_probe(&image.digest, &bundle.digest) {
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
            name: sanitize_container_name(&format!("probe-{}", digest12(&image.digest))),
            image: image.canonical(),
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
        };

        let auth = self.admission.registry_auth(&image.registry)?;
        let completed = self
            .run_once(spec, auth, PROBE_TIMEOUT)
            .await
            .map_err(|failure| match failure {
                // An image that cannot be pulled is an answer about the image,
                // not about the infrastructure: running somewhere else would
                // silently do less than the project asked for.
                RunFailure::Pull(error) => SandboxSpawnError::refused(
                    "sandbox_image_unavailable",
                    format!("{} could not be pulled: {error}", image.canonical()),
                ),
                RunFailure::Start(error) => SandboxSpawnError::fault(
                    "sandbox_container_start_failed",
                    format!("the probe container did not start: {error}"),
                ),
                RunFailure::Timeout => SandboxSpawnError::refused(
                    "sandbox_probe_timeout",
                    format!("probing {} timed out", image.canonical()),
                ),
            })?;

        let report: Option<ProbeReport> = serde_json::from_slice(&completed.stdout).ok();
        let report = match (report, completed.code) {
            (Some(report), _) if report.version == PROBE_REPORT_VERSION => report,
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
                        image.canonical(),
                        completed.stderr_tail()
                    ),
                ));
            }
            (_, None) => {
                return Err(SandboxSpawnError::refused(
                    "sandbox_probe_failed",
                    format!("probing {} produced no result", image.canonical()),
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
                &image.digest,
                &bundle.digest,
                &cache_entry(user, match_owner, owner, &report),
            );
        }
        refuse_probe(&report).map_or(Ok(report), Err)
    }

    /// Create, start and wait for one helper container, then remove it.
    async fn run_once(
        &self,
        spec: RunnerSpec,
        auth: Option<RegistryAuth>,
        timeout: Duration,
    ) -> Result<Completed, RunFailure> {
        let running = self.start(spec, auth).await?;
        let container_id = running.container_id.clone();
        let collected = tokio::time::timeout(timeout, collect(running)).await;
        if collected.is_err() {
            let _ = self.api.kill(&container_id).await;
        }
        // Helper containers are single-use; the ownership check is what makes
        // removing one by a remembered id safe.
        let _ = remove_owned(&self.container, &container_id).await;
        collected.map_err(|_| RunFailure::Timeout)
    }

    /// Run `spec`, pulling its image once if the daemon does not have it.
    async fn start(
        &self,
        spec: RunnerSpec,
        auth: Option<RegistryAuth>,
    ) -> Result<RunningRunner, RunFailure> {
        match self.api.run(spec.clone()).await {
            Ok(running) => Ok(running),
            Err(RunnerRunError::ImageMissing(_)) => {
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
            match self.api.remove_volume(&volume.name).await {
                Ok(VolumeRemoval::Removed) => removed.push(volume.name),
                Ok(_) => {}
                Err(error) => log::warn!("cannot remove bundle volume {}: {error}", volume.name),
            }
        }
        removed
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

/// The environment the agent container gets: the project's declared variables,
/// then the spawn's own (already filtered by `SpawnPolicy`), then the list of
/// names the driver set — which is how `init-agent` tells a credential Cognia
/// provided from one baked into the image.
fn container_env(spec: &EnvironmentSpec, config: &ExternalAgentSpawnConfig) -> Vec<String> {
    let mut env: BTreeMap<String, String> = spec.container_env.clone();
    env.extend(
        config
            .env
            .iter()
            .map(|(name, value)| (name.clone(), value.clone())),
    );
    let provided = env.keys().cloned().collect::<Vec<_>>().join(",");
    env.insert(PROVIDED_ENV_VAR.to_string(), provided);
    env.into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect()
}

/// What the UI shows for an agent that got a sandbox.
fn sandbox_placement(
    admitted: &AdmittedSandbox,
    report: &ProbeReport,
    libc: Libc,
    invocation: &BundledInvocation,
) -> Value {
    let spec = &admitted.spec;
    let bundle = &admitted.admission.bundle;
    json!({
        "kind": "sandbox",
        "driver": "docker",
        "specDigest": spec.spec_digest,
        "image": spec.image.pinned().canonical(),
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
        "credentials": { "mode": "spawn-env" },
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

#[async_trait]
impl SandboxExecBackend for DockerSandboxBackend {
    async fn spawn_sandboxed(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, SandboxSpawnError> {
        let id = config.id.clone();
        if self.runners.contains(&id) {
            return Err(SandboxSpawnError::refused(
                "sandbox_agent_exists",
                format!("agent {id} already runs in a sandbox"),
            ));
        }
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
        let (user, match_owner) = target_user(&admitted.spec.user, admitted.admission.actual_tier);

        let core_volume = self.ensure_staged(&bundle, Stage::Core).await?;
        let report = self
            .probe_image(&admitted, &core_volume, &mount, &cwd, &user, match_owner)
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

        let libc_volume = self.ensure_staged(&bundle, Stage::Libc(libc)).await?;

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
            image: admitted.spec.image.pinned().canonical(),
            entrypoint: Some(vec![format!("{INJECTION_ROOT}/bin/cognia-sandboxd")]),
            cmd,
            env: container_env(&admitted.spec, &config),
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
            labels: ownership_labels(&id, &self.config.instance_id, &self.config.deployment_id),
            // Root so `init-agent` can switch to the target user; it exits 125
            // rather than running the agent as root by accident.
            user: Some("0".to_string()),
            extra_mounts: vec![VolumeMount {
                volume: libc_volume,
                target: INJECTION_ROOT.to_string(),
                read_only: true,
            }],
            runtime: runtime_for(admitted.admission.actual_tier),
        };

        let auth = self
            .admission
            .registry_auth(&admitted.spec.image.registry)?;
        let running = self
            .start(spec, auth)
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

        let placement = sandbox_placement(&admitted, &report, libc, &invocation);
        sink.sandbox_placement(&id, &placement);
        Ok(self.runners.adopt(config, running, Some(placement), sink))
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
    struct FakeAdmission {
        outcome: Mutex<Result<AdmittedSandbox, SandboxSpawnError>>,
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

    fn spec(egress: EgressTier, declared: Option<DeclaredUser>) -> EnvironmentSpec {
        EnvironmentSpec {
            version: 1,
            spec_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
                .to_string(),
            project_id: "proj-1".to_string(),
            source: EnvironmentSource::ProjectSetting {
                catalog_entry_id: "node-22".to_string(),
            },
            image: SpecImage {
                registry: "ghcr.io".to_string(),
                repository: "acme/dev".to_string(),
                digest: IMAGE_DIGEST.to_string(),
                catalog_entry_id: Some("node-22".to_string()),
                build_key: None,
            },
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

    fn admitted(spec: EnvironmentSpec, tier: IsolationTier) -> AdmittedSandbox {
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

    fn command(name: &str, package: Option<&str>) -> BundleCommand {
        BundleCommand {
            name: name.to_string(),
            package: package.map(str::to_string),
        }
    }

    fn report(commands: Vec<BundleCommand>, problems: Vec<ProbeProblem>) -> ProbeReport {
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

    fn spawn_config(
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

    struct Harness {
        api: Arc<FakeContainerApi>,
        admission: Arc<FakeAdmission>,
        backend: Arc<DockerSandboxBackend>,
        emitter: Arc<RecordingAgentEmitter>,
    }

    impl Harness {
        fn new(admitted: AdmittedSandbox, probe: ProbeReport, probe_code: i64) -> Self {
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

        async fn spawn(
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

        // The staging containers see the bundle image and no workspace at all.
        for staging in [&specs[0], &specs[2], &specs[3]] {
            assert_eq!(
                staging.image,
                "ghcr.io/cognia/agent-bundle@sha256:2222222222222222222222222222222222222222222222222222222222222222"
            );
            assert_eq!(staging.mount, None);
            assert_eq!(staging.network_mode, "none");
            assert!(!staging.extra_mounts[0].read_only);
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
        // The project's variables, the spawn's own, and the list that lets
        // `init-agent` tell them from the image's.
        assert_eq!(
            agent.env,
            vec![
                "ANTHROPIC_API_KEY=sk-test",
                "COGNIA_SANDBOXD_PROVIDED_ENV=ANTHROPIC_API_KEY,PROJECT_FLAG",
                "PROJECT_FLAG=1",
            ]
        );

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
                "credentials": { "mode": "spawn-env" },
            })
        );
        // get_info repeats it, so a reconnecting UI does not need the event.
        let info = harness.backend.get_info("agent-1").await.expect("info");
        assert_eq!(info["placement"], harness.placement());
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
