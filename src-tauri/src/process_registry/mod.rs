//! Unified managed-process registry.
//!
//! cognia spawns long-lived child processes from several independent
//! subsystem registries (external-agent CLIs, the chat sidecar, ACP + PTY
//! terminals, the MCP server). Each owns its own map keyed its own way, and
//! nothing knew, across subsystems, *which OS process cognia started and who
//! owns it*.
//!
//! This module is a thin **aggregator** over those registries. It does not
//! own any process — it pulls a liveness snapshot from each subsystem's
//! managed state on demand (`collect`) and dispatches lifecycle control back
//! to the owning subsystem (`control_managed_process`). The snapshot rides the
//! perf sampler (`crate::perf`) as `PerfSample.managed`, powering the
//! performance panel's "Managed Processes" tab; the same list backs the
//! standalone `list_managed_processes` command.
//!
//! Design constraints honored here:
//! - **No lock held across `.await`.** Every subsystem accessor locks, clones
//!   owned data, and releases before this module awaits anything.
//! - **Control lives where the process lives.** We call each subsystem's
//!   existing kill/stop path rather than reaching into its internals. External
//!   agents are the exception: their kill/restart is orchestrated in the
//!   renderer (`ExternalAgentManager`) so the JS connection state stays in
//!   sync, so this native command rejects them.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::claude::sidecar::{kill_sidecar, SidecarState};
use crate::external_agent::commands::{AcpTerminalState, ExternalAgentState};
use crate::external_agent::process::ExternalAgentProcessState;
use crate::external_agent::terminal::AcpTerminalManagedInfo;
use crate::mcp_server::{McpManagedInfo, McpServerState};
use crate::terminal::{TerminalSessionInfo, TerminalState};

/// Singleton logical id for the one-per-app MCP server row.
const MCP_SINGLETON_ID: &str = "mcp-server";
/// Singleton logical id for the one-per-app chat sidecar row.
const SIDECAR_SINGLETON_ID: &str = "chat-sidecar";

/// The cognia subsystem that owns a managed process. Serialized camelCase so
/// the TS union (`lib/perf/backend/types.ts`) matches on `"externalAgent"` etc.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ManagedSubsystem {
    ExternalAgent,
    ChatSidecar,
    AcpTerminal,
    IntegratedTerminal,
    McpServer,
}

/// Lifecycle state of a managed process, normalized across subsystems.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ManagedStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Error,
}

/// A lifecycle action the performance panel can request on a managed process.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ManagedControlAction {
    Kill,
    Restart,
}

/// One row in the unified managed-process view. Joined to the OS process by
/// `pid` on the frontend (against `PerfSample.processes`) for live CPU/memory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProcess {
    pub subsystem: ManagedSubsystem,
    /// Logical id within the subsystem (config id, terminal id, or a singleton
    /// sentinel for the sidecar / MCP server). Used to route control actions.
    pub id: String,
    /// Process / command identifier (e.g. `npx`, `/bin/zsh`, `claude-host.mjs`,
    /// `127.0.0.1:<port>`). Not a translatable label — the subsystem's display
    /// name is localized on the frontend from `subsystem`.
    pub name: String,
    pub pid: Option<u32>,
    pub status: ManagedStatus,
    pub can_kill: bool,
    pub can_restart: bool,
    /// Optional secondary detail (session id, project id, start time…).
    pub detail: Option<String>,
}

// ---------------------------------------------------------------------------
// Pure row builders (unit-tested)
// ---------------------------------------------------------------------------

fn map_external_status(state: &ExternalAgentProcessState) -> ManagedStatus {
    match state {
        ExternalAgentProcessState::Starting => ManagedStatus::Starting,
        ExternalAgentProcessState::Running => ManagedStatus::Running,
        ExternalAgentProcessState::Stopping => ManagedStatus::Stopping,
        ExternalAgentProcessState::Stopped => ManagedStatus::Stopped,
        ExternalAgentProcessState::Failed => ManagedStatus::Error,
    }
}

