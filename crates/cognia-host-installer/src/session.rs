//! One bootstrap session: inspect the machine, take the user's consent for a
//! plan, then install, pair or uninstall.
//!
//! ```text
//! inspect ── probe → target → existing install (service status --json) → offers
//!    │
//! consent ── bound to this inspection and one offered plan
//!    │
//! fetch ──── the signed release for the machine's target, downloaded and
//!            checked here
//! install ── room → upload (skipped when the remote copy already verifies)
//!            → remote digest → extract cognia-server → stage → ingress
//!            → service install → readiness
//! pair ───── pair --json; relay refused → only with tunnel-only consent
//! uninstall  service uninstall → install root; data only with a typed second
//!            confirmation
//! ```
//!
//! Every remote step is idempotent: the scratch work dir is keyed by version,
//! an upload whose remote digest already matches is not repeated, `stage`
//! replaces a half-staged version, and `service install` reinstalls. So a
//! `NotStarted` failure may be retried by running the session again. An
//! `Unknown` one is never replayed by this module: the caller inspects the
//! machine again before deciding anything.
//!
//! The pair invitation is an owner credential. It is never put in an error,
//! an event or a log line; it leaves this module only as [`PairInvitation`].

use std::time::Duration;

use cognia_host_service::install_home::{CURRENT_LINK, INSTALL_HOME_DIR};
use cognia_host_service::server::{data_dir_in_home, ServerStatusReport, SERVER_BINARY_IN_INSTALL};
use cognia_host_service::ServicePlatform;
use serde::Deserialize;
use zeroize::Zeroizing;

use crate::probe::{has_room_for, resolve_target, HostTarget, Notice, Unsupported};
use crate::release::{download_verified, select_install_release, LocalArchive, ReleaseError};
use crate::shell::{
    ExecOutput, ExecRequest, RemoteOutcome, RemoteProbe, RemoteShell, ShellError, UploadSource,
};

/// The stages a session reports, the vocabulary the plan's observability
/// section fixes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StageName {
    Probe,
    Plan,
    Fetch,
    Upload,
    Stage,
    Service,
    Pair,
    Route,
}

/// How a stage ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StageOutcome {
    Ok,
    Denied,
    Unsupported,
    Unreachable,
    Unknown,
    Timeout,
    Failed,
}

/// One stage transition. Carries the session's operation id and never a host
/// name, account or path, so it can be recorded as is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageEvent {
    pub operation_id: String,
    pub stage: StageName,
    /// `None` when the stage starts.
    pub outcome: Option<StageOutcome>,
}

/// Where stage transitions go (the desktop's timeline and audit).
pub trait StageObserver: Send + Sync {
    fn on_stage(&self, event: &StageEvent);
}

/// An observer that drops everything.
pub struct NoObserver;

impl StageObserver for NoObserver {
    fn on_stage(&self, _event: &StageEvent) {}
}

/// Why a session step failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InstallError {
    #[error(transparent)]
    Unsupported(#[from] Unsupported),
    #[error(transparent)]
    Release(#[from] ReleaseError),
    #[error("the machine has {free} bytes free and the install needs {needed}")]
    NotEnoughSpace { free: u64, needed: u64 },
    /// The consent does not belong to this inspection, or does not cover
    /// this step.
    #[error("{0}")]
    Denied(&'static str),
    /// The remote refused the request; running it again will not help.
    #[error("{stage:?}: the machine refused: {detail}")]
    Refused { stage: StageName, detail: String },
    /// The request did not reach the machine; the session may be run again.
    #[error("{stage:?}: the connection failed before the step ran: {detail}")]
    Fault { stage: StageName, detail: String },
    /// The step may or may not have run. Inspect the machine again before
    /// doing anything else.
    #[error("{stage:?}: the connection dropped and the step may or may not have run: {detail}")]
    Unknown { stage: StageName, detail: String },
    #[error("{stage:?}: did not finish in time")]
    Timeout { stage: StageName },
    /// The step ran and did not succeed.
    #[error("{stage:?}: {detail}")]
    Failed { stage: StageName, detail: String },
    /// The Host has no relay room to pair through. Pairing over the tunnel
    /// alone needs its own consent.
    #[error("the Host cannot reach the Cognia relay: {message}")]
    RelayUnavailable { message: String },
}

impl InstallError {
    pub fn outcome(&self) -> StageOutcome {
        match self {
            Self::Unsupported(_) => StageOutcome::Unsupported,
            Self::Release(ReleaseError::Unreachable(_)) => StageOutcome::Unreachable,
            Self::Release(_) | Self::NotEnoughSpace { .. } | Self::Failed { .. } => {
                StageOutcome::Failed
            }
            Self::Denied(_) | Self::Refused { .. } | Self::RelayUnavailable { .. } => {
                StageOutcome::Denied
            }
            Self::Fault { .. } => StageOutcome::Unreachable,
            Self::Unknown { .. } => StageOutcome::Unknown,
            Self::Timeout { .. } => StageOutcome::Timeout,
        }
    }

    /// Whether running the same session again may succeed without inspecting
    /// the machine first. Never true for an unknown outcome.
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Fault { .. } | Self::Timeout { .. })
    }
}

