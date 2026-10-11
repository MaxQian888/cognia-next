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
//! A Compose host runs no swap of its own: its deploy agent activates the new
//! image (ADR-0224 A10). Until one is configured it reports why it cannot
//! update.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use cognia_host_service::install_home::{
    ExpectedRelease, HostManifest, InstallHome, PendingUpdate, UpdateOutcome,
};
use cognia_host_service::server::HostLayout;
use cognia_update_catalog::{
    select_host_release, verify_signed_catalog, HostArtifact, HostRelease, HostReleaseQuery,
    RootPayload,
};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::Notify;

use super::idle::{IdleProbe, IdleReport};
use super::network::{RolloutQuery, UpdateNetwork, MAX_ARCHIVE_BYTES};
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

/// How this host is installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallKind {
    /// A macOS archive in an install home, run as the OS service.
    Native(InstallHome),
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
        Self {
            kind: InstallKind::Unmanaged(if target.is_some() {
                UnmanagedReason::NoDeployAgent
            } else {
                UnmanagedReason::NotInstalled
            }),
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
    fn signal(&self) -> TrialSignal;
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
    fn signal(&self) -> TrialSignal {
        if let Some(refusal) = crate::ws_bridge::brain_refusal() {
            return TrialSignal::Refused(refusal.reason);
        }
        if crate::ws_bridge::bridge_ready() {
            TrialSignal::Healthy
        } else {
            TrialSignal::Waiting
        }
    }
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

fn digest_matches(answer: Option<&str>, artifact: &HostArtifact) -> bool {
    let strip = |value: &str| value.strip_prefix("sha256:").unwrap_or(value).to_owned();
    let expected = match artifact {
        HostArtifact::Archive { sha256, .. } => strip(sha256),
        HostArtifact::Image { digest, .. } => strip(digest),
    };
    answer.map(strip).as_deref() == Some(expected.as_str())
}

fn to_datetime(ms: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms).unwrap_or_default()
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
            InstallKind::Unmanaged(_) => None,
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
            InstallKind::Unmanaged(reason) => ("unmanaged", Some(*reason)),
        };
        let phase = inner.phase.unwrap_or(if inner.trial.is_some() {
            UpdatePhase::Trial
        } else if inner.available.is_some() {
            UpdatePhase::Available
        } else {
            UpdatePhase::Idle
        });
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
            last_error: inner.last_error.clone(),
            last_outcome: self.home().and_then(InstallHome::last_outcome),
            trial: inner.trial.as_ref().map(|pending| TrialInfo {
                from: pending.from.clone(),
                to: pending.to.clone(),
                deadline_ms: pending.deadline_ms,
            }),
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
        inner.busy = true;
        inner.phase = Some(phase);
        Ok(BusyGuard(&self.inner))
    }

    /// Look for a release this host may install now.
    pub async fn check(&self, manual: bool) -> Result<HostUpdateStatus, String> {
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
        let bundle = self
            .deps
            .network
            .catalog(&settings.channel)
            .await?
            .ok_or_else(|| {
                format!(
                    "no catalog is published for the {} channel",
                    settings.channel
                )
            })?;
        let trust = self.store.load_trust(root);
        let verified = verify_signed_catalog(&bundle, &trust, to_datetime(self.now()))
            .map_err(|error| error.to_string())?;
        self.store.save_trust(&verified.trust)?;
        let query = HostReleaseQuery {
            channel: &settings.channel,
            target: &target,
            current_version: Some(&self.install.version),
            bucket: settings.rollout_bucket,
            manual,
        };
        let Some(release) = select_host_release(&verified.targets.entries, &query) else {
            return Ok(None);
        };
        let answer = self
            .deps
            .network
            .rollout(&RolloutQuery {
                target,
                current_version: self.install.version.clone(),
                channel: settings.channel.clone(),
                bucket: settings.rollout_bucket,
                manual,
            })
            .await?;
        // The Worker can hold a release back; it cannot put forward one the
        // catalog does not sign.
        Ok(answer
            .filter(|answer| {
                answer.version == release.version
                    && digest_matches(answer.digest.as_deref(), &release.artifact)
            })
            .map(|_| release))
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

    async fn install(&self, release: &HostRelease, manual: bool) -> Result<(), String> {
        let _ = manual;
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
        let pending = tokio::task::spawn_blocking(move || {
            switch_home.begin_switch(&to, now, TRIAL_WINDOW.as_millis() as i64)
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
                if inner.install_requested.is_some() {
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
            match health.signal() {
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