fn external_row(
    id: String,
    command: String,
    pid: Option<u32>,
    state: &ExternalAgentProcessState,
) -> ManagedProcess {
    ManagedProcess {
        subsystem: ManagedSubsystem::ExternalAgent,
        id,
        name: command,
        pid,
        status: map_external_status(state),
        can_kill: true,
        // Restart = disconnect + reconnect, orchestrated in the renderer.
        can_restart: true,
        detail: None,
    }
}

fn acp_row(info: &AcpTerminalManagedInfo) -> ManagedProcess {
    ManagedProcess {
        subsystem: ManagedSubsystem::AcpTerminal,
        id: info.id.clone(),
        name: info.command.clone(),
        pid: info.pid,
        status: if info.running {
            ManagedStatus::Running
        } else {
            ManagedStatus::Stopped
        },
        can_kill: true,
        can_restart: false,
        detail: Some(info.session_id.clone()),
    }
}

fn integrated_row(info: &TerminalSessionInfo) -> ManagedProcess {
    ManagedProcess {
        subsystem: ManagedSubsystem::IntegratedTerminal,
        id: info.id.clone(),
        name: info.shell.clone(),
        pid: info.pid,
        // Presence in the session map means the PTY is live; exit removes it.
        status: ManagedStatus::Running,
        can_kill: true,
        can_restart: false,
        detail: info.project_id.clone(),
    }
}

fn mcp_row(info: &McpManagedInfo) -> ManagedProcess {
    ManagedProcess {
        subsystem: ManagedSubsystem::McpServer,
        id: MCP_SINGLETON_ID.to_string(),
        name: format!("127.0.0.1:{}", info.port),
        pid: info.pid,
        status: ManagedStatus::Running,
        can_kill: true,
        can_restart: false,
        detail: info.started_at.clone(),
    }
}

fn sidecar_row(pid: Option<u32>, ready: bool) -> ManagedProcess {
    ManagedProcess {
        subsystem: ManagedSubsystem::ChatSidecar,
        id: SIDECAR_SINGLETON_ID.to_string(),
        name: "claude-host.mjs".to_string(),
        pid,
        status: if ready {
            ManagedStatus::Running
        } else {
            ManagedStatus::Starting
        },
        can_kill: true,
        can_restart: false,
        detail: None,
    }
}

// ---------------------------------------------------------------------------
// Aggregation + control
// ---------------------------------------------------------------------------

/// Snapshot every in-scope subsystem's live processes. Runs on the perf
/// sampler tick (which owns the `AppHandle`); each accessor is non-blocking
/// and never holds a lock across an `.await`.
pub async fn collect(app: &AppHandle) -> Vec<ManagedProcess> {
    let mut out = Vec::new();

    // External agents (Codex / Claude Code / OpenCode CLIs).
    if let Some(st) = app.try_state::<ExternalAgentState>() {
        let mgr = st.inner().0.clone();
        for id in mgr.list().await {
            if let Some(proc) = mgr.get(&id).await {
                // `try_lock` skips a process momentarily locked in `send`
                // rather than stalling the sampler.
                if let Ok(p) = proc.try_lock() {
                    out.push(external_row(
                        p.get_config().id.clone(),
                        p.get_config().command.clone(),
                        p.get_pid(),
                        &p.get_state(),
                    ));
                }
            }
        }
    }

    // ACP terminals (agent-run shells).
    if let Some(st) = app.try_state::<AcpTerminalState>() {
        for info in st.inner().0.managed_snapshot().await {
            out.push(acp_row(&info));
        }
    }

    // Integrated terminal PTYs.
    if let Some(st) = app.try_state::<TerminalState>() {
        for info in st.inner().list_all() {
            out.push(integrated_row(&info));
        }
    }

    // MCP server (one row for its Node sidecar).
    if let Some(st) = app.try_state::<McpServerState>() {
        if let Some(info) = st.inner().managed_snapshot() {
            out.push(mcp_row(&info));
        }
    }

    // Chat sidecar.
    if let Some(st) = app.try_state::<SidecarState>() {
        if let Some((pid, ready)) = st.inner().managed_snapshot().await {
            out.push(sidecar_row(pid, ready));
        }
    }

    out
}