/// What the user may choose for a machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanKind {
    /// Nothing is installed: install and pair.
    Fresh,
    /// An install exists: reinstall the selected release over it. Data and
    /// the master key are kept.
    Repair,
    /// An install exists: only issue a new pair invitation.
    RePair,
    /// Remove the service and the install root.
    Uninstall,
}

/// What [`inspect`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inspection {
    /// Random per inspection; consent is bound to it.
    pub id: String,
    pub probe: RemoteProbe,
    pub target: HostTarget,
    /// The data dir a user-scope install uses on this machine.
    pub data_dir: String,
    pub existing: Option<ServerStatusReport>,
    pub offers: Vec<PlanKind>,
    pub notices: Vec<Notice>,
}

impl Inspection {
    /// The installed `cognia-server` the service runs.
    pub fn installed_binary(&self) -> String {
        installed_binary(&self.data_dir)
    }

    /// What the user types to confirm deleting the Host's data: the machine's
    /// name, as `uname -n` reports it.
    pub fn delete_phrase(&self) -> &str {
        &self.probe.hostname
    }
}

/// The user's decision for one inspection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Consent {
    inspection_id: String,
    plan: PlanKind,
    tunnel_only_pairing: bool,
    delete_data: bool,
}

impl Consent {
    /// Consent to one of the inspection's offers.
    pub fn grant(inspection: &Inspection, plan: PlanKind) -> Result<Self, InstallError> {
        if !inspection.offers.contains(&plan) {
            return Err(InstallError::Denied(
                "that plan was not offered for this machine",
            ));
        }
        Ok(Self {
            inspection_id: inspection.id.clone(),
            plan,
            tunnel_only_pairing: false,
            delete_data: false,
        })
    }

    /// The user accepted pairing over the tunnel alone: the device then
    /// reaches the Host only through the published tunnel URL.
    pub fn with_tunnel_only_pairing(mut self) -> Self {
        self.tunnel_only_pairing = true;
        self
    }

    /// The user typed the machine's name to also delete the Host's data dir.
    pub fn with_data_deletion(
        mut self,
        inspection: &Inspection,
        typed: &str,
    ) -> Result<Self, InstallError> {
        if self.plan != PlanKind::Uninstall {
            return Err(InstallError::Denied("only an uninstall can delete data"));
        }
        let phrase = inspection.delete_phrase();
        if phrase.is_empty() || typed.trim() != phrase {
            return Err(InstallError::Denied(
                "the confirmation does not match the machine's name",
            ));
        }
        self.delete_data = true;
        Ok(self)
    }

    pub fn plan(&self) -> PlanKind {
        self.plan
    }

    fn check(&self, inspection: &Inspection, allowed: &[PlanKind]) -> Result<(), InstallError> {
        if self.inspection_id != inspection.id {
            return Err(InstallError::Denied(
                "the consent belongs to another inspection",
            ));
        }
        if !allowed.contains(&self.plan) {
            return Err(InstallError::Denied("the consent does not cover this step"));
        }
        Ok(())
    }
}

