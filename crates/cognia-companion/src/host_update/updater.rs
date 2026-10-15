//! The host updater: check, wait for idle, swap, restart, then prove it.
//!
//! One instance per `cognia-server` process (the desktop app updates through
//! its own Update Center and has none). The flow:
//!
//! 1. **Check** the signed catalog for the host's channel and platform
//!    (`cognia-update-catalog`), then ask the update Worker whether that
//!    release is rolling for this host's bucket. Only a release the catalog
//!    signs *and* the Worker names, by version and digest, is available.
//! 2. **Wait for idle.** Automatic updates (on by default) and a requested
//!    one both wait until nothing would be cut off ([`super::idle`]).
//! 3. **Swap.** Download the archive, stage it beside the running version
//!    (checked against the catalog's sha256, version, platform and contract),
//!    pause writes, mark the update pending, repoint `current`, and restart.
//! 4. **Prove it.** The new process boots as a trial and commits once its
//!    brain is accepted and stays so; a refused brain, a missed deadline or
//!    repeated crashes roll `current` back ([`HostUpdater::supervise_trial`],
//!    `InstallHome::boot`).
//!
//! A Compose host runs no swap of its own. Its deploy agent
//! (`cognia-deploy-agent host-updates`) checks the catalog again, pulls the
//! image, recreates this container and proves the new version; the updater
//! still waits for idle and holds writes before it asks
//! ([`InstallKind::Compose`]). Without an agent it reports why it cannot
//! update.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cognia_host_service::install_home::{
    ExpectedRelease, HostManifest, InstallHome, PendingUpdate, UpdateOutcome,
};
use cognia_host_service::server::HostLayout;
use cognia_host_service::update_agent::{
    self as agent_wire, AgentPhase, AgentRequest, AgentResponse, AgentStatus, UpdateRequest,
};
use cognia_update_catalog::client::{check_host_release, HostCheck};
use cognia_update_catalog::{HostArtifact, HostRelease, RootPayload};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::Notify;

use super::idle::{IdleProbe, IdleReport};
use super::network::{UpdateNetwork, MAX_ARCHIVE_BYTES};
use super::settings::{normalize_channel, HostUpdateSettings, SettingsStore};

/// How long a new version has to prove itself before it is rolled back.
pub const TRIAL_WINDOW: Duration = Duration::from_secs(10 * 60);
/// How long its brain must stay accepted before the trial commits.
pub const TRIAL_SETTLE: Duration = Duration::from_secs(30);
/// Between automatic checks (plus up to half an hour of jitter).
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// The first automatic check, after the host has settled.
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(2 * 60);
/// Between idle checks while an update waits.
pub const IDLE_POLL: Duration = Duration::from_secs(60);
/// A status question to the deploy agent.
pub const AGENT_STATUS_TIMEOUT: Duration = Duration::from_secs(3);
/// An update request: the agent checks the catalog and pulls the image first.
pub const AGENT_UPDATE_TIMEOUT: Duration = Duration::from_secs(35 * 60);
/// After the agent accepts, how long until it must have restarted this host;
/// past it, writes resume and the update is reported as stuck.
pub const ACTIVATION_GRACE: Duration = Duration::from_secs(10 * 60);

/// Why a host cannot install updates itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnmanagedReason {
    /// The desktop app is serving: it updates through its own Update Center.
    DesktopApp,
    /// It runs from an unpacked archive rather than an install home; running
    /// `cognia-server service install` again moves it into one.
    NotInstalled,
    /// It runs from an install home but not as the OS service, so nothing
    /// would start it again after the swap.
    NotAService,
    /// A Compose host with no deploy agent to activate a new image.
    NoDeployAgent,
}

/// A Compose host's deploy agent, as the updater asks it.
#[async_trait]
pub trait UpdateAgent: Send + Sync {
    async fn ask(&self, request: AgentRequest) -> Result<AgentResponse, String>;
}

/// The agent listening at `COGNIA_HOST_UPDATE_SOCKET`.
pub struct SocketAgent {
    path: PathBuf,
}

impl SocketAgent {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

#[async_trait]
impl UpdateAgent for SocketAgent {
    async fn ask(&self, request: AgentRequest) -> Result<AgentResponse, String> {
        let timeout = match request {
            AgentRequest::Status => AGENT_STATUS_TIMEOUT,
            AgentRequest::Update(_) => AGENT_UPDATE_TIMEOUT,
        };
        agent_wire::call(&self.path, &request, timeout).await
    }
}

/// The deploy agent a Compose host updates through.
#[derive(Clone)]
pub struct ComposeAgent(pub Arc<dyn UpdateAgent>);

impl PartialEq for ComposeAgent {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for ComposeAgent {}

impl std::fmt::Debug for ComposeAgent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ComposeAgent")
    }
}

/// How this host is installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallKind {
    /// A macOS archive in an install home, run as the OS service.
    Native(InstallHome),
    /// The server image under Compose, with a deploy agent beside it.
    Compose(ComposeAgent),
    Unmanaged(UnmanagedReason),
}

/// What this host runs, and from where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostInstall {
    pub kind: InstallKind,
    /// The installed release.
    pub version: String,
    /// `darwin-arm64`, `oci-full-amd64`, …; `None` when unknown.
    pub target: Option<String>,
}

/// What [`HostInstall::detect`] looks at.
#[derive(Debug, Clone, Copy)]
pub struct DetectInput<'a> {
    pub current_exe: Option<&'a Path>,
    /// `COGNIA_SERVICE_MANAGED` is set: the OS service started this process.
    pub service_managed: bool,
    /// `COGNIA_HOST_TARGET`, set by the server image (`oci-<variant>-<arch>`).
    pub image_target: Option<&'a str>,
    /// `COGNIA_HOST_UPDATE_SOCKET`: the deploy agent beside a Compose host.
    pub update_agent_socket: Option<&'a Path>,
    /// This build's own version, for a host with no install manifest.
    pub compiled_version: &'a str,
}

impl HostInstall {
    pub fn detect(input: &DetectInput<'_>) -> Self {
        if let Some(exe) = input.current_exe {
            let manifest = HostLayout::from_server_binary(exe)
                .and_then(|layout| HostManifest::read(&layout.root).ok());
            if let Some(manifest) = manifest {
                let kind = match InstallHome::of_server_binary(exe) {
                    Some(home) if input.service_managed => InstallKind::Native(home),
                    Some(_) => InstallKind::Unmanaged(UnmanagedReason::NotAService),
                    None => InstallKind::Unmanaged(UnmanagedReason::NotInstalled),
                };
                return Self {
                    kind,
                    version: manifest.version,
                    target: Some(manifest.target),
                };
            }
        }
        let target = input
            .image_target
            .filter(|target| target.starts_with("oci-"));
        let kind = match (target, input.update_agent_socket) {
            (Some(_), Some(socket)) => {
                InstallKind::Compose(ComposeAgent(Arc::new(SocketAgent::new(socket))))
            }
            (Some(_), None) => InstallKind::Unmanaged(UnmanagedReason::NoDeployAgent),
            (None, _) => InstallKind::Unmanaged(UnmanagedReason::NotInstalled),
        };
        Self {
            kind,
            version: input.compiled_version.to_owned(),
            target: target.map(str::to_owned),
        }
    }

    /// The desktop app's own companion server.
    pub fn desktop_app(version: &str) -> Self {
        Self {
            kind: InstallKind::Unmanaged(UnmanagedReason::DesktopApp),
            version: version.to_owned(),
            target: None,
        }
    }
}

/// Where the updater is in its flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    WaitingForIdle,
    Downloading,
    Installing,
    Restarting,
    Trial,
}

/// A release this host may install now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableRelease {
    pub version: String,
    pub criticality: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub released_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialInfo {
    pub from: String,
    pub to: String,
    pub deadline_ms: i64,
}

