//! The Tauri shells over [`InstallerSessions`] (ADR-0235 P5/P6), behind the
//! `tauri-host` feature only `src-tauri` enables.
//!
//! Each command is one step of a bootstrap session; the stage transitions it
//! causes are emitted as [`STAGE_EVENT`], tagged with the session id and
//! carrying only the operation id, the stage and its outcome. The renderer
//! reaches these only through `lib/host-installer`, and only from the Devices
//! UI, which the `NEXT_PUBLIC_COGNIA_HOST_INSTALLER` build flag keeps hidden
//! until the real-machine smoke passes.

use std::path::PathBuf;
use std::sync::Arc;

use cognia_terminal::ssh::SshSpawnRequest;
use cognia_update_catalog::client::{trust_root, update_url, HttpUpdateNetwork, TrustFile};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::desktop::{
    wall_clock_ms, InspectionView, InstallChoice, InstalledView, InstallerFailure,
    InstallerSessions, OpenedView, PairView, ReleaseConfig,
};
use crate::session::{PlanKind, StageEvent, StageObserver};

/// The event every stage transition is emitted on.
pub const STAGE_EVENT: &str = "host-installer://stage";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StagePayload<'a> {
    session_id: &'a str,
    #[serde(flatten)]
    event: &'a StageEvent,
}

struct Emitting<R: Runtime> {
    app: AppHandle<R>,
    session_id: String,
}

impl<R: Runtime> StageObserver for Emitting<R> {
    fn on_stage(&self, event: &StageEvent) {
        let _ = self.app.emit(
            STAGE_EVENT,
            StagePayload {
                session_id: &self.session_id,
                event,
            },
        );
    }
}

fn observer<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Emitting<R> {
    Emitting {
        app: app.clone(),
        session_id: session_id.to_owned(),
    }
}

fn app_dir<R: Runtime>(app: &AppHandle<R>, cache: bool) -> Result<PathBuf, InstallerFailure> {
    let base = if cache {
        app.path().app_cache_dir()
    } else {
        app.path().app_data_dir()
    };
    base.map(|dir| dir.join("host-installer"))
        .map_err(|error| InstallerFailure::Denied {
            message: format!("the app's data directory is unavailable: {error}"),
        })
}

/// Dial a saved SSH profile. The request is the one the terminal builds for
/// the profile; its credentials are read from the OS keyring here.
#[tauri::command]
pub async fn host_installer_ssh_open(
    sessions: State<'_, InstallerSessions>,
    request: SshSpawnRequest,
) -> Result<OpenedView, InstallerFailure> {
    let known_hosts = cognia_terminal::terminal_host_service::ssh_known_hosts_path();
    sessions.open_ssh(request, known_hosts).await
}

#[tauri::command]
pub async fn host_installer_inspect<R: Runtime>(
    app: AppHandle<R>,
    sessions: State<'_, InstallerSessions>,
    session_id: String,
) -> Result<InspectionView, InstallerFailure> {
    sessions
        .inspect(&session_id, &observer(&app, &session_id))
        .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallArgs {
    pub session_id: String,
    pub inspection_id: String,
    pub plan: PlanKind,
    pub choice: InstallChoice,
}

#[tauri::command]
pub async fn host_installer_install<R: Runtime>(
    app: AppHandle<R>,
    sessions: State<'_, InstallerSessions>,
    args: InstallArgs,
) -> Result<InstalledView, InstallerFailure> {
    let release = ReleaseConfig {
        network: Arc::new(HttpUpdateNetwork::new(update_url())),
        root: trust_root(),
        trust: TrustFile::new(app_dir(&app, false)?.join("trust.json")),
        download_dir: app_dir(&app, true)?,
        now_ms: wall_clock_ms,
    };
    sessions
        .install(
            &args.session_id,
            &args.inspection_id,
            args.plan,
            &args.choice,
            &release,
            &observer(&app, &args.session_id),
        )
        .await
}

#[tauri::command]
pub async fn host_installer_pair<R: Runtime>(
    app: AppHandle<R>,
    sessions: State<'_, InstallerSessions>,
    session_id: String,
    inspection_id: String,
    plan: PlanKind,
    device_name: String,
) -> Result<PairView, InstallerFailure> {
    sessions
        .pair(
            &session_id,
            &inspection_id,
            plan,
            &device_name,
            &observer(&app, &session_id),
        )
        .await
}

#[tauri::command]
pub async fn host_installer_uninstall<R: Runtime>(
    app: AppHandle<R>,
    sessions: State<'_, InstallerSessions>,
    session_id: String,
    inspection_id: String,
    delete_data_confirmation: Option<String>,
) -> Result<(), InstallerFailure> {
    sessions
        .uninstall(
            &session_id,
            &inspection_id,
            delete_data_confirmation.as_deref(),
            &observer(&app, &session_id),
        )
        .await
}

#[tauri::command]
pub fn host_installer_close(sessions: State<'_, InstallerSessions>, session_id: String) -> bool {
    sessions.close(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{StageName, StageOutcome};

    #[test]
    fn a_stage_payload_carries_the_session_and_nothing_about_the_machine() {
        let event = StageEvent {
            operation_id: "inst-1".into(),
            stage: StageName::Upload,
            outcome: Some(StageOutcome::Unknown),
        };
        let json = serde_json::to_value(StagePayload {
            session_id: "hi-1",
            event: &event,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "sessionId": "hi-1",
                "operationId": "inst-1",
                "stage": "upload",
                "outcome": "unknown",
            })
        );
    }

    #[test]
    fn install_arguments_arrive_by_their_wire_names() {
        let args: InstallArgs = serde_json::from_value(serde_json::json!({
            "sessionId": "hi-1",
            "inspectionId": "inst-1-2",
            "plan": "repair",
            "choice": { "channel": "beta" },
        }))
        .unwrap();
        assert_eq!(args.plan, PlanKind::Repair);
        assert_eq!(args.choice.channel, "beta");
        assert_eq!(args.choice.local_account_id, None);
    }
}