/// A pair invitation: an owner credential for this Host. Wiped when dropped,
/// never printed.
pub struct PairInvitation {
    pub encoded: Zeroizing<String>,
    pub has_relay: bool,
    pub expires_at_ms: i64,
}

impl std::fmt::Debug for PairInvitation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairInvitation")
            .field("encoded", &"<redacted>")
            .field("has_relay", &self.has_relay)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

/// What an install left on the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub version: String,
    pub data_dir: String,
    pub server_binary: String,
}

/// Per-install choices.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct InstallOptions {
    /// Bind the tunnel ingress listener on this port (ADR-0235 §4).
    pub ingress_port: Option<u16>,
    /// The local account the Host serves (`COGNIA_LOCAL_ACCOUNT_ID`).
    pub local_account_id: Option<String>,
}

/// Where [`Session::fetch`] takes a release from: the update service, the
/// trust root this build ships and the trust state it advances.
pub struct ReleaseSource<'a> {
    pub network: &'a dyn cognia_update_catalog::client::UpdateNetwork,
    pub root: Option<&'a cognia_update_catalog::verify::RootPayload>,
    pub trust: &'a cognia_update_catalog::client::TrustFile,
    pub channel: &'a str,
    /// Where the verified archive is kept on this machine.
    pub download_dir: &'a std::path::Path,
    pub now_ms: i64,
}

/// Wait budgets, per step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deadlines {
    pub status: Duration,
    pub digest: Duration,
    pub extract: Duration,
    pub stage: Duration,
    pub service: Duration,
    /// How long the Host may take to answer ready after `service install`.
    pub ready: Duration,
    pub ready_poll: Duration,
    pub pair: Duration,
    pub remove: Duration,
}

impl Default for Deadlines {
    fn default() -> Self {
        Self {
            status: Duration::from_secs(30),
            digest: Duration::from_secs(120),
            extract: Duration::from_secs(120),
            stage: Duration::from_secs(300),
            service: Duration::from_secs(120),
            ready: Duration::from_secs(180),
            ready_poll: Duration::from_secs(3),
            pair: Duration::from_secs(60),
            remove: Duration::from_secs(120),
        }
    }
}

/// One session over one shell.
pub struct Session<'a> {
    shell: &'a dyn RemoteShell,
    observer: &'a dyn StageObserver,
    deadlines: Deadlines,
    operation_id: String,
}

fn installed_binary(data_dir: &str) -> String {
    format!("{data_dir}/{INSTALL_HOME_DIR}/{CURRENT_LINK}/{SERVER_BINARY_IN_INSTALL}")
}

/// Stage-scoped result of an exec.
fn completed<T>(stage: StageName, outcome: RemoteOutcome<T>) -> Result<T, InstallError> {
    match outcome {
        RemoteOutcome::Completed(value) => Ok(value),
        RemoteOutcome::NotStarted(ShellError::Refused(detail)) => {
            Err(InstallError::Refused { stage, detail })
        }
        RemoteOutcome::NotStarted(ShellError::Fault(detail)) => {
            Err(InstallError::Fault { stage, detail })
        }
        RemoteOutcome::Unknown(detail) => Err(InstallError::Unknown { stage, detail }),
    }
}

/// The tail of a failed command's stderr, bounded, for the error message.
fn failure(stage: StageName, what: &str, output: &ExecOutput) -> InstallError {
    let mut tail: String = output
        .stderr
        .trim()
        .chars()
        .rev()
        .take(400)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if tail.is_empty() {
        tail = match output.exit_code {
            Some(code) => format!("exit code {code}"),
            None => "killed by a signal".into(),
        };
    }
    InstallError::Failed {
        stage,
        detail: format!("{what} failed: {tail}"),
    }
}

/// What `cognia-server stage` prints.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Staged {
    directory: String,
}

/// What `cognia-server pair --json` prints.
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PairAnswer {
    #[serde(rename_all = "camelCase")]
    Issued {
        invitation: String,
        has_relay: bool,
        expires_at_ms: i64,
    },
    Refused {
        cause: String,
        message: String,
    },
}