/// `host_update_status`: everything the host panel shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostUpdateStatus {
    /// `native`, `compose` or `unmanaged`.
    pub install: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unmanaged_reason: Option<UnmanagedReason>,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub channel: String,
    pub auto_update: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_set_by: Option<String>,
    pub phase: UpdatePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<AvailableRelease>,
    /// Someone asked for the available release, or auto-update chose it.
    pub install_requested: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_for: Option<IdleReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_outcome: Option<UpdateOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trial: Option<TrialInfo>,
}

/// Holding writes off across the swap.
#[async_trait]
pub trait WriteGate: Send + Sync {
    /// Stop new writes and wait for the running ones; the returned guard
    /// keeps them stopped.
    async fn pause(&self) -> Result<Box<dyn std::any::Any + Send>, String>;
}

/// The companion API's own write pause (the one coordinated backup uses).
pub struct LiveWriteGate;

#[async_trait]
impl WriteGate for LiveWriteGate {
    async fn pause(&self) -> Result<Box<dyn std::any::Any + Send>, String> {
        crate::server::pause_writes()
            .await
            .map(|guard| Box::new(guard) as Box<dyn std::any::Any + Send>)
    }
}

/// What a trial reads about its own health.
pub trait TrialHealth: Send + Sync {
    fn signal(&self, baseline_failed_required: &[String]) -> TrialSignal;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrialSignal {
    /// The brain is connected and accepted.
    Healthy,
    /// The server refused its brain: the swap left them from different builds.
    Refused(String),
    Waiting,
}

/// The bridge's view of the brain.
pub struct LiveTrialHealth;

impl TrialHealth for LiveTrialHealth {
    fn signal(&self, baseline_failed_required: &[String]) -> TrialSignal {
        if let Some(refusal) = crate::ws_bridge::brain_refusal() {
            return TrialSignal::Refused(refusal.reason);
        }
        if crate::ws_bridge::bridge_ready()
            && trial_runtimes_ready(
                &crate::ws_bridge::brain_runtime_health(),
                baseline_failed_required,
            )
        {
            TrialSignal::Healthy
        } else {
            TrialSignal::Waiting
        }
    }
}

/// Existing external outages must not be attributed to the new build. A
/// bootstrap or restart still needs to finish before any trial can settle.
fn trial_runtimes_ready(
    health: &crate::ws_bridge::BrainRuntimeHealth,
    baseline_failed_required: &[String],
) -> bool {
    health.bootstrapped != Some(false)
        && health.restarting_required.is_empty()
        && health
            .failed_required
            .iter()
            .all(|name| baseline_failed_required.contains(name))
}

pub struct HostUpdaterDeps {
    pub network: Arc<dyn UpdateNetwork>,
    pub idle: Arc<dyn IdleProbe>,
    pub writes: Arc<dyn WriteGate>,
    /// Exit so the service manager starts `current` again.
    pub restart: Arc<dyn Fn() + Send + Sync>,
    /// Epoch ms.
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

/// Writes held off while the deploy agent recreates this container.
struct HeldWrites(#[allow(dead_code)] Box<dyn std::any::Any + Send>);

impl std::fmt::Debug for HeldWrites {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HeldWrites")
    }
}

#[derive(Debug, Default)]
struct Inner {
    phase: Option<UpdatePhase>,
    available: Option<HostRelease>,
    /// `Some(manual)` once an install of `available` is wanted.
    install_requested: Option<bool>,
    waiting_for: Option<IdleReport>,
    /// A version already staged on disk, so waiting does not re-download.
    staged: Option<String>,
    last_checked_at: Option<i64>,
    last_error: Option<String>,
    next_check_at: i64,
    trial: Option<PendingUpdate>,
    busy: bool,
    /// The deploy agent's last answer (Compose).
    agent: Option<AgentStatus>,
    agent_error: Option<String>,
    /// The agent accepted an update: writes stay held until this deadline,
    /// by which it must have restarted this host.
    activation_deadline: Option<i64>,
    held_writes: Option<HeldWrites>,
}

pub struct HostUpdater {
    install: HostInstall,
    trust_root: Option<RootPayload>,
    store: SettingsStore,
    deps: HostUpdaterDeps,
    inner: Mutex<Inner>,
    wake: Notify,
}

/// Released when an operation ends, however it ends.
struct BusyGuard<'a>(&'a Mutex<Inner>);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().busy = false;
    }
}

impl HostUpdater {
    pub fn new(
        data_dir: &Path,
        install: HostInstall,
        trust_root: Option<RootPayload>,
        deps: HostUpdaterDeps,
    ) -> Arc<Self> {
        let now = (deps.clock)();
        let updater = Self {
            install,
            trust_root,
            store: SettingsStore::new(data_dir),
            deps,
            inner: Mutex::new(Inner {
                next_check_at: now + FIRST_CHECK_DELAY.as_millis() as i64,
                ..Inner::default()
            }),
            wake: Notify::new(),
        };
        Arc::new(updater)
    }

    fn now(&self) -> i64 {
        (self.deps.clock)()
    }

    fn home(&self) -> Option<&InstallHome> {
        match &self.install.kind {
            InstallKind::Native(home) => Some(home),
            InstallKind::Compose(_) | InstallKind::Unmanaged(_) => None,
        }
    }

    pub fn settings(&self) -> HostUpdateSettings {
        self.store.load()
    }

    pub fn status(&self) -> HostUpdateStatus {
        let settings = self.store.load();
        let inner = self.inner.lock();
        let (install, unmanaged_reason) = match &self.install.kind {
            InstallKind::Native(_) => ("native", None),
            InstallKind::Compose(_) => ("compose", None),
            InstallKind::Unmanaged(reason) => ("unmanaged", Some(*reason)),
        };
        let agent = inner.agent.as_ref();
        let agent_phase = agent.map_or(AgentPhase::Idle, |agent| agent.phase);
        let phase = inner.phase.unwrap_or(
            if inner.trial.is_some() || agent_phase == AgentPhase::Trial {
                UpdatePhase::Trial
            } else if matches!(agent_phase, AgentPhase::Pulling | AgentPhase::Activating) {
                UpdatePhase::Installing
            } else if inner.available.is_some() {
                UpdatePhase::Available
            } else {
                UpdatePhase::Idle
            },
        );
        HostUpdateStatus {
            install,
            unmanaged_reason,
            current_version: self.install.version.clone(),
            target: self.install.target.clone(),
            channel: settings.channel,
            auto_update: settings.auto_update,
            channel_set_by: settings.channel_set_by,
            phase,
            available: inner.available.as_ref().map(|release| AvailableRelease {
                version: release.version.clone(),
                criticality: release.criticality.clone(),
                released_at: release.released_at.clone(),
                release_notes: release.release_notes.clone(),
            }),
            install_requested: inner.install_requested.is_some(),
            waiting_for: inner.waiting_for.clone(),
            last_checked_at: inner.last_checked_at,
            last_error: inner
                .last_error
                .clone()
                .or_else(|| inner.agent_error.clone())
                .or_else(|| agent.and_then(|agent| agent.last_error.clone())),
            last_outcome: self
                .home()
                .and_then(InstallHome::last_outcome)
                .or_else(|| agent.and_then(|agent| agent.last_outcome.clone())),
            trial: inner
                .trial
                .as_ref()
                .map(|pending| TrialInfo {
                    from: pending.from.clone(),
                    to: pending.to.clone(),
                    deadline_ms: pending.deadline_ms,
                })
                .or_else(|| {
                    agent
                        .and_then(|agent| agent.trial.as_ref())
                        .map(|trial| TrialInfo {
                            from: trial.from.clone(),
                            to: trial.to.clone(),
                            deadline_ms: trial.deadline_ms,
                        })
                }),
        }
    }

