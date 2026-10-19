//! The desktop's bootstrap sessions (ADR-0235 P5/P6): what the Devices UI
//! drives, as data the renderer can read.
//!
//! One entry per open remote shell. The renderer holds only its random id; the
//! connection, the inspection and every credential stay in this process. Each
//! step is one call: `open` (SSH today), `inspect`, `install` (fetch, then the
//! install), `pair`, `uninstall`, `close`. A step names the inspection it acts
//! on and the plan the user chose there, which is the user's consent: a plan
//! the inspection did not offer, or an inspection that is no longer the
//! latest, is refused. Steps on one entry never overlap.
//!
//! Failures cross to the renderer as [`InstallerFailure`], one variant per
//! state the UI words differently. A pair invitation leaves only in
//! [`PairView`], the one value the renderer needs to finish pairing.
//!
//! Tauri-free: the command shells in [`crate::commands`] (feature
//! `tauri-host`) wrap these methods and emit the stage events.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use cognia_terminal::ssh::{
    open_hosted_exec, HostKeyChange, HostKeyStatus, SshSpawnRequest, HOST_KEY_CHANGED_CODE,
};
use cognia_update_catalog::client::{TrustFile, UpdateNetwork};
use cognia_update_catalog::verify::RootPayload;
use serde::Serialize;

use crate::probe::{Notice, Unsupported};
use crate::release::ReleaseError;
use crate::session::{
    Consent, Inspection, InstallError, InstallOptions, PlanKind, ReleaseSource, Session, StageName,
    StageObserver,
};
use crate::shell::{InitSystem, RemoteArch, RemoteOs, RemoteShell};
use crate::ssh::SshShell;

/// Rows and columns an exec connection reports: none, but a saved profile's
/// request must name a size to validate.
const EXEC_TERMINAL_SIZE: (u16, u16) = (24, 80);

/// How the desktop reached the machine, as shown before consent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedView {
    pub session_id: String,
    /// `learned` on first contact, `verified` after.
    pub host_key_status: &'static str,
    pub host_key_fingerprint: String,
}

/// What an inspection found, everything the consent copy names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionView {
    pub inspection_id: String,
    /// `linux` or `macos`.
    pub os: &'static str,
    /// `x64` or `arm64`.
    pub arch: &'static str,
    /// The catalog target the install takes.
    pub target: &'static str,
    /// `uname -n`; typing it confirms deleting the Host's data.
    pub hostname: String,
    pub user: String,
    pub data_dir: String,
    /// `systemd` or `launchd`.
    pub service_manager: &'static str,
    pub linger: Option<bool>,
    /// `major.minor`, on Linux.
    pub glibc: Option<String>,
    pub free_bytes: Option<u64>,
    pub existing: Option<ExistingView>,
    pub offers: Vec<PlanKind>,
    pub notices: Vec<Notice>,
}

/// An install already on the machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingView {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub ready: Option<bool>,
    pub master_key_present: bool,
}

/// What an install left behind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledView {
    pub version: String,
    pub data_dir: String,
}

/// An owner invitation for the installed Host. The renderer registers it the
/// way a scanned one is registered and must not display or store it.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairView {
    pub invitation: String,
    pub has_relay: bool,
    pub expires_at_ms: i64,
}

impl std::fmt::Debug for PairView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairView")
            .field("invitation", &"<redacted>")
            .field("has_relay", &self.has_relay)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

/// Why a machine cannot take a Host, by cause.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "cause", rename_all = "snake_case")]
pub enum UnsupportedView {
    Windows,
    Os { name: String },
    Arch { name: String },
    NoServiceManager,
    GlibcTooOld { found: String, baseline: String },
    GlibcUnknown,
    NoHome,
}

impl From<&Unsupported> for UnsupportedView {
    fn from(reason: &Unsupported) -> Self {
        let version = |(major, minor): (u32, u32)| format!("{major}.{minor}");
        match reason {
            Unsupported::Windows => Self::Windows,
            Unsupported::Os(name) => Self::Os { name: name.clone() },
            Unsupported::Arch(name) => Self::Arch { name: name.clone() },
            Unsupported::NoServiceManager => Self::NoServiceManager,
            Unsupported::GlibcTooOld { found, baseline } => Self::GlibcTooOld {
                found: version(*found),
                baseline: version(*baseline),
            },
            Unsupported::GlibcUnknown => Self::GlibcUnknown,
            Unsupported::NoHome => Self::NoHome,
        }
    }
}