impl<'a> Session<'a> {
    pub fn new(shell: &'a dyn RemoteShell, observer: &'a dyn StageObserver) -> Self {
        Self {
            shell,
            observer,
            deadlines: Deadlines::default(),
            operation_id: format!("inst-{:016x}", rand::random::<u64>()),
        }
    }

    pub fn with_deadlines(mut self, deadlines: Deadlines) -> Self {
        self.deadlines = deadlines;
        self
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    fn report(&self, stage: StageName, outcome: Option<StageOutcome>) {
        self.observer.on_stage(&StageEvent {
            operation_id: self.operation_id.clone(),
            stage,
            outcome,
        });
    }

    /// Run `body` as `stage`, reporting its start and end.
    async fn stage<T>(
        &self,
        stage: StageName,
        body: impl std::future::Future<Output = Result<T, InstallError>>,
    ) -> Result<T, InstallError> {
        self.report(stage, None);
        let result = body.await;
        self.report(
            stage,
            Some(match &result {
                Ok(_) => StageOutcome::Ok,
                Err(error) => error.outcome(),
            }),
        );
        result
    }

    async fn exec(
        &self,
        stage: StageName,
        request: ExecRequest,
    ) -> Result<ExecOutput, InstallError> {
        completed(stage, self.shell.exec(request).await)
    }

    /// Read the machine and what is installed on it.
    pub async fn inspect(&self) -> Result<Inspection, InstallError> {
        let (probe, target) = self
            .stage(StageName::Probe, async {
                let probe = completed(StageName::Probe, self.shell.probe().await)?;
                let target = resolve_target(&probe)?;
                Ok((probe, target))
            })
            .await?;
        self.stage(StageName::Plan, async {
            let data_dir = format!(
                "{}/{}",
                probe.home.trim_end_matches('/'),
                data_dir_in_home(target.platform)
            );
            let existing = self.read_status(&data_dir).await?;
            let installed = existing
                .as_ref()
                .is_some_and(|status| status.installed || status.current_version.is_some());
            let offers = if installed {
                vec![PlanKind::Repair, PlanKind::RePair, PlanKind::Uninstall]
            } else {
                vec![PlanKind::Fresh]
            };
            Ok(Inspection {
                id: format!("{}-{:08x}", self.operation_id, rand::random::<u32>()),
                notices: target.notices.clone(),
                probe: probe.clone(),
                target: target.clone(),
                data_dir,
                existing,
                offers,
            })
        })
        .await
    }

    /// `service status --json` from the installed binary, when there is one.
    async fn read_status(
        &self,
        data_dir: &str,
    ) -> Result<Option<ServerStatusReport>, InstallError> {
        let binary = installed_binary(data_dir);
        let present = completed(StageName::Plan, self.shell.stat(&binary).await)?;
        if !present.is_some_and(|stat| !stat.is_dir) {
            return Ok(None);
        }
        let output = self
            .exec(
                StageName::Plan,
                ExecRequest::new(
                    [
                        binary.as_str(),
                        "service",
                        "status",
                        "--scope",
                        "user",
                        "--json",
                        "--data-dir",
                        data_dir,
                    ],
                    self.deadlines.status,
                ),
            )
            .await?;
        if !output.success() {
            return Err(failure(
                StageName::Plan,
                "reading the installed Host's status",
                &output,
            ));
        }
        serde_json::from_str(output.stdout.trim())
            .map(Some)
            .map_err(|error| InstallError::Failed {
                stage: StageName::Plan,
                detail: format!("the installed Host's status could not be read: {error}"),
            })
    }

    /// The signed release for this machine's target, downloaded and checked
    /// against the catalog's sha256 before anything is uploaded.
    pub async fn fetch(
        &self,
        inspection: &Inspection,
        consent: &Consent,
        source: &ReleaseSource<'_>,
    ) -> Result<LocalArchive, InstallError> {
        consent.check(inspection, &[PlanKind::Fresh, PlanKind::Repair])?;
        self.stage(StageName::Fetch, async {
            let release = select_install_release(
                source.network,
                source.root,
                source.trust,
                source.channel,
                &inspection.target.target,
                source.now_ms,
            )
            .await?;
            tokio::fs::create_dir_all(source.download_dir)
                .await
                .map_err(|error| ReleaseError::Io(error.to_string()))?;
            Ok(download_verified(source.network, &release, source.download_dir).await?)
        })
        .await
    }

    /// Install or repair the Host from a verified local archive.
    pub async fn install(
        &self,
        inspection: &Inspection,
        consent: &Consent,
        archive: &LocalArchive,
        options: &InstallOptions,
    ) -> Result<Installed, InstallError> {
        consent.check(inspection, &[PlanKind::Fresh, PlanKind::Repair])?;
        if archive.release.target != inspection.target.target {
            return Err(InstallError::Denied("the archive is for another platform"));
        }
        if let Err((free, needed)) = has_room_for(&inspection.probe, archive.len) {
            return Err(InstallError::NotEnoughSpace { free, needed });
        }
        let release = &archive.release;
        let work = format!(
            "{}/.cache/cognia-host-installer/{}",
            inspection.probe.home.trim_end_matches('/'),
            release.version
        );
        let remote_archive = format!("{work}/{}", release.archive_name());
        let platform = inspection.target.platform;

        self.stage(StageName::Upload, async {
            completed(StageName::Upload, self.shell.mkdirp(&work).await)?;
            let already = completed(StageName::Upload, self.shell.stat(&remote_archive).await)?
                .is_some_and(|stat| !stat.is_dir && stat.size == archive.len)
                && self.remote_sha256(platform, &remote_archive).await? == release.sha256;
            if !already {
                let file = tokio::fs::File::open(&archive.path)
                    .await
                    .map_err(|error| InstallError::Failed {
                        stage: StageName::Upload,
                        detail: format!("the local archive could not be opened: {error}"),
                    })?;
                completed(
                    StageName::Upload,
                    self.shell
                        .upload(
                            &remote_archive,
                            UploadSource {
                                len: archive.len,
                                sha256: release.sha256.clone(),
                                reader: Box::new(file),
                            },
                        )
                        .await,
                )?;
                if self.remote_sha256(platform, &remote_archive).await? != release.sha256 {
                    return Err(InstallError::Failed {
                        stage: StageName::Upload,
                        detail: "the uploaded archive does not match the catalog's sha256".into(),
                    });
                }
            }
            Ok(())
        })
        .await?;

        let staged = self
            .stage(StageName::Stage, async {
                let extract = format!("{work}/extract");
                completed(StageName::Stage, self.shell.mkdirp(&extract).await)?;
                let member = format!("{}/{SERVER_BINARY_IN_INSTALL}", release.top_dir());
                let output = self
                    .exec(
                        StageName::Stage,
                        ExecRequest::new(
                            [
                                "tar",
                                "-xzf",
                                remote_archive.as_str(),
                                "-C",
                                extract.as_str(),
                                member.as_str(),
                            ],
                            self.deadlines.extract,
                        ),
                    )
                    .await?;
                if !output.success() {
                    return Err(failure(
                        StageName::Stage,
                        "extracting cognia-server",
                        &output,
                    ));
                }
                let bootstrap = format!("{extract}/{member}");
                let home = format!("{work}/home");
                let contract = release.contract_version.to_string();
                let output = self
                    .exec(
                        StageName::Stage,
                        ExecRequest::new(
                            [
                                bootstrap.as_str(),
                                "stage",
                                "--archive",
                                remote_archive.as_str(),
                                "--home",
                                home.as_str(),
                                "--version",
                                release.version.as_str(),
                                "--target",
                                release.target.as_str(),
                                "--sha256",
                                release.sha256.as_str(),
                                "--contract-version",
                                contract.as_str(),
                                "--catalog-hash",
                                release.catalog_hash.as_str(),
                            ],
                            self.deadlines.stage,
                        ),
                    )
                    .await?;
                if !output.success() {
                    return Err(failure(StageName::Stage, "staging the archive", &output));
                }
                let staged: Staged =
                    serde_json::from_str(output.stdout.trim()).map_err(|error| {
                        InstallError::Failed {
                            stage: StageName::Stage,
                            detail: format!("stage printed something unexpected: {error}"),
                        }
                    })?;
                Ok(staged.directory)
            })
            .await?;

        let server_binary = installed_binary(&inspection.data_dir);
        self.stage(StageName::Service, async {
            let staged_binary = format!("{staged}/{SERVER_BINARY_IN_INSTALL}");
            if let Some(port) = options.ingress_port {
                // Read at `serve`, so written before the service (re)starts.
                let port = port.to_string();
                let output = self
                    .exec(
                        StageName::Service,
                        ExecRequest::new(
                            [
                                staged_binary.as_str(),
                                "tunnel-ingress",
                                "enable",
                                "--port",
                                port.as_str(),
                            ],
                            self.deadlines.service,
                        )
                        .env("COGNIA_DATA_DIR", inspection.data_dir.as_str()),
                    )
                    .await?;
                if !output.success() {
                    return Err(failure(
                        StageName::Service,
                        "enabling the tunnel ingress",
                        &output,
                    ));
                }
            }
            let mut request = ExecRequest::new(
                [
                    staged_binary.as_str(),
                    "service",
                    "install",
                    "--scope",
                    "user",
                    "--install-root",
                    staged.as_str(),
                    "--data-dir",
                    inspection.data_dir.as_str(),
                ],
                self.deadlines.service,
            );
            if let Some(account) = &options.local_account_id {
                request = request.env("COGNIA_LOCAL_ACCOUNT_ID", account.as_str());
            }
            let output = self.exec(StageName::Service, request).await?;
            if !output.success() {
                return Err(failure(
                    StageName::Service,
                    "installing the service",
                    &output,
                ));
            }
            self.wait_ready(&inspection.data_dir).await?;
            // The scratch copy is no longer needed; a failure to remove it
            // costs disk, not correctness.
            let _ = self
                .shell
                .exec(ExecRequest::new(
                    ["rm", "-rf", "--", work.as_str()],
                    self.deadlines.remove,
                ))
                .await;
            Ok(())
        })
        .await?;

        Ok(Installed {
            version: release.version.clone(),
            data_dir: inspection.data_dir.clone(),
            server_binary,
        })
    }

    async fn remote_sha256(
        &self,
        platform: ServicePlatform,
        path: &str,
    ) -> Result<String, InstallError> {
        let argv: Vec<&str> = match platform {
            ServicePlatform::Linux => vec!["sha256sum", path],
            ServicePlatform::MacOs => vec!["shasum", "-a", "256", path],
        };
        let output = self
            .exec(
                StageName::Upload,
                ExecRequest::new(argv, self.deadlines.digest),
            )
            .await?;
        if !output.success() {
            return Err(failure(
                StageName::Upload,
                "checking the remote archive",
                &output,
            ));
        }
        output
            .stdout
            .split_whitespace()
            .next()
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| InstallError::Failed {
                stage: StageName::Upload,
                detail: "the checksum tool printed nothing".into(),
            })
    }