/// Kill the managed process `id` owned by `subsystem` via that subsystem's
/// own teardown path.
async fn kill_subsystem(
    app: &AppHandle,
    subsystem: ManagedSubsystem,
    id: &str,
) -> Result<(), String> {
    match subsystem {
        ManagedSubsystem::AcpTerminal => {
            let st = app.state::<AcpTerminalState>();
            st.inner().0.kill(id).await?;
            let _ = st.inner().0.release(id).await;
            Ok(())
        }
        ManagedSubsystem::IntegratedTerminal => {
            let st = app.state::<TerminalState>();
            let session = st
                .inner()
                .get(id)
                .ok_or_else(|| format!("terminal {id} not found"))?;
            session.kill().map_err(|e| e.to_string())?;
            st.inner().remove(id);
            Ok(())
        }
        ManagedSubsystem::McpServer => {
            let st = app.state::<McpServerState>();
            st.inner().stop().map_err(|e| e.to_string())
        }
        ManagedSubsystem::ChatSidecar => {
            let st = app.state::<SidecarState>();
            kill_sidecar(st.inner().clone()).await;
            Ok(())
        }
        ManagedSubsystem::ExternalAgent => {
            Err("external-agent lifecycle is controlled in the renderer".to_string())
        }
    }
}

/// Control a managed process. Only `Kill` is served natively; `Restart` for the
/// Rust-supervised subsystems is not supported (the panel greys it out), and
/// external-agent control is routed through the renderer.
#[tauri::command]
pub async fn control_managed_process(
    app: AppHandle,
    subsystem: ManagedSubsystem,
    id: String,
    action: ManagedControlAction,
) -> Result<(), String> {
    match action {
        ManagedControlAction::Kill => kill_subsystem(&app, subsystem, &id).await,
        ManagedControlAction::Restart => Err(format!(
            "restart is not supported for {subsystem:?} via the native registry"
        )),
    }
}

/// List every managed process. Backs non-perf callers (and tests); the perf
/// panel reads the same data off `PerfSample.managed`.
#[tauri::command]
pub async fn list_managed_processes(app: AppHandle) -> Result<Vec<ManagedProcess>, String> {
    Ok(collect(&app).await)
}