/// Why a release could not be had, by cause.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseCause {
    NoTrustRoot,
    Unreachable,
    NoCatalog,
    Untrusted,
    NoRelease,
    NotAnArchive,
    DigestMismatch,
    Io,
}

/// A step that did not succeed, as the renderer classifies it. `message` is
/// English detail for the support log, never shown as the headline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallerFailure {
    /// The session id is unknown or was closed.
    NoSession,
    /// Another step on this session is still running.
    Busy,
    /// The step names an inspection that is not the session's latest.
    StaleInspection,
    /// The machine presented a different host key than the one trusted.
    HostKeyChanged {
        change: HostKeyChange,
    },
    /// The SSH connection or its authentication failed.
    Connect {
        message: String,
    },
    Unsupported {
        reason: UnsupportedView,
        message: String,
    },
    NotEnoughSpace {
        free: u64,
        needed: u64,
    },
    Release {
        cause: ReleaseCause,
        message: String,
    },
    Denied {
        message: String,
    },
    Refused {
        stage: StageName,
        message: String,
    },
    /// The step did not reach the machine; running it again may work.
    Fault {
        stage: StageName,
        message: String,
    },
    /// The step may or may not have run: inspect again before anything else.
    Unknown {
        stage: StageName,
        message: String,
    },
    Timeout {
        stage: StageName,
    },
    Failed {
        stage: StageName,
        message: String,
    },
    /// The Host cannot reach the Cognia relay to pair through.
    RelayUnavailable {
        message: String,
    },
}

impl From<InstallError> for InstallerFailure {
    fn from(error: InstallError) -> Self {
        let message = error.to_string();
        match error {
            InstallError::Unsupported(reason) => Self::Unsupported {
                reason: UnsupportedView::from(&reason),
                message,
            },
            InstallError::Release(release) => Self::Release {
                cause: match release {
                    ReleaseError::NoTrustRoot => ReleaseCause::NoTrustRoot,
                    ReleaseError::Unreachable(_) => ReleaseCause::Unreachable,
                    ReleaseError::NoCatalog(_) => ReleaseCause::NoCatalog,
                    ReleaseError::Untrusted(_) => ReleaseCause::Untrusted,
                    ReleaseError::NoRelease { .. } => ReleaseCause::NoRelease,
                    ReleaseError::NotAnArchive { .. } => ReleaseCause::NotAnArchive,
                    ReleaseError::DigestMismatch => ReleaseCause::DigestMismatch,
                    ReleaseError::Io(_) => ReleaseCause::Io,
                },
                message,
            },
            InstallError::NotEnoughSpace { free, needed } => Self::NotEnoughSpace { free, needed },
            InstallError::Denied(detail) => Self::Denied {
                message: detail.to_owned(),
            },
            InstallError::Refused { stage, .. } => Self::Refused { stage, message },
            InstallError::Fault { stage, .. } => Self::Fault { stage, message },
            InstallError::Unknown { stage, .. } => Self::Unknown { stage, message },
            InstallError::Timeout { stage } => Self::Timeout { stage },
            InstallError::Failed { stage, .. } => Self::Failed { stage, message },
            InstallError::RelayUnavailable { message } => Self::RelayUnavailable { message },
        }
    }
}

/// A failed SSH dial, with the host-key warning kept machine-readable.
pub fn connect_failure(message: String) -> InstallerFailure {
    if let Some(change) = message
        .strip_prefix(HOST_KEY_CHANGED_CODE)
        .and_then(|rest| rest.strip_prefix(':'))
        .and_then(|json| serde_json::from_str::<HostKeyChange>(json).ok())
    {
        return InstallerFailure::HostKeyChanged { change };
    }
    InstallerFailure::Connect { message }
}