    /// Poll `service status --json` until the Host answers ready.
    async fn wait_ready(&self, data_dir: &str) -> Result<(), InstallError> {
        let started = tokio::time::Instant::now();
        loop {
            if let Some(status) = self
                .read_status(data_dir)
                .await
                .map_err(|error| match error {
                    InstallError::Failed { detail, .. } => InstallError::Failed {
                        stage: StageName::Service,
                        detail,
                    },
                    other => other,
                })?
            {
                if let Some(readiness) = &status.readiness {
                    if readiness.ready {
                        return Ok(());
                    }
                    if let Some(refusal) = &readiness.brain_refusal {
                        // Not a wait: the server and brain come from
                        // different builds.
                        return Err(InstallError::Failed {
                            stage: StageName::Service,
                            detail: refusal.clone(),
                        });
                    }
                }
            }
            if started.elapsed() >= self.deadlines.ready {
                return Err(InstallError::Timeout {
                    stage: StageName::Service,
                });
            }
            tokio::time::sleep(self.deadlines.ready_poll).await;
        }
    }

    /// Ask the installed Host for an owner invitation. Through the relay
    /// unless the consent allows the tunnel alone, in which case
    /// `tunnel_url` is what the device will dial.
    pub async fn pair(
        &self,
        inspection: &Inspection,
        consent: &Consent,
        device_name: &str,
        tunnel_url: Option<&str>,
    ) -> Result<PairInvitation, InstallError> {
        consent.check(
            inspection,
            &[PlanKind::Fresh, PlanKind::Repair, PlanKind::RePair],
        )?;
        self.stage(StageName::Pair, async {
            let binary = inspection.installed_binary();
            let first = self
                .ask_pair(&binary, &inspection.data_dir, device_name, None)
                .await?;
            match first {
                PairAnswer::Issued {
                    invitation,
                    has_relay,
                    expires_at_ms,
                } => Ok(PairInvitation {
                    encoded: Zeroizing::new(invitation),
                    has_relay,
                    expires_at_ms,
                }),
                PairAnswer::Refused { cause, message } if cause == "relay_unavailable" => {
                    let (true, Some(url)) = (consent.tunnel_only_pairing, tunnel_url) else {
                        return Err(InstallError::RelayUnavailable { message });
                    };
                    match self
                        .ask_pair(&binary, &inspection.data_dir, device_name, Some(url))
                        .await?
                    {
                        PairAnswer::Issued {
                            invitation,
                            has_relay,
                            expires_at_ms,
                        } => Ok(PairInvitation {
                            encoded: Zeroizing::new(invitation),
                            has_relay,
                            expires_at_ms,
                        }),
                        PairAnswer::Refused { message, .. } => Err(InstallError::Failed {
                            stage: StageName::Pair,
                            detail: message,
                        }),
                    }
                }
                PairAnswer::Refused { cause, message } => Err(InstallError::Failed {
                    stage: StageName::Pair,
                    detail: format!("{cause}: {message}"),
                }),
            }
        })
        .await
    }