    /// Ask a Compose host's deploy agent where it is (nothing elsewhere).
    pub async fn refresh_agent(&self) {
        let InstallKind::Compose(agent) = &self.install.kind else {
            return;
        };
        let answer = agent.0.ask(AgentRequest::Status).await;
        let mut inner = self.inner.lock();
        match answer {
            Ok(AgentResponse::Status(status)) => {
                inner.agent = Some(status);
                inner.agent_error = None;
            }
            Ok(other) => {
                inner.agent = None;
                inner.agent_error = Some(format!(
                    "the deploy agent answered a status question with {other:?}"
                ));
            }
            Err(error) => {
                inner.agent = None;
                inner.agent_error = Some(error);
            }
        }
    }

    /// Change the channel or auto-update. A new channel drops what the old
    /// one offered and checks again soon.
    pub fn configure(
        &self,
        channel: Option<&str>,
        auto_update: Option<bool>,
        set_by: Option<&str>,
    ) -> Result<HostUpdateStatus, String> {
        let mut settings = self.store.load();
        let mut channel_changed = false;
        if let Some(raw) = channel {
            let channel = normalize_channel(raw)
                .ok_or_else(|| format!("{raw:?} is not a release channel (stable or beta)"))?;
            channel_changed = channel != settings.channel;
            settings.channel = channel.to_owned();
            settings.channel_set_by = set_by.map(str::to_owned);
            settings.channel_set_at_ms = Some(self.now());
        }
        if let Some(auto_update) = auto_update {
            settings.auto_update = auto_update;
        }
        self.store.save(&settings)?;
        if channel_changed {
            let mut inner = self.inner.lock();
            inner.available = None;
            inner.install_requested = None;
            inner.waiting_for = None;
            inner.next_check_at = self.now();
        }
        self.wake.notify_one();
        Ok(self.status())
    }