/// Where an install takes its release from on this desktop.
pub struct ReleaseConfig {
    pub network: Arc<dyn UpdateNetwork>,
    pub root: Option<RootPayload>,
    pub trust: TrustFile,
    pub download_dir: PathBuf,
    /// Milliseconds since the epoch the catalog is verified at.
    pub now_ms: fn() -> i64,
}

/// The wall clock, for [`ReleaseConfig::now_ms`].
pub fn wall_clock_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// What the user chose for an install.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallChoice {
    /// The release channel the desktop follows.
    pub channel: String,
    /// The local account the Host serves.
    #[serde(default)]
    pub local_account_id: Option<String>,
}

struct Entry {
    shell: Arc<dyn RemoteShell>,
    latest: parking_lot::Mutex<Option<Inspection>>,
    busy: tokio::sync::Mutex<()>,
}

/// The open bootstrap sessions.
#[derive(Default)]
pub struct InstallerSessions {
    entries: parking_lot::Mutex<HashMap<String, Arc<Entry>>>,
}

fn os_name(os: &RemoteOs) -> &'static str {
    match os {
        RemoteOs::MacOs => "macos",
        _ => "linux",
    }
}

fn arch_name(arch: &RemoteArch) -> &'static str {
    match arch {
        RemoteArch::Arm64 => "arm64",
        _ => "x64",
    }
}

fn view(inspection: &Inspection) -> InspectionView {
    let probe = &inspection.probe;
    InspectionView {
        inspection_id: inspection.id.clone(),
        os: os_name(&probe.os),
        arch: arch_name(&probe.arch),
        target: inspection.target.target,
        hostname: probe.hostname.clone(),
        user: probe.user.clone(),
        data_dir: inspection.data_dir.clone(),
        service_manager: match probe.init {
            InitSystem::Launchd => "launchd",
            _ => "systemd",
        },
        linger: probe.linger,
        glibc: probe.glibc.map(|(major, minor)| format!("{major}.{minor}")),
        free_bytes: probe.free_bytes,
        existing: inspection.existing.as_ref().map(|status| ExistingView {
            installed: status.installed,
            running: status.running,
            version: status.current_version.clone(),
            ready: status.readiness.as_ref().map(|readiness| readiness.ready),
            master_key_present: status.master_key_present,
        }),
        offers: inspection.offers.clone(),
        notices: inspection.notices.clone(),
    }
}