    async fn ask_pair(
        &self,
        binary: &str,
        data_dir: &str,
        device_name: &str,
        direct_url: Option<&str>,
    ) -> Result<PairAnswer, InstallError> {
        let mut argv = vec![binary, "pair", "--json", "--device-name", device_name];
        if let Some(url) = direct_url {
            argv.extend(["--direct", "--advertise-url", url]);
        }
        let output = self
            .exec(
                StageName::Pair,
                ExecRequest::new(argv, self.deadlines.pair)
                    .env("COGNIA_DATA_DIR", data_dir)
                    .secret(),
            )
            .await?;
        if !output.success() {
            // The output may hold an invitation: only the exit status is told.
            return Err(InstallError::Failed {
                stage: StageName::Pair,
                detail: match output.exit_code {
                    Some(code) => format!("pair exited with code {code}"),
                    None => "pair was killed by a signal".into(),
                },
            });
        }
        serde_json::from_str(output.stdout.trim()).map_err(|_| InstallError::Failed {
            stage: StageName::Pair,
            detail: "pair printed something that is not its JSON answer".into(),
        })
    }

    /// Remove the service and the install root; the data dir too when the
    /// consent carries the typed confirmation.
    pub async fn uninstall(
        &self,
        inspection: &Inspection,
        consent: &Consent,
    ) -> Result<(), InstallError> {
        consent.check(inspection, &[PlanKind::Uninstall])?;
        self.stage(StageName::Service, async {
            let binary = inspection.installed_binary();
            let output = self
                .exec(
                    StageName::Service,
                    ExecRequest::new(
                        [binary.as_str(), "service", "uninstall", "--scope", "user"],
                        self.deadlines.service,
                    ),
                )
                .await?;
            if !output.success() {
                return Err(failure(StageName::Service, "removing the service", &output));
            }
            let target = if consent.delete_data {
                inspection.data_dir.clone()
            } else {
                format!("{}/{INSTALL_HOME_DIR}", inspection.data_dir)
            };
            let output = self
                .exec(
                    StageName::Service,
                    ExecRequest::new(["rm", "-rf", "--", target.as_str()], self.deadlines.remove),
                )
                .await?;
            if !output.success() {
                return Err(failure(StageName::Service, "removing the install", &output));
            }
            Ok(())
        })
        .await
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