    fn begin(&self, phase: UpdatePhase) -> Result<BusyGuard<'_>, String> {
        let mut inner = self.inner.lock();
        if inner.trial.is_some() {
            return Err("an update is being verified; try again once it settles".into());
        }
        if inner.busy {
            return Err("an update operation is already running".into());
        }
        if inner.activation_deadline.is_some() {
            return Err("the deploy agent is switching this host to its update".into());
        }
        if inner
            .agent
            .as_ref()
            .is_some_and(|agent| agent.phase != AgentPhase::Idle)
        {
            return Err("the deploy agent is busy with an update".into());
        }
        inner.busy = true;
        inner.phase = Some(phase);
        Ok(BusyGuard(&self.inner))
    }

    /// Look for a release this host may install now.
    pub async fn check(&self, manual: bool) -> Result<HostUpdateStatus, String> {
        self.refresh_agent().await;
        let guard = self.begin(UpdatePhase::Checking)?;
        let result = self.check_inner(manual).await;
        {
            let mut inner = self.inner.lock();
            inner.phase = None;
            inner.last_checked_at = Some(self.now());
            match &result {
                Ok(available) => {
                    if inner.available.as_ref().map(|r| &r.version)
                        != available.as_ref().map(|r| &r.version)
                    {
                        inner.install_requested = None;
                        inner.waiting_for = None;
                    }
                    inner.available = available.clone();
                    inner.last_error = None;
                }
                Err(error) => inner.last_error = Some(error.clone()),
            }
        }
        drop(guard);
        result.map(|_| self.status())
    }

    async fn check_inner(&self, manual: bool) -> Result<Option<HostRelease>, String> {
        let settings = self.store.load();
        let target = self
            .install
            .target
            .clone()
            .ok_or("this host does not know which platform it runs on")?;
        let root = self
            .trust_root
            .as_ref()
            .ok_or("this build ships no update trust root")?;
        check_host_release(
            self.deps.network.as_ref(),
            root,
            &self.store.trust(),
            &HostCheck {
                channel: settings.channel,
                target,
                current_version: self.install.version.clone(),
                bucket: settings.rollout_bucket,
                manual,
                now_ms: self.now(),
            },
        )
        .await
    }

    /// Install the available release as soon as the host is idle.
    pub async fn request_install(&self) -> Result<HostUpdateStatus, String> {
        if let InstallKind::Unmanaged(reason) = self.install.kind {
            return Err(match reason {
                UnmanagedReason::DesktopApp => {
                    "this host is the desktop app; it updates from its own Update Center".into()
                }
                UnmanagedReason::NotInstalled => {
                    "this host does not run from an install home; run `cognia-server service install` again".into()
                }
                UnmanagedReason::NotAService => {
                    "this host is not running as its OS service, so nothing would restart it".into()
                }
                UnmanagedReason::NoDeployAgent => {
                    "this Compose host has no deploy agent to activate a new image".into()
                }
            });
        }
        if self.inner.lock().available.is_none() {
            self.check(true).await?;
        }
        {
            let mut inner = self.inner.lock();
            if inner.available.is_none() {
                return Err("this host is up to date".into());
            }
            inner.install_requested = Some(true);
        }
        self.wake.notify_one();
        Ok(self.status())
    }

    /// One step of the background flow: install a wanted release once idle.
    pub async fn tick(&self) {
        if self.activation_overdue() {
            return;
        }
        let (release, manual) = {
            let inner = self.inner.lock();
            if inner.busy || inner.trial.is_some() {
                return;
            }
            match (&inner.available, inner.install_requested) {
                (Some(release), Some(manual)) => (release.clone(), manual),
                _ => return,
            }
        };
        let report = self.deps.idle.report(self.now());
        if !report.is_idle() {
            let mut inner = self.inner.lock();
            inner.waiting_for = Some(report);
            inner.phase = Some(UpdatePhase::WaitingForIdle);
            return;
        }
        if let Err(error) = self.install(&release, manual).await {
            log::warn!(
                "host update: installing {} failed: {error}",
                release.version
            );
            let mut inner = self.inner.lock();
            inner.last_error = Some(error);
            inner.install_requested = None;
            inner.phase = None;
        }
    }

    /// Past the grace an accepted Compose update had to restart this host:
    /// resume writes and say so. `true` while an activation is pending.
    fn activation_overdue(&self) -> bool {
        let now = self.now();
        let released = {
            let mut inner = self.inner.lock();
            match inner.activation_deadline {
                None => return false,
                Some(deadline) if now <= deadline => return true,
                Some(_) => {
                    inner.activation_deadline = None;
                    inner.phase = None;
                    inner.last_error = Some(
                        "the deploy agent accepted the update but did not restart this host".into(),
                    );
                    inner.held_writes.take()
                }
            }
        };
        drop(released);
        log::warn!("host update: the deploy agent did not restart this host; writes resume");
        true
    }

    /// A Compose host: hold writes, then have the deploy agent check the
    /// catalog itself, pull, and recreate this container.
    async fn install_through_agent(
        &self,
        agent: &ComposeAgent,
        release: &HostRelease,
        manual: bool,
    ) -> Result<(), String> {
        if !matches!(release.artifact, HostArtifact::Image { .. }) {
            return Err("a Compose host installs images, not archives".into());
        }
        let guard = self.begin(UpdatePhase::Installing)?;
        self.inner.lock().waiting_for = None;
        let writes = self.deps.writes.pause().await?;
        let report = self.deps.idle.report(self.now());
        if !report.is_idle() {
            drop(writes);
            let mut inner = self.inner.lock();
            inner.waiting_for = Some(report);
            inner.phase = Some(UpdatePhase::WaitingForIdle);
            return Ok(());
        }
        let settings = self.store.load();
        let answer = agent
            .0
            .ask(AgentRequest::Update(UpdateRequest {
                channel: settings.channel,
                bucket: settings.rollout_bucket,
                manual,
                current_version: self.install.version.clone(),
                expect_version: release.version.clone(),
            }))
            .await;
        match answer {
            Ok(AgentResponse::Accepted(accepted)) => {
                log::info!(
                    "host update: the deploy agent is switching {} → {}",
                    accepted.from,
                    accepted.to
                );
                let mut inner = self.inner.lock();
                inner.phase = Some(UpdatePhase::Restarting);
                inner.install_requested = None;
                inner.available = None;
                inner.activation_deadline = Some(self.now() + ACTIVATION_GRACE.as_millis() as i64);
                inner.held_writes = Some(HeldWrites(writes));
                drop(inner);
                drop(guard);
                Ok(())
            }
            Ok(AgentResponse::Refused { error }) => {
                drop(writes);
                Err(format!("the deploy agent refused: {error}"))
            }
            Ok(AgentResponse::Status(_)) => {
                drop(writes);
                Err("the deploy agent answered an update with its status".into())
            }
            Err(error) => {
                drop(writes);
                Err(error)
            }
        }
    }

    async fn install(&self, release: &HostRelease, manual: bool) -> Result<(), String> {
        if let InstallKind::Compose(agent) = &self.install.kind {
            return self.install_through_agent(agent, release, manual).await;
        }
        let home = self
            .home()
            .ok_or("this host cannot install updates itself")?
            .clone();
        let HostArtifact::Archive {
            url,
            sha256,
            size_bytes,
        } = &release.artifact
        else {
            return Err("a native host installs archives, not images".into());
        };
        let guard = self.begin(UpdatePhase::Downloading)?;
        self.inner.lock().waiting_for = None;
        let staged = self.inner.lock().staged.clone();
        if staged.as_deref() != Some(release.version.as_str())
            || !home.version_dir(&release.version).is_dir()
        {
            let downloads = home.root().join("downloads");
            let file = downloads.join(format!(
                "cognia-host-{}-{}.tar.gz",
                release.version, release.target
            ));
            let partial = file.with_extension("partial");
            std::fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
            let result = self
                .deps
                .network
                .download(url, &partial, size_bytes.unwrap_or(MAX_ARCHIVE_BYTES))
                .await
                .and_then(|()| std::fs::rename(&partial, &file).map_err(|e| e.to_string()));
            if let Err(error) = result {
                let _ = std::fs::remove_file(&partial);
                return Err(error);
            }
            self.inner.lock().phase = Some(UpdatePhase::Installing);
            let expected = ExpectedRelease {
                version: release.version.clone(),
                target: release.target.clone(),
                sha256: sha256.clone(),
                contract_version: release.contract_version,
                catalog_hash: release.catalog_hash.clone(),
            };
            let stage_home = home.clone();
            let stage_file = file.clone();
            let staged = tokio::task::spawn_blocking(move || {
                stage_home.stage_archive(&stage_file, &expected)
            })
            .await
            .map_err(|error| error.to_string())?;
            let _ = std::fs::remove_file(&file);
            staged.map_err(|error| error.to_string())?;
            self.inner.lock().staged = Some(release.version.clone());
        }

        // The last gate: still idle, writes held off, then switch.
        self.inner.lock().phase = Some(UpdatePhase::Installing);
        let report = self.deps.idle.report(self.now());
        if !report.is_idle() {
            let mut inner = self.inner.lock();
            inner.waiting_for = Some(report);
            inner.phase = Some(UpdatePhase::WaitingForIdle);
            return Ok(());
        }
        let writes = self.deps.writes.pause().await?;
        let report = self.deps.idle.report(self.now());
        if !report.is_idle() {
            drop(writes);
            let mut inner = self.inner.lock();
            inner.waiting_for = Some(report);
            inner.phase = Some(UpdatePhase::WaitingForIdle);
            return Ok(());
        }
        let now = self.now();
        let to = release.version.clone();
        let switch_home = home.clone();
        let baseline = self.deps.idle.runtime_baseline()?;
        let pending = tokio::task::spawn_blocking(move || {
            switch_home.begin_switch(&to, now, TRIAL_WINDOW.as_millis() as i64, baseline)
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
        log::info!(
            "host update: switched {} → {}; restarting to prove it",
            pending.from,
            pending.to
        );
        self.inner.lock().phase = Some(UpdatePhase::Restarting);
        // Writes stay paused until the process is gone.
        std::mem::forget(writes);
        drop(guard);
        (self.deps.restart)();
        Ok(())
    }

    /// The background loop: automatic checks, and installs once idle.
    pub async fn run(self: Arc<Self>) {
        loop {
            self.refresh_agent().await;
            let now = self.now();
            let settings = self.store.load();
            let due = {
                let inner = self.inner.lock();
                settings.auto_update && inner.trial.is_none() && now >= inner.next_check_at
            };
            if due {
                match self.check(false).await {
                    Ok(status) if status.available.is_some() => {
                        let mut inner = self.inner.lock();
                        inner.install_requested.get_or_insert(false);
                    }
                    Ok(_) => {}
                    Err(error) => log::info!("host update: check failed: {error}"),
                }
                let jitter = rand::random::<u64>() % (30 * 60 * 1000);
                self.inner.lock().next_check_at =
                    self.now() + CHECK_INTERVAL.as_millis() as i64 + jitter as i64;
            }
            self.tick().await;
            let wait = {
                let inner = self.inner.lock();
                if inner.install_requested.is_some() || inner.activation_deadline.is_some() {
                    IDLE_POLL
                } else {
                    let until = (inner.next_check_at - self.now()).max(1_000) as u64;
                    Duration::from_millis(until.min(15 * 60 * 1000))
                }
            };
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = self.wake.notified() => {}
            }
        }
    }

    /// Prove a new version (this process): commit once its brain has stayed
    /// accepted for [`TRIAL_SETTLE`], roll back on a refused brain or at the
    /// deadline. Rolling back restarts into the version it came from.
    pub async fn supervise_trial(
        self: Arc<Self>,
        home: InstallHome,
        pending: PendingUpdate,
        health: Arc<dyn TrialHealth>,
        poll: Duration,
        settle: Duration,
    ) -> UpdateOutcome {
        self.inner.lock().trial = Some(pending.clone());
        let mut healthy_since: Option<i64> = None;
        let outcome = loop {
            let now = self.now();
            match health.signal(&pending.baseline_failed_required_runtimes) {
                TrialSignal::Refused(reason) => {
                    break self.finish_trial(
                        &home,
                        Err(format!("its server refused its brain ({reason})")),
                    );
                }
                TrialSignal::Healthy => {
                    let since = *healthy_since.get_or_insert(now);
                    if now - since >= settle.as_millis() as i64 {
                        break self.finish_trial(&home, Ok(()));
                    }
                }
                TrialSignal::Waiting => healthy_since = None,
            }
            if now > pending.deadline_ms {
                break self.finish_trial(&home, Err("it did not become healthy in time".into()));
            }
            tokio::time::sleep(poll).await;
        };
        outcome
    }

    fn finish_trial(&self, home: &InstallHome, result: Result<(), String>) -> UpdateOutcome {
        let now = self.now();
        let outcome = match &result {
            Ok(()) => home.commit(now),
            Err(reason) => home.roll_back(reason, now),
        };
        self.inner.lock().trial = None;
        match outcome {
            Ok(Some(outcome)) => {
                if result.is_err() {
                    log::error!(
                        "host update: {} rolled back to {}: {}",
                        outcome.to,
                        outcome.from,
                        outcome.reason.as_deref().unwrap_or("")
                    );
                    (self.deps.restart)();
                } else {
                    log::info!("host update: {} is installed", outcome.to);
                }
                outcome
            }
            other => {
                let error = match other {
                    Err(error) => error.to_string(),
                    _ => "the pending update marker is gone".to_owned(),
                };
                log::error!("host update: could not finish the trial: {error}");
                (self.deps.restart)();
                UpdateOutcome {
                    attempt_id: String::new(),
                    from: String::new(),
                    to: self.install.version.clone(),
                    result: cognia_host_service::install_home::UpdateResult::RolledBack,
                    reason: Some(error),
                    at_ms: now,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! The host updater against a fake Worker, a real install home and signed
    //! catalogs built with the conformance fixture's keys.

    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use async_trait::async_trait;
    use cognia_host_service::install_home::{InstallHome, UpdateOutcome, UpdateResult};
    use cognia_host_service::test_support::{write_archive, write_install};
    use cognia_host_service::update_agent::{
        AcceptedUpdate, AgentPhase, AgentRequest, AgentResponse, AgentStatus, AgentTrial,
    };
    use cognia_update_catalog::test_support::{host_release_entries, root, sign_bundle};
    use parking_lot::Mutex;
    use serde_json::{json, Value};

    use super::{
        trial_runtimes_ready, ComposeAgent, DetectInput, HostInstall, HostUpdater, HostUpdaterDeps,
        InstallKind, TrialHealth, TrialSignal, UnmanagedReason, UpdateAgent, UpdatePhase,
        WriteGate, ACTIVATION_GRACE,
    };
    use crate::host_update::idle::{IdleProbe, IdleReport};
    use crate::host_update::network::{RolloutAnswer, RolloutQuery, UpdateNetwork};

    const TARGET: &str = "darwin-arm64";
    const BASE_MS: i64 = 1_760_000_000_000;

    #[derive(Default)]
    struct FakeNetwork {
        catalog: Mutex<Option<Value>>,
        rollout: Mutex<Option<RolloutAnswer>>,
        archive: Mutex<Option<PathBuf>>,
        rollout_queries: Mutex<Vec<RolloutQuery>>,
        downloads: AtomicUsize,
    }

    #[async_trait]
    impl UpdateNetwork for FakeNetwork {
        async fn catalog(&self, _channel: &str) -> Result<Option<Value>, String> {
            Ok(self.catalog.lock().clone())
        }

        async fn rollout(&self, query: &RolloutQuery) -> Result<Option<RolloutAnswer>, String> {
            self.rollout_queries.lock().push(query.clone());
            Ok(self.rollout.lock().clone())
        }

        async fn download(&self, _url: &str, destination: &Path, _max: u64) -> Result<(), String> {
            self.downloads.fetch_add(1, Ordering::SeqCst);
            let source = self.archive.lock().clone().ok_or("no archive")?;
            std::fs::copy(source, destination)
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
    }

    /// Reports in order, repeating the last one.
    struct FakeIdle(Mutex<Vec<IdleReport>>, Mutex<Result<Vec<String>, String>>);

    impl FakeIdle {
        fn set(&self, reports: Vec<IdleReport>) {
            *self.0.lock() = reports;
        }
    }

    impl IdleProbe for FakeIdle {
        fn runtime_baseline(&self) -> Result<Vec<String>, String> {
            self.1.lock().clone()
        }
        fn report(&self, _now_ms: i64) -> IdleReport {
            let mut reports = self.0.lock();
            if reports.len() > 1 {
                reports.remove(0)
            } else {
                reports[0].clone()
            }
        }
    }

    /// Counts pauses, and how many pause guards are still held.
    #[derive(Default)]
    struct FakeWrites(AtomicUsize, Arc<AtomicUsize>);

    struct PauseGuard(Arc<AtomicUsize>);

    impl Drop for PauseGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    impl FakeWrites {
        fn held(&self) -> usize {
            self.1.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl WriteGate for FakeWrites {
        async fn pause(&self) -> Result<Box<dyn std::any::Any + Send>, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            self.1.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(PauseGuard(Arc::clone(&self.1))))
        }
    }

    struct FixedHealth(TrialSignal);

    impl TrialHealth for FixedHealth {
        fn signal(&self, _: &[String]) -> TrialSignal {
            self.0.clone()
        }
    }

    fn quiet() -> IdleReport {
        IdleReport {
            active_runs: Some(0),
            ..IdleReport::default()
        }
    }

    struct Harness {
        _tmp: tempfile::TempDir,
        home: InstallHome,
        network: Arc<FakeNetwork>,
        idle: Arc<FakeIdle>,
        writes: Arc<FakeWrites>,
        restarts: Arc<AtomicUsize>,
        updater: Arc<HostUpdater>,
        archive_sha: String,
    }

    /// A native host on 1.4.0, a signed 1.5.0 release, and a Worker rolling it.
    fn harness() -> Harness {
        harness_with(|home| InstallKind::Native(home.clone()), true)
    }

    fn harness_with(kind: impl FnOnce(&InstallHome) -> InstallKind, trust: bool) -> Harness {
        let tmp = tempfile::tempdir().unwrap();
        let unpacked = tmp.path().join("unpacked");
        write_install(&unpacked, "1.4.0", TARGET);
        let data = tmp.path().join("data");
        let home = InstallHome::in_data_dir(&data);
        home.adopt(&unpacked).unwrap();
        let (archive, archive_sha) = write_archive(tmp.path(), "1.5.0", TARGET, |_| {});

        let network = Arc::new(FakeNetwork::default());
        *network.catalog.lock() = Some(sign_bundle(
            host_release_entries(
                "1.5.0",
                "stable",
                TARGET,
                json!({ "url": "https://example.test/host.tar.gz", "sha256": archive_sha }),
            ),
            1,
            chrono::DateTime::from_timestamp_millis(BASE_MS).unwrap(),
        ));
        *network.rollout.lock() = Some(RolloutAnswer {
            version: "1.5.0".into(),
            digest: Some(archive_sha.clone()),
        });
        *network.archive.lock() = Some(archive);
        let idle = Arc::new(FakeIdle(
            Mutex::new(vec![quiet()]),
            Mutex::new(Ok(Vec::new())),
        ));
        let writes = Arc::new(FakeWrites::default());
        let restarts = Arc::new(AtomicUsize::new(0));
        let start = tokio::time::Instant::now();
        let restart_count = Arc::clone(&restarts);
        let updater = HostUpdater::new(
            &data,
            HostInstall {
                kind: kind(&home),
                version: "1.4.0".into(),
                target: Some(TARGET.into()),
            },
            trust.then(root),
            HostUpdaterDeps {
                network: network.clone(),
                idle: idle.clone(),
                writes: writes.clone(),
                restart: Arc::new(move || {
                    restart_count.fetch_add(1, Ordering::SeqCst);
                }),
                clock: Arc::new(move || BASE_MS + start.elapsed().as_millis() as i64),
            },
        );
        Harness {
            _tmp: tmp,
            home,
            network,
            idle,
            writes,
            restarts,
            updater,
            archive_sha,
        }
    }

    #[tokio::test]
    async fn offers_a_release_the_catalog_signs_and_the_worker_rolls() {
        let h = harness();
        let status = h.updater.check(false).await.unwrap();
        assert_eq!(status.available.unwrap().version, "1.5.0");
        assert_eq!(status.phase, UpdatePhase::Available);
        assert_eq!(status.install, "native");
        assert!(status.last_checked_at.is_some());
        let query = h.network.rollout_queries.lock()[0].clone();
        assert_eq!(
            (
                query.target.as_str(),
                query.current_version.as_str(),
                query.manual
            ),
            (TARGET, "1.4.0", false)
        );
    }

    #[tokio::test]
    async fn the_worker_can_hold_a_release_back_but_never_substitute_one() {
        let h = harness();
        for answer in [
            None,
            Some(RolloutAnswer {
                version: "1.5.0".into(),
                digest: Some("0".repeat(64)),
            }),
            Some(RolloutAnswer {
                version: "1.6.0".into(),
                digest: Some(h.archive_sha.clone()),
            }),
        ] {
            *h.network.rollout.lock() = answer;
            let status = h.updater.check(false).await.unwrap();
            assert!(status.available.is_none());
            assert_eq!(status.phase, UpdatePhase::Idle);
        }
    }

    #[tokio::test]
    async fn an_unverifiable_catalog_is_an_error_never_an_update() {
        let h = harness();
        h.network.catalog.lock().as_mut().unwrap()["targets"]["signed"]["entries"][0]["url"] =
            json!("https://elsewhere.test/host.tar.gz");
        let error = h.updater.check(false).await.unwrap_err();
        assert!(error.contains("targets"), "{error}");
        let status = h.updater.status();
        assert!(status.available.is_none());
        assert_eq!(status.last_error.as_deref(), Some(error.as_str()));

        let untrusting = harness_with(|home| InstallKind::Native(home.clone()), false);
        assert!(untrusting
            .updater
            .check(false)
            .await
            .unwrap_err()
            .contains("trust root"));
    }

    #[tokio::test]
    async fn a_new_channel_drops_what_the_old_one_offered() {
        let h = harness();
        h.updater.check(false).await.unwrap();
        assert!(h
            .updater
            .configure(Some("nightly"), None, None)
            .unwrap_err()
            .contains("not a release channel"));
        let status = h
            .updater
            .configure(Some("beta"), Some(false), Some("owner-phone"))
            .unwrap();
        assert_eq!(status.channel, "beta");
        assert!(!status.auto_update);
        assert_eq!(status.channel_set_by.as_deref(), Some("owner-phone"));
        assert!(status.available.is_none());
        // Settings outlive the process.
        assert_eq!(h.updater.settings().channel, "beta");
    }

    #[tokio::test(start_paused = true)]
    async fn an_update_waits_for_idle_then_swaps_and_restarts() {
        let h = harness();
        h.idle.set(vec![IdleReport {
            active_runs: Some(2),
            jobs: 1,
            ..IdleReport::default()
        }]);
        let status = h.updater.request_install().await.unwrap();
        assert!(status.install_requested);
        h.updater.tick().await;
        let status = h.updater.status();
        assert_eq!(status.phase, UpdatePhase::WaitingForIdle);
        assert_eq!(status.waiting_for.unwrap().active_runs, Some(2));
        assert_eq!(h.restarts.load(Ordering::SeqCst), 0);
        assert_eq!(h.home.current_version().as_deref(), Some("1.4.0"));

        h.idle.set(vec![quiet()]);
        h.updater.tick().await;
        assert_eq!(h.updater.status().last_error, None);
        assert_eq!(h.network.downloads.load(Ordering::SeqCst), 1);
        assert_eq!(h.writes.0.load(Ordering::SeqCst), 1);
        assert_eq!(h.home.current_version().as_deref(), Some("1.5.0"));
        let pending = h.home.pending().unwrap();
        assert_eq!(
            (pending.from.as_str(), pending.to.as_str()),
            ("1.4.0", "1.5.0")
        );
        assert_eq!(h.restarts.load(Ordering::SeqCst), 1);
        assert_eq!(h.updater.status().phase, UpdatePhase::Restarting);
        // The download does not linger.
        assert!(!h
            .home
            .root()
            .join("downloads")
            .join("cognia-host-1.5.0-darwin-arm64.tar.gz")
            .exists());
    }

    #[tokio::test(start_paused = true)]
    async fn a_switch_persists_the_pre_update_required_failure_baseline() {
        let h = harness();
        *h.idle.1.lock() = Ok(vec!["connector-runtime".into()]);
        h.updater.request_install().await.unwrap();
        h.updater.tick().await;
        assert_eq!(h.home.current_version().as_deref(), Some("1.5.0"));
        assert_eq!(
            h.home.pending().unwrap().baseline_failed_required_runtimes,
            vec!["connector-runtime"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_unavailable_runtime_baseline_does_not_switch_or_hold_writes() {
        let h = harness();
        *h.idle.1.lock() = Err("runtime baseline unavailable".into());
        h.updater.request_install().await.unwrap();
        h.updater.tick().await;
        assert_eq!(h.home.current_version().as_deref(), Some("1.4.0"));
        assert!(h.home.pending().is_none());
        assert_eq!(h.restarts.load(Ordering::SeqCst), 0);
        assert_eq!(h.writes.held(), 0);
        assert_eq!(
            h.updater.status().last_error.as_deref(),
            Some("runtime baseline unavailable")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_host_that_turns_busy_at_the_last_gate_keeps_the_staged_version() {
        let h = harness();
        h.updater.request_install().await.unwrap();
        let busy = IdleReport {
            active_runs: Some(1),
            ..IdleReport::default()
        };
        // Idle when the tick looks, busy by the time it would switch.
        h.idle.set(vec![quiet(), busy]);
        h.updater.tick().await;
        assert!(h.home.version_dir("1.5.0").is_dir(), "staged");
        assert_eq!(h.home.current_version().as_deref(), Some("1.4.0"));
        assert_eq!(h.updater.status().phase, UpdatePhase::WaitingForIdle);
        assert_eq!(h.restarts.load(Ordering::SeqCst), 0);

        // Once idle again it switches without downloading twice.
        h.idle.set(vec![quiet()]);
        h.updater.tick().await;
        assert_eq!(h.network.downloads.load(Ordering::SeqCst), 1);
        assert_eq!(h.home.current_version().as_deref(), Some("1.5.0"));
        assert_eq!(h.restarts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_host_that_cannot_install_says_why() {
        for (reason, phrase) in [
            (UnmanagedReason::NotInstalled, "service install"),
            (UnmanagedReason::NotAService, "OS service"),
            (UnmanagedReason::NoDeployAgent, "deploy agent"),
            (UnmanagedReason::DesktopApp, "Update Center"),
        ] {
            let h = harness_with(|_| InstallKind::Unmanaged(reason), true);
            let error = h.updater.request_install().await.unwrap_err();
            assert!(error.contains(phrase), "{reason:?}: {error}");
            // It can still say what is available.
            assert!(h.updater.check(false).await.unwrap().available.is_some());
            assert_eq!(h.updater.status().install, "unmanaged");
        }
    }

    /// Stage 1.5.0 and switch to it, as the previous process did.
    fn switched(h: &Harness) -> cognia_host_service::install_home::PendingUpdate {
        let archive = h.network.archive.lock().clone().unwrap();
        h.home
            .stage_archive(
                &archive,
                &cognia_host_service::install_home::ExpectedRelease {
                    version: "1.5.0".into(),
                    target: TARGET.into(),
                    sha256: h.archive_sha.clone(),
                    contract_version: 3,
                    catalog_hash: cognia_host_service::test_support::TEST_CATALOG_HASH.into(),
                },
            )
            .unwrap();
        h.home
            .begin_switch("1.5.0", BASE_MS, 10 * 60 * 1000, Vec::new())
            .unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn a_trial_commits_once_its_brain_stays_accepted() {
        let h = harness();
        let pending = switched(&h);
        let outcome = Arc::clone(&h.updater)
            .supervise_trial(
                h.home.clone(),
                pending,
                Arc::new(FixedHealth(TrialSignal::Healthy)),
                Duration::from_secs(1),
                Duration::from_secs(30),
            )
            .await;
        assert_eq!(outcome.result, UpdateResult::Installed);
        assert_eq!(h.home.current_version().as_deref(), Some("1.5.0"));
        assert_eq!(h.home.pending(), None);
        assert_eq!(h.restarts.load(Ordering::SeqCst), 0);
        assert_eq!(h.updater.status().last_outcome.unwrap().to, "1.5.0");
    }

    fn runtime_health(failed: &[&str]) -> crate::ws_bridge::BrainRuntimeHealth {
        crate::ws_bridge::BrainRuntimeHealth {
            bootstrapped: Some(true),
            failed: failed.iter().map(|name| (*name).to_owned()).collect(),
            failed_required: failed.iter().map(|name| (*name).to_owned()).collect(),
            restarting_required: Vec::new(),
        }
    }

    #[test]
    fn native_trial_requires_bootstrap_and_restart_completion_but_exempts_old_failures() {
        let baseline = vec!["connector-runtime".into()];
        let mut health = runtime_health(&["connector-runtime"]);
        assert!(trial_runtimes_ready(&health, &baseline));
        assert!(!trial_runtimes_ready(&health, &[]));
        health.failed_required.push("scheduler".into());
        assert!(!trial_runtimes_ready(&health, &baseline));
        health.failed_required.pop();
        health.bootstrapped = Some(false);
        assert!(!trial_runtimes_ready(&health, &baseline));
        health.bootstrapped = Some(true);
        health.restarting_required.push("connector-runtime".into());
        assert!(!trial_runtimes_ready(&health, &baseline));
        let mut legacy = runtime_health(&[]);
        legacy.bootstrapped = None;
        legacy.failed = vec!["scheduler".into()];
        assert!(trial_runtimes_ready(&legacy, &[]));
        let mut optional = runtime_health(&[]);
        optional.failed = vec!["backup-scheduler".into()];
        assert!(trial_runtimes_ready(&optional, &[]));
    }

    struct RuntimeHealthSequence(Mutex<Vec<crate::ws_bridge::BrainRuntimeHealth>>);

    impl TrialHealth for RuntimeHealthSequence {
        fn signal(&self, baseline: &[String]) -> TrialSignal {
            let mut remaining = self.0.lock();
            let health = if remaining.len() > 1 {
                remaining.remove(0)
            } else {
                remaining[0].clone()
            };
            if trial_runtimes_ready(&health, baseline) {
                TrialSignal::Healthy
            } else {
                TrialSignal::Waiting
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn native_trial_ignores_only_failures_recorded_before_the_switch() {
        for (failed, expected) in [
            (vec!["connector-runtime"], UpdateResult::Installed),
            (
                vec!["connector-runtime", "scheduler"],
                UpdateResult::RolledBack,
            ),
        ] {
            let h = harness();
            let mut pending = switched(&h);
            pending.baseline_failed_required_runtimes = vec!["connector-runtime".into()];
            let outcome = Arc::clone(&h.updater)
                .supervise_trial(
                    h.home.clone(),
                    pending,
                    Arc::new(RuntimeHealthSequence(Mutex::new(vec![runtime_health(
                        &failed,
                    )]))),
                    Duration::from_secs(5),
                    Duration::from_secs(30),
                )
                .await;
            assert_eq!(outcome.result, expected);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn native_trial_waits_for_recovery_and_a_new_settle_period() {
        let h = harness();
        let pending = switched(&h);
        let mut starting = runtime_health(&[]);
        starting.bootstrapped = Some(false);
        let before = h.updater.now();
        let outcome = Arc::clone(&h.updater)
            .supervise_trial(
                h.home.clone(),
                pending,
                Arc::new(RuntimeHealthSequence(Mutex::new(vec![
                    starting,
                    runtime_health(&[]),
                    runtime_health(&[]),
                    runtime_health(&["scheduler"]),
                    runtime_health(&[]),
                ]))),
                Duration::from_secs(5),
                Duration::from_secs(30),
            )
            .await;
        assert_eq!(outcome.result, UpdateResult::Installed);
        assert!(h.updater.now() - before >= 50_000);
    }

    #[tokio::test(start_paused = true)]
    async fn a_trial_rolls_back_when_its_brain_is_refused() {
        let h = harness();
        let pending = switched(&h);
        let outcome = Arc::clone(&h.updater)
            .supervise_trial(
                h.home.clone(),
                pending,
                Arc::new(FixedHealth(TrialSignal::Refused(
                    "contract_mismatch".into(),
                ))),
                Duration::from_secs(1),
                Duration::from_secs(30),
            )
            .await;
        assert_eq!(outcome.result, UpdateResult::RolledBack);
        assert!(outcome.reason.unwrap().contains("contract_mismatch"));
        assert_eq!(h.home.current_version().as_deref(), Some("1.4.0"));
        assert_eq!(h.restarts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_trial_that_never_gets_healthy_rolls_back_at_its_deadline() {
        let h = harness();
        let pending = switched(&h);
        let outcome = Arc::clone(&h.updater)
            .supervise_trial(
                h.home.clone(),
                pending,
                Arc::new(FixedHealth(TrialSignal::Waiting)),
                Duration::from_secs(5),
                Duration::from_secs(30),
            )
            .await;
        assert_eq!(outcome.result, UpdateResult::RolledBack);
        assert!(outcome.reason.unwrap().contains("in time"));
        assert_eq!(h.home.current_version().as_deref(), Some("1.4.0"));
    }

    #[test]
    fn detects_how_the_host_is_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let unpacked = tmp.path().join("unpacked");
        write_install(&unpacked, "1.4.0", TARGET);
        let home = InstallHome::in_data_dir(&tmp.path().join("data"));
        home.adopt(&unpacked).unwrap();
        let in_home = home.current_layout().server_binary();
        let detect = |exe: Option<&Path>, service_managed: bool, image_target: Option<&str>| {
            HostInstall::detect(&DetectInput {
                current_exe: exe,
                service_managed,
                image_target,
                update_agent_socket: None,
                compiled_version: "9.9.9",
            })
        };

        let native = detect(Some(&in_home), true, None);
        assert_eq!(native.kind, InstallKind::Native(home.clone()));
        assert_eq!(
            (native.version.as_str(), native.target.as_deref()),
            ("1.4.0", Some(TARGET))
        );
        assert_eq!(
            detect(Some(&in_home), false, None).kind,
            InstallKind::Unmanaged(UnmanagedReason::NotAService)
        );
        assert_eq!(
            detect(Some(&unpacked.join("bin/cognia-server")), true, None).kind,
            InstallKind::Unmanaged(UnmanagedReason::NotInstalled)
        );
        let image = detect(None, false, Some("oci-full-amd64"));
        assert_eq!(
            image.kind,
            InstallKind::Unmanaged(UnmanagedReason::NoDeployAgent)
        );
        assert_eq!(
            (image.version.as_str(), image.target.as_deref()),
            ("9.9.9", Some("oci-full-amd64"))
        );
        assert_eq!(
            detect(None, false, None).kind,
            InstallKind::Unmanaged(UnmanagedReason::NotInstalled)
        );
        // An image with its deploy agent's socket is a Compose host.
        let socket = tmp.path().join("agent.sock");
        let compose = HostInstall::detect(&DetectInput {
            current_exe: None,
            service_managed: false,
            image_target: Some("oci-full-amd64"),
            update_agent_socket: Some(&socket),
            compiled_version: "9.9.9",
        });
        assert!(matches!(compose.kind, InstallKind::Compose(_)));
        // A socket alone does not make a desktop build a Compose host.
        let stray = HostInstall::detect(&DetectInput {
            current_exe: None,
            service_managed: false,
            image_target: None,
            update_agent_socket: Some(&socket),
            compiled_version: "9.9.9",
        });
        assert_eq!(
            stray.kind,
            InstallKind::Unmanaged(UnmanagedReason::NotInstalled)
        );
    }

    const IMAGE_TARGET: &str = "oci-full-amd64";

    /// A deploy agent in memory: a fixed status, and an answer to updates.
    struct FakeAgent {
        status: Mutex<AgentStatus>,
        update_answer: Mutex<Result<AgentResponse, String>>,
        asked: Mutex<Vec<AgentRequest>>,
    }

    impl FakeAgent {
        fn idle() -> Self {
            Self {
                status: Mutex::new(AgentStatus {
                    phase: AgentPhase::Idle,
                    image: None,
                    trial: None,
                    last_outcome: None,
                    last_error: None,
                }),
                update_answer: Mutex::new(Ok(AgentResponse::Accepted(AcceptedUpdate {
                    attempt_id: "a1".into(),
                    from: "1.4.0".into(),
                    to: "1.5.0".into(),
                    image: format!("ghcr.io/x/cognia-server@sha256:{}", "b".repeat(64)),
                }))),
                asked: Mutex::new(Vec::new()),
            }
        }

        fn updates(&self) -> Vec<AgentRequest> {
            self.asked
                .lock()
                .iter()
                .filter(|request| matches!(request, AgentRequest::Update(_)))
                .cloned()
                .collect()
        }
    }

    #[async_trait]
    impl UpdateAgent for FakeAgent {
        async fn ask(&self, request: AgentRequest) -> Result<AgentResponse, String> {
            self.asked.lock().push(request.clone());
            match request {
                AgentRequest::Status => Ok(AgentResponse::Status(self.status.lock().clone())),
                AgentRequest::Update(_) => self.update_answer.lock().clone(),
            }
        }
    }

    struct ComposeHarness {
        _tmp: tempfile::TempDir,
        agent: Arc<FakeAgent>,
        idle: Arc<FakeIdle>,
        writes: Arc<FakeWrites>,
        restarts: Arc<AtomicUsize>,
        updater: Arc<HostUpdater>,
    }

    /// A Compose host on 1.4.0 with its agent, and a signed 1.5.0 image rolling.
    fn compose_harness() -> ComposeHarness {
        let tmp = tempfile::tempdir().unwrap();
        let digest = format!("sha256:{}", "b".repeat(64));
        let network = Arc::new(FakeNetwork::default());
        *network.catalog.lock() = Some(sign_bundle(
            host_release_entries(
                "1.5.0",
                "stable",
                IMAGE_TARGET,
                json!({ "image": "ghcr.io/x/cognia-server", "digest": digest }),
            ),
            1,
            chrono::DateTime::from_timestamp_millis(BASE_MS).unwrap(),
        ));
        *network.rollout.lock() = Some(RolloutAnswer {
            version: "1.5.0".into(),
            digest: Some(digest),
        });
        let agent = Arc::new(FakeAgent::idle());
        let idle = Arc::new(FakeIdle(
            Mutex::new(vec![quiet()]),
            Mutex::new(Ok(Vec::new())),
        ));
        let writes = Arc::new(FakeWrites::default());
        let restarts = Arc::new(AtomicUsize::new(0));
        let restart_count = Arc::clone(&restarts);
        let start = tokio::time::Instant::now();
        let updater = HostUpdater::new(
            tmp.path(),
            HostInstall {
                kind: InstallKind::Compose(ComposeAgent(agent.clone())),
                version: "1.4.0".into(),
                target: Some(IMAGE_TARGET.into()),
            },
            Some(root()),
            HostUpdaterDeps {
                network,
                idle: idle.clone(),
                writes: writes.clone(),
                restart: Arc::new(move || {
                    restart_count.fetch_add(1, Ordering::SeqCst);
                }),
                clock: Arc::new(move || BASE_MS + start.elapsed().as_millis() as i64),
            },
        );
        ComposeHarness {
            _tmp: tmp,
            agent,
            idle,
            writes,
            restarts,
            updater,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_compose_host_holds_writes_and_hands_the_swap_to_its_agent() {
        let h = compose_harness();
        let status = h.updater.request_install().await.unwrap();
        assert_eq!(status.install, "compose");
        assert_eq!(status.unmanaged_reason, None);
        h.updater.tick().await;

        let updates = h.agent.updates();
        assert_eq!(updates.len(), 1);
        let AgentRequest::Update(request) = &updates[0] else {
            unreachable!()
        };
        assert_eq!(
            (
                request.current_version.as_str(),
                request.expect_version.as_str(),
                request.channel.as_str(),
                request.manual
            ),
            ("1.4.0", "1.5.0", "stable", true)
        );
        assert_eq!(request.bucket, h.updater.settings().rollout_bucket);
        let status = h.updater.status();
        assert_eq!(status.phase, UpdatePhase::Restarting);
        assert_eq!(status.last_error, None);
        // The agent recreates this container; the host does not restart itself,
        // and its writes stay held until it is gone.
        assert_eq!(h.restarts.load(Ordering::SeqCst), 0);
        assert_eq!(h.writes.held(), 1);
        assert!(
            h.updater.check(true).await.is_err(),
            "nothing else starts meanwhile"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_compose_host_waits_for_idle_before_asking() {
        let h = compose_harness();
        h.idle.set(vec![IdleReport { jobs: 2, ..quiet() }]);
        h.updater.request_install().await.unwrap();
        h.updater.tick().await;
        assert!(h.agent.updates().is_empty());
        assert_eq!(h.updater.status().phase, UpdatePhase::WaitingForIdle);
        assert_eq!(h.writes.held(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_refusing_agent_releases_writes_and_says_why() {
        let h = compose_harness();
        *h.agent.update_answer.lock() = Ok(AgentResponse::Refused {
            error: "the deploy agent finds 1.4.1 rolling, not 1.5.0".into(),
        });
        h.updater.request_install().await.unwrap();
        h.updater.tick().await;
        assert_eq!(h.writes.held(), 0);
        let status = h.updater.status();
        assert!(status.last_error.unwrap().contains("refused"));
        assert!(!status.install_requested);
    }

    #[tokio::test(start_paused = true)]
    async fn an_agent_that_never_restarts_the_host_lets_writes_resume() {
        let h = compose_harness();
        h.updater.request_install().await.unwrap();
        h.updater.tick().await;
        assert_eq!(h.writes.held(), 1);
        tokio::time::advance(ACTIVATION_GRACE + Duration::from_secs(1)).await;
        h.updater.tick().await;
        assert_eq!(h.writes.held(), 0);
        let status = h.updater.status();
        assert!(status.last_error.unwrap().contains("did not restart"));
        assert_ne!(status.phase, UpdatePhase::Restarting);
    }

    #[tokio::test]
    async fn a_compose_host_shows_its_agents_trial_and_last_outcome() {
        let h = compose_harness();
        *h.agent.status.lock() = AgentStatus {
            phase: AgentPhase::Trial,
            image: None,
            trial: Some(AgentTrial {
                attempt_id: "a2".into(),
                from: "1.3.0".into(),
                to: "1.4.0".into(),
                deadline_ms: BASE_MS + 600_000,
            }),
            last_outcome: Some(UpdateOutcome {
                attempt_id: "a1".into(),
                from: "1.2.0".into(),
                to: "1.3.0".into(),
                result: UpdateResult::RolledBack,
                reason: Some("its server refused its brain (contract_mismatch)".into()),
                at_ms: BASE_MS,
            }),
            last_error: None,
        };
        h.updater.refresh_agent().await;
        let status = h.updater.status();
        assert_eq!(status.phase, UpdatePhase::Trial);
        assert_eq!(status.trial.unwrap().to, "1.4.0");
        assert_eq!(
            status.last_outcome.unwrap().result,
            UpdateResult::RolledBack
        );
        // A trial in progress blocks another update.
        assert!(h.updater.check(true).await.unwrap_err().contains("busy"));
    }

    #[tokio::test]
    async fn an_unreachable_agent_is_reported() {
        let h = compose_harness();
        let unreachable = HostUpdater::new(
            h._tmp.path(),
            HostInstall {
                kind: InstallKind::Compose(ComposeAgent(Arc::new(super::SocketAgent::new(
                    h._tmp.path().join("missing.sock"),
                )))),
                version: "1.4.0".into(),
                target: Some(IMAGE_TARGET.into()),
            },
            Some(root()),
            HostUpdaterDeps {
                network: Arc::new(FakeNetwork::default()),
                idle: h.idle.clone(),
                writes: h.writes.clone(),
                restart: Arc::new(|| {}),
                clock: Arc::new(|| BASE_MS),
            },
        );
        unreachable.refresh_agent().await;
        assert!(unreachable
            .status()
            .last_error
            .unwrap()
            .contains("deploy agent"));
    }
}