impl InstallerSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an open shell and return its session id.
    pub fn insert(&self, shell: Arc<dyn RemoteShell>) -> String {
        let id = format!("hi-{:032x}", rand::random::<u128>());
        self.entries.lock().insert(
            id.clone(),
            Arc::new(Entry {
                shell,
                latest: parking_lot::Mutex::new(None),
                busy: tokio::sync::Mutex::new(()),
            }),
        );
        id
    }

    /// Dial a saved SSH profile. Forwards are dropped: a bootstrap opens no
    /// listening socket.
    pub async fn open_ssh(
        &self,
        mut request: SshSpawnRequest,
        known_hosts_path: PathBuf,
    ) -> Result<OpenedView, InstallerFailure> {
        request.local_forwards.clear();
        request.remote_forwards.clear();
        if request.rows == 0 || request.cols == 0 {
            (request.rows, request.cols) = EXEC_TERMINAL_SIZE;
        }
        let connection = open_hosted_exec(request, known_hosts_path)
            .await
            .map_err(connect_failure)?;
        let host_key_status = match connection.host_key_status {
            HostKeyStatus::Learned => "learned",
            HostKeyStatus::Verified => "verified",
        };
        let host_key_fingerprint = connection.host_key_fingerprint.clone();
        let session_id = self.insert(Arc::new(SshShell::new(connection)));
        Ok(OpenedView {
            session_id,
            host_key_status,
            host_key_fingerprint,
        })
    }

    fn entry(&self, session_id: &str) -> Result<Arc<Entry>, InstallerFailure> {
        self.entries
            .lock()
            .get(session_id)
            .cloned()
            .ok_or(InstallerFailure::NoSession)
    }

    /// The latest inspection, when `inspection_id` names it, and the user's
    /// consent to `plan` on it.
    fn consented(
        entry: &Entry,
        inspection_id: &str,
        plan: PlanKind,
    ) -> Result<(Inspection, Consent), InstallerFailure> {
        let inspection = entry
            .latest
            .lock()
            .clone()
            .filter(|inspection| inspection.id == inspection_id)
            .ok_or(InstallerFailure::StaleInspection)?;
        let consent = Consent::grant(&inspection, plan)?;
        Ok((inspection, consent))
    }

    /// Read the machine and what is installed on it.
    pub async fn inspect(
        &self,
        session_id: &str,
        observer: &dyn StageObserver,
    ) -> Result<InspectionView, InstallerFailure> {
        let entry = self.entry(session_id)?;
        let _busy = entry.busy.try_lock().map_err(|_| InstallerFailure::Busy)?;
        let inspection = Session::new(entry.shell.as_ref(), observer)
            .inspect()
            .await?;
        let shown = view(&inspection);
        *entry.latest.lock() = Some(inspection);
        Ok(shown)
    }

    /// Fetch the release and install or repair the Host.
    pub async fn install(
        &self,
        session_id: &str,
        inspection_id: &str,
        plan: PlanKind,
        choice: &InstallChoice,
        release: &ReleaseConfig,
        observer: &dyn StageObserver,
    ) -> Result<InstalledView, InstallerFailure> {
        let entry = self.entry(session_id)?;
        let _busy = entry.busy.try_lock().map_err(|_| InstallerFailure::Busy)?;
        let (inspection, consent) = Self::consented(&entry, inspection_id, plan)?;
        let session = Session::new(entry.shell.as_ref(), observer);
        let archive = session
            .fetch(
                &inspection,
                &consent,
                &ReleaseSource {
                    network: release.network.as_ref(),
                    root: release.root.as_ref(),
                    trust: &release.trust,
                    channel: &choice.channel,
                    download_dir: &release.download_dir,
                    now_ms: (release.now_ms)(),
                },
            )
            .await?;
        // SSH has no public route, so no tunnel ingress is bound.
        let installed = session
            .install(
                &inspection,
                &consent,
                &archive,
                &InstallOptions {
                    ingress_port: None,
                    local_account_id: choice.local_account_id.clone(),
                },
            )
            .await?;
        Ok(InstalledView {
            version: installed.version,
            data_dir: installed.data_dir,
        })
    }

    /// An owner invitation from the installed Host, through the relay.
    pub async fn pair(
        &self,
        session_id: &str,
        inspection_id: &str,
        plan: PlanKind,
        device_name: &str,
        observer: &dyn StageObserver,
    ) -> Result<PairView, InstallerFailure> {
        let entry = self.entry(session_id)?;
        let _busy = entry.busy.try_lock().map_err(|_| InstallerFailure::Busy)?;
        let (inspection, consent) = Self::consented(&entry, inspection_id, plan)?;
        let invitation = Session::new(entry.shell.as_ref(), observer)
            .pair(&inspection, &consent, device_name, None)
            .await?;
        Ok(PairView {
            invitation: invitation.encoded.to_string(),
            has_relay: invitation.has_relay,
            expires_at_ms: invitation.expires_at_ms,
        })
    }

    /// Remove the service and the install; the data too when the machine's
    /// name was typed.
    pub async fn uninstall(
        &self,
        session_id: &str,
        inspection_id: &str,
        delete_data_confirmation: Option<&str>,
        observer: &dyn StageObserver,
    ) -> Result<(), InstallerFailure> {
        let entry = self.entry(session_id)?;
        let _busy = entry.busy.try_lock().map_err(|_| InstallerFailure::Busy)?;
        let (inspection, mut consent) =
            Self::consented(&entry, inspection_id, PlanKind::Uninstall)?;
        if let Some(typed) = delete_data_confirmation {
            consent = consent.with_data_deletion(&inspection, typed)?;
        }
        Session::new(entry.shell.as_ref(), observer)
            .uninstall(&inspection, &consent)
            .await?;
        // What was inspected is gone; a further step must inspect again.
        *entry.latest.lock() = None;
        Ok(())
    }

    /// Drop the session and its connection.
    pub fn close(&self, session_id: &str) -> bool {
        self.entries.lock().remove(session_id).is_some()
    }
}

#[cfg(test)]
#[path = "desktop_tests.rs"]
mod tests;