/// Stop the managed processes that the pre-existing `RunEvent::Exit` arm does
/// **not** already tear down (chat sidecar, integrated terminals, MCP server),
/// so a graceful shutdown doesn't orphan them. External agents + ACP terminals
/// are killed by their own `kill_all()` calls in that arm.
pub async fn teardown(app: &AppHandle) {
    if let Some(st) = app.try_state::<SidecarState>() {
        kill_sidecar(st.inner().clone()).await;
    }
    if let Some(st) = app.try_state::<TerminalState>() {
        for info in st.inner().list_all() {
            if let Some(session) = st.inner().remove(&info.id) {
                let _ = session.kill();
            }
        }
    }
    if let Some(st) = app.try_state::<McpServerState>() {
        let _ = st.inner().stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::SessionOrigin;

    #[test]
    fn subsystem_serializes_camel_case() {
        let s = |v: &ManagedSubsystem| serde_json::to_string(v).unwrap();
        assert_eq!(s(&ManagedSubsystem::ExternalAgent), "\"externalAgent\"");
        assert_eq!(s(&ManagedSubsystem::ChatSidecar), "\"chatSidecar\"");
        assert_eq!(s(&ManagedSubsystem::AcpTerminal), "\"acpTerminal\"");
        assert_eq!(
            s(&ManagedSubsystem::IntegratedTerminal),
            "\"integratedTerminal\""
        );
        assert_eq!(s(&ManagedSubsystem::McpServer), "\"mcpServer\"");
    }

    #[test]
    fn control_action_deserializes_camel_case() {
        let kill: ManagedControlAction = serde_json::from_str("\"kill\"").unwrap();
        let restart: ManagedControlAction = serde_json::from_str("\"restart\"").unwrap();
        assert_eq!(kill, ManagedControlAction::Kill);
        assert_eq!(restart, ManagedControlAction::Restart);
    }

    #[test]
    fn managed_process_round_trips_camel_case() {
        let row = sidecar_row(Some(42), true);
        let json = serde_json::to_string(&row).unwrap();
        assert!(json.contains("\"subsystem\":\"chatSidecar\""));
        assert!(json.contains("\"pid\":42"));
        assert!(json.contains("\"status\":\"running\""));
        assert!(json.contains("\"canKill\":true"));
        assert!(json.contains("\"canRestart\":false"));
    }

    #[test]
    fn map_external_status_covers_all_variants() {
        use ExternalAgentProcessState as S;
        assert_eq!(map_external_status(&S::Starting), ManagedStatus::Starting);
        assert_eq!(map_external_status(&S::Running), ManagedStatus::Running);
        assert_eq!(map_external_status(&S::Stopping), ManagedStatus::Stopping);
        assert_eq!(map_external_status(&S::Stopped), ManagedStatus::Stopped);
        assert_eq!(map_external_status(&S::Failed), ManagedStatus::Error);
    }

    #[test]
    fn external_row_is_kill_and_restart_capable() {
        let row = external_row(
            "cfg-1".into(),
            "npx".into(),
            Some(7),
            &ExternalAgentProcessState::Running,
        );
        assert_eq!(row.subsystem, ManagedSubsystem::ExternalAgent);
        assert_eq!(row.id, "cfg-1");
        assert_eq!(row.name, "npx");
        assert_eq!(row.pid, Some(7));
        assert_eq!(row.status, ManagedStatus::Running);
        assert!(row.can_kill && row.can_restart);
    }

    #[test]
    fn acp_row_is_kill_only_and_carries_session() {
        let info = AcpTerminalManagedInfo {
            id: "term_1".into(),
            session_id: "sess-9".into(),
            command: "cat".into(),
            pid: Some(9),
            running: true,
        };
        let row = acp_row(&info);
        assert_eq!(row.subsystem, ManagedSubsystem::AcpTerminal);
        assert_eq!(row.status, ManagedStatus::Running);
        assert!(row.can_kill && !row.can_restart);
        assert_eq!(row.detail.as_deref(), Some("sess-9"));

        let dead = acp_row(&AcpTerminalManagedInfo {
            running: false,
            ..info
        });
        assert_eq!(dead.status, ManagedStatus::Stopped);
    }

    #[test]
    fn integrated_row_uses_shell_and_project() {
        let info = TerminalSessionInfo {
            id: "pty-1".into(),
            project_id: Some("proj-a".into()),
            extension_id: None,
            origin: SessionOrigin::Local,
            shell: "/bin/zsh".into(),
            pid: Some(11),
        };
        let row = integrated_row(&info);
        assert_eq!(row.subsystem, ManagedSubsystem::IntegratedTerminal);
        assert_eq!(row.name, "/bin/zsh");
        assert_eq!(row.pid, Some(11));
        assert_eq!(row.detail.as_deref(), Some("proj-a"));
        assert!(row.can_kill && !row.can_restart);
    }

    #[test]
    fn mcp_row_is_singleton_kill_only() {
        let info = McpManagedInfo {
            port: 8765,
            pid: Some(3),
            started_at: Some("2026-07-17T00:00:00Z".into()),
        };
        let row = mcp_row(&info);
        assert_eq!(row.id, MCP_SINGLETON_ID);
        assert!(row.name.contains("8765"));
        assert!(row.can_kill && !row.can_restart);
        assert_eq!(row.detail.as_deref(), Some("2026-07-17T00:00:00Z"));
    }

    #[test]
    fn sidecar_row_status_reflects_readiness() {
        assert_eq!(sidecar_row(None, false).status, ManagedStatus::Starting);
        assert_eq!(sidecar_row(Some(1), true).status, ManagedStatus::Running);
        assert_eq!(sidecar_row(Some(1), true).id, SIDECAR_SINGLETON_ID);
    }
}
