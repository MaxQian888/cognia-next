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
use crate::codeserver::process::{CodeServerManagedInfo, CodeServerState};
use crate::external_agent::commands::{AcpTerminalState, ExternalAgentState};
use crate::external_agent::process::ExternalAgentProcessState;
use crate::external_agent::terminal::AcpTerminalManagedInfo;
use crate::mcp_server::{McpManagedInfo, McpServerState};
use crate::terminal::headless::{HeadlessManagedInfo, HeadlessTerminalState};
use crate::terminal::{TerminalSessionInfo, TerminalState};
use cognia_plugin_runtime::lifecycle::{
    node_plugin_snapshot, stop_all_node_plugins, stop_node_plugin, NodePluginManagedInfo,
};
use cognia_plugin_runtime::PluginRuntimeState;

use crate::companion_api::tunnel::TunnelManagedInfo;

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
    CodeServer,
    /// Long-lived Node plugin hosts (one per running Node-runtime plugin).
    PluginHost,
    /// Headless PTY sessions — a second, independent terminal registry.
    HeadlessTerminal,
    /// The cloudflared tunnel. Not a cognia binary, but a child we spawn and
    /// the only one that exposes a public hostname, so it belongs on the list.
    Tunnel,
    /// Background jobs — `bash(run_in_background)` and scheduled-task work,
    /// owned by `cognia-jobs`. Previously invisible here: they were spawned
    /// inside the sidecar, so they were the sidecar's grandchildren and no
    /// subsystem registry knew they existed.
    BackgroundJob,
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
        // Sessions are deliberately *kept* in the store after the shell exits
        // so the renderer can still read scrollback, so presence proves
        // nothing — only the waiter thread's `alive` flag does.
        status: if info.alive {
            ManagedStatus::Running
        } else {
            ManagedStatus::Stopped
        },
        // Kill on an exited session degrades to evicting the row (the PID is
        // already reaped and may have been reused), which is what the user
        // means by "clear this out".
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

fn codeserver_row(info: &CodeServerManagedInfo) -> ManagedProcess {
    ManagedProcess {
        subsystem: ManagedSubsystem::CodeServer,
        // The canonical project root is the instance key, so it is also what
        // kill / restart route on.
        id: info.root.clone(),
        name: format!("code-server 127.0.0.1:{}", info.port),
        pid: info.pid,
        // `managed_snapshot` prunes exited children, so a listed row is alive.
        status: ManagedStatus::Running,
        can_kill: true,
        // Restart = stop + re-ensure, both available natively for this subsystem.
        can_restart: true,
        detail: Some(info.root.clone()),
    }
}

fn plugin_host_row(info: &NodePluginManagedInfo) -> ManagedProcess {
    ManagedProcess {
        subsystem: ManagedSubsystem::PluginHost,
        id: info.plugin_id.clone(),
        name: format!("node ({})", info.plugin_id),
        pid: info.pid,
        status: if info.launching {
            ManagedStatus::Starting
        } else {
            ManagedStatus::Running
        },
        can_kill: true,
        // Restarting means re-running the plugin's activation, which is the
        // plugin manager's job, not this registry's.
        can_restart: false,
        detail: Some(info.plugin_id.clone()),
    }
}

fn headless_row(info: &HeadlessManagedInfo) -> ManagedProcess {
    ManagedProcess {
        subsystem: ManagedSubsystem::HeadlessTerminal,
        id: info.id.clone(),
        name: info.shell.clone(),
        pid: info.pid,
        // Same rule as the interactive PTYs: the session outlives its child,
        // so only the waiter thread's flag can be trusted.
        status: if info.alive {
            ManagedStatus::Running
        } else {
            ManagedStatus::Stopped
        },
        can_kill: true,
        can_restart: false,
        detail: None,
    }
}

/// Singleton logical id for the one-per-app cloudflared tunnel row.
const TUNNEL_SINGLETON_ID: &str = "cloudflared";

fn tunnel_row(info: &TunnelManagedInfo) -> ManagedProcess {
    ManagedProcess {
        subsystem: ManagedSubsystem::Tunnel,
        id: TUNNEL_SINGLETON_ID.to_string(),
        name: "cloudflared".to_string(),
        pid: info.pid,
        status: ManagedStatus::Running,
        can_kill: true,
        can_restart: false,
        detail: info.public_url.clone(),
    }
}

/// Build a row for one running background job.
///
/// `detail` carries the owner so the panel can distinguish a chat-session job
/// from one a scheduled task left running — the distinction that makes an
/// unexpected long-lived process explicable rather than alarming.
fn background_job_row(job: &cognia_jobs::JobRecord) -> ManagedProcess {
    let detail = match &job.owner {
        cognia_jobs::JobOwner::Session { session_id } => format!("session {session_id}"),
        cognia_jobs::JobOwner::ScheduledTask { task_id } => format!("scheduled task {task_id}"),
        cognia_jobs::JobOwner::App => "detached".to_string(),
    };
    ManagedProcess {
        subsystem: ManagedSubsystem::BackgroundJob,
        id: job.id.clone(),
        name: job.label.clone().unwrap_or_else(|| job.command.clone()),
        pid: job.pid,
        status: ManagedStatus::Running,
        can_kill: true,
        can_restart: false,
        detail: Some(detail),
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

    // Pro IDE code-server instances (one per project root). These outlive the
    // pane that opened them, so this row is the user's only way to see and stop
    // them short of quitting the app.
    if let Some(st) = app.try_state::<CodeServerState>() {
        for info in st.inner().managed_snapshot().await {
            out.push(codeserver_row(&info));
        }
    }

    // Node plugin hosts — long-lived children of the plugin runtime.
    if let Some(st) = app.try_state::<PluginRuntimeState>() {
        for info in node_plugin_snapshot(st.inner()) {
            out.push(plugin_host_row(&info));
        }
    }

    // Headless PTYs (agent/automation shells), independent of `TerminalState`.
    if let Some(st) = app.try_state::<HeadlessTerminalState>() {
        for info in st.inner().managed_snapshot() {
            out.push(headless_row(&info));
        }
    }

    // The cloudflared tunnel, when one is up.
    if let Some(st) = app.try_state::<crate::companion_api::CompanionServerState>() {
        if let Some(info) = st.inner().tunnel.managed_snapshot() {
            out.push(tunnel_row(&info));
        }
    }

    // Background jobs. Read from the process-global supervisor rather than
    // Tauri state, because the same registry has to work under the headless
    // binary where there is no `AppHandle` to hang state off.
    if let Some(sup) = crate::jobs::supervisor() {
        if let Ok(jobs) = sup.list(None) {
            for job in jobs.iter().filter(|j| !j.status.is_terminal()) {
                out.push(background_job_row(job));
            }
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
        // The panel is a user surface, so it may kill across owners — passing
        // `None` as the requester deliberately bypasses the per-session scoping
        // that constrains an agent.
        ManagedSubsystem::BackgroundJob => {
            let sup = crate::jobs::supervisor()
                .ok_or_else(|| "background jobs are not available".to_string())?;
            sup.kill(id, None)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
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
            // `PtySession::kill` is a no-op once the child has been reaped, so
            // this is safe for the exited rows the panel also lists.
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
        ManagedSubsystem::CodeServer => {
            app.state::<CodeServerState>().inner().stop(id).await;
            Ok(())
        }
        ManagedSubsystem::PluginHost => {
            let st = app.state::<PluginRuntimeState>();
            stop_node_plugin(st.inner(), id)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        ManagedSubsystem::HeadlessTerminal => {
            let st = app.state::<HeadlessTerminalState>();
            if st.inner().kill(id) {
                Ok(())
            } else {
                Err(format!("headless terminal {id} not found"))
            }
        }
        ManagedSubsystem::Tunnel => {
            let st = app.state::<crate::companion_api::CompanionServerState>();
            st.inner().tunnel.stop();
            Ok(())
        }
        ManagedSubsystem::ExternalAgent => {
            Err("external-agent lifecycle is controlled in the renderer".to_string())
        }
    }
}

/// Restart the managed process `id`. Only code-server supports this natively —
/// its instances are keyed by project root, so a restart is just stop +
/// re-ensure with no renderer state to keep in sync.
async fn restart_subsystem(
    app: &AppHandle,
    subsystem: ManagedSubsystem,
    id: &str,
) -> Result<(), String> {
    match subsystem {
        ManagedSubsystem::CodeServer => {
            let state = app.state::<CodeServerState>();
            state.inner().stop(id).await;
            state.inner().ensure(app, id).await.map(|_| ())
        }
        _ => Err(format!(
            "restart is not supported for {subsystem:?} via the native registry"
        )),
    }
}

/// Control a managed process. `Kill` is served natively for every
/// Rust-supervised subsystem; `Restart` only for code-server (the panel greys it
/// out elsewhere), and external-agent control is routed through the renderer.
#[tauri::command]
pub async fn control_managed_process(
    app: AppHandle,
    subsystem: ManagedSubsystem,
    id: String,
    action: ManagedControlAction,
) -> Result<(), String> {
    match action {
        ManagedControlAction::Kill => kill_subsystem(&app, subsystem, &id).await,
        ManagedControlAction::Restart => restart_subsystem(&app, subsystem, &id).await,
    }
}

/// List every managed process. Backs non-perf callers (and tests); the perf
/// panel reads the same data off `PerfSample.managed`.
#[tauri::command]
pub async fn list_managed_processes(app: AppHandle) -> Result<Vec<ManagedProcess>, String> {
    Ok(collect(&app).await)
}

/// Every subsystem in the registry, in teardown order.
///
/// Paired with [`subsystem_index`] so the list cannot silently fall behind the
/// enum: adding a variant breaks that function's exhaustive `match`, and the
/// `every_subsystem_is_torn_down` test then catches a missing array entry.
/// This drift is not hypothetical — code-server was added to [`collect`] but
/// not to the shutdown path, and leaked a Node server holding a port past every
/// app exit until this list existed.
pub const ALL_SUBSYSTEMS: [ManagedSubsystem; 10] = [
    ManagedSubsystem::ExternalAgent,
    ManagedSubsystem::AcpTerminal,
    ManagedSubsystem::IntegratedTerminal,
    ManagedSubsystem::HeadlessTerminal,
    ManagedSubsystem::ChatSidecar,
    ManagedSubsystem::McpServer,
    ManagedSubsystem::CodeServer,
    ManagedSubsystem::PluginHost,
    ManagedSubsystem::Tunnel,
    ManagedSubsystem::BackgroundJob,
];

/// Position of `subsystem` in [`ALL_SUBSYSTEMS`]. Exhaustive by construction.
///
/// Only the parity test calls this, but it stays in non-test builds so the
/// exhaustive `match` still fails compilation the moment a variant is added.
#[allow(dead_code)]
const fn subsystem_index(subsystem: ManagedSubsystem) -> usize {
    match subsystem {
        ManagedSubsystem::ExternalAgent => 0,
        ManagedSubsystem::AcpTerminal => 1,
        ManagedSubsystem::IntegratedTerminal => 2,
        ManagedSubsystem::HeadlessTerminal => 3,
        ManagedSubsystem::ChatSidecar => 4,
        ManagedSubsystem::McpServer => 5,
        ManagedSubsystem::CodeServer => 6,
        ManagedSubsystem::PluginHost => 7,
        ManagedSubsystem::Tunnel => 8,
        ManagedSubsystem::BackgroundJob => 9,
    }
}

/// Stop every process owned by one subsystem. Each arm calls that subsystem's
/// own teardown path; missing state (mobile, a failed init) is a no-op.
async fn teardown_subsystem(app: &AppHandle, subsystem: ManagedSubsystem) {
    match subsystem {
        ManagedSubsystem::ExternalAgent => {
            if let Some(st) = app.try_state::<ExternalAgentState>() {
                let _ = st.inner().0.clone().kill_all().await;
            }
        }
        ManagedSubsystem::AcpTerminal => {
            if let Some(st) = app.try_state::<AcpTerminalState>() {
                let _ = st.inner().0.clone().kill_all().await;
            }
        }
        ManagedSubsystem::IntegratedTerminal => {
            if let Some(st) = app.try_state::<TerminalState>() {
                for info in st.inner().list_all() {
                    if let Some(session) = st.inner().remove(&info.id) {
                        let _ = session.kill();
                    }
                }
            }
        }
        ManagedSubsystem::ChatSidecar => {
            if let Some(st) = app.try_state::<SidecarState>() {
                kill_sidecar(st.inner().clone()).await;
            }
        }
        ManagedSubsystem::McpServer => {
            if let Some(st) = app.try_state::<McpServerState>() {
                let _ = st.inner().stop();
            }
        }
        ManagedSubsystem::CodeServer => {
            if let Some(st) = app.try_state::<CodeServerState>() {
                st.inner().stop_all().await;
            }
        }
        ManagedSubsystem::HeadlessTerminal => {
            if let Some(st) = app.try_state::<HeadlessTerminalState>() {
                st.inner().kill_all();
            }
        }
        ManagedSubsystem::PluginHost => {
            if let Some(st) = app.try_state::<PluginRuntimeState>() {
                stop_all_node_plugins(st.inner()).await;
            }
        }
        ManagedSubsystem::Tunnel => {
            if let Some(st) = app.try_state::<crate::companion_api::CompanionServerState>() {
                st.inner().tunnel.stop();
            }
        }
        // App exit reaps every background job, including `detach`ed ones.
        // Detaching buys survival past the CHAT SESSION, never past the app —
        // leaving orphan daemons behind is the failure mode this subsystem
        // exists to end.
        ManagedSubsystem::BackgroundJob => {
            if let Some(sup) = crate::jobs::supervisor() {
                match sup.shutdown().await {
                    Ok(ids) if !ids.is_empty() => {
                        log::info!("jobs: killed {} background job(s) on exit", ids.len());
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("jobs: shutdown failed: {e}"),
                }
            }
        }
    }
}

/// Stop every cognia-spawned child process on app exit.
///
/// Covers the whole registry plus the long-lived children that predate it and
/// have no registry row yet (the cloudflared tunnel). `kill_on_drop` is *not* a
/// fallback here: on macOS the Tauri event loop never returns, so managed state
/// is never dropped and every one of these needs an explicit call.
pub async fn teardown(app: &AppHandle) {
    for subsystem in ALL_SUBSYSTEMS {
        teardown_subsystem(app, subsystem).await;
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
        assert_eq!(s(&ManagedSubsystem::CodeServer), "\"codeServer\"");
    }

    #[test]
    fn codeserver_row_routes_on_the_project_root_and_allows_restart() {
        let row = codeserver_row(&CodeServerManagedInfo {
            root: "/work/proj".into(),
            port: 43117,
            pid: Some(4242),
        });
        assert_eq!(row.subsystem, ManagedSubsystem::CodeServer);
        // Kill / restart route on the id, which must be the instance key.
        assert_eq!(row.id, "/work/proj");
        assert!(row.name.contains("43117"));
        assert_eq!(row.pid, Some(4242));
        assert_eq!(row.status, ManagedStatus::Running);
        assert!(row.can_kill && row.can_restart);
        assert_eq!(row.detail.as_deref(), Some("/work/proj"));
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

    fn pty_info(alive: bool) -> TerminalSessionInfo {
        TerminalSessionInfo {
            id: "pty-1".into(),
            project_id: Some("proj-a".into()),
            extension_id: None,
            origin: SessionOrigin::Local,
            shell: "/bin/zsh".into(),
            pid: Some(11),
            alive,
        }
    }

    #[test]
    fn integrated_row_uses_shell_and_project() {
        let row = integrated_row(&pty_info(true));
        assert_eq!(row.subsystem, ManagedSubsystem::IntegratedTerminal);
        assert_eq!(row.name, "/bin/zsh");
        assert_eq!(row.pid, Some(11));
        assert_eq!(row.detail.as_deref(), Some("proj-a"));
        assert_eq!(row.status, ManagedStatus::Running);
        assert!(row.can_kill && !row.can_restart);
    }

    #[test]
    fn integrated_row_reports_an_exited_shell_as_stopped() {
        // Regression: the status was hardcoded `Running`, so a shell the user
        // exited normally stayed listed as live forever with a stale PID.
        let row = integrated_row(&pty_info(false));
        assert_eq!(row.status, ManagedStatus::Stopped);
        // Still killable — that is how the user evicts the dead row.
        assert!(row.can_kill);
    }

    #[test]
    fn plugin_host_row_is_kill_only_and_shows_launching() {
        let running = plugin_host_row(&NodePluginManagedInfo {
            plugin_id: "web-tools".into(),
            pid: Some(4242),
            launching: false,
        });
        assert_eq!(running.subsystem, ManagedSubsystem::PluginHost);
        assert_eq!(running.id, "web-tools");
        assert!(running.name.contains("web-tools"));
        assert_eq!(running.pid, Some(4242));
        assert_eq!(running.status, ManagedStatus::Running);
        assert!(running.can_kill && !running.can_restart);

        // A reserved-but-not-yet-spawned host has no pid to join on.
        let launching = plugin_host_row(&NodePluginManagedInfo {
            plugin_id: "web-tools".into(),
            pid: None,
            launching: true,
        });
        assert_eq!(launching.status, ManagedStatus::Starting);
        assert_eq!(launching.pid, None);
    }

    #[test]
    fn headless_row_tracks_child_liveness() {
        let info = HeadlessManagedInfo {
            id: "hl-1".into(),
            shell: "/bin/zsh".into(),
            pid: Some(77),
            alive: true,
        };
        let row = headless_row(&info);
        assert_eq!(row.subsystem, ManagedSubsystem::HeadlessTerminal);
        assert_eq!(row.name, "/bin/zsh");
        assert_eq!(row.status, ManagedStatus::Running);

        let dead = headless_row(&HeadlessManagedInfo {
            alive: false,
            ..info
        });
        assert_eq!(dead.status, ManagedStatus::Stopped);
    }

    #[test]
    fn tunnel_row_is_a_singleton_carrying_the_public_url() {
        let row = tunnel_row(&TunnelManagedInfo {
            pid: Some(909),
            public_url: Some("https://x.trycloudflare.com".into()),
        });
        assert_eq!(row.subsystem, ManagedSubsystem::Tunnel);
        assert_eq!(row.id, TUNNEL_SINGLETON_ID);
        assert_eq!(row.pid, Some(909));
        assert!(row.can_kill && !row.can_restart);
        assert_eq!(row.detail.as_deref(), Some("https://x.trycloudflare.com"));
    }

    fn job(owner: cognia_jobs::JobOwner) -> cognia_jobs::JobRecord {
        cognia_jobs::JobRecord {
            id: "job-1".into(),
            command: "pnpm dev".into(),
            cwd: "/repo".into(),
            owner,
            status: cognia_jobs::JobStatus::Running,
            exit_code: None,
            pid: Some(4242),
            started_at_ms: 1,
            ended_at_ms: None,
            total_output_bytes: 0,
            dropped_output_bytes: 0,
            label: None,
        }
    }

    #[test]
    fn background_job_row_is_kill_only_and_falls_back_to_the_command() {
        let row = background_job_row(&job(cognia_jobs::JobOwner::Session {
            session_id: "s1".into(),
        }));
        assert_eq!(row.subsystem, ManagedSubsystem::BackgroundJob);
        assert_eq!(row.id, "job-1");
        assert_eq!(row.name, "pnpm dev", "no label ⇒ show the command");
        assert_eq!(row.pid, Some(4242));
        assert!(row.can_kill && !row.can_restart);
    }

    #[test]
    fn background_job_row_labels_the_owner_so_a_stray_process_is_explicable() {
        // "Why is this still running?" is answered by the owner, which is the
        // one thing the old sidecar-owned shells could never tell anyone.
        let session = background_job_row(&job(cognia_jobs::JobOwner::Session {
            session_id: "s1".into(),
        }));
        assert_eq!(session.detail.as_deref(), Some("session s1"));

        let scheduled = background_job_row(&job(cognia_jobs::JobOwner::ScheduledTask {
            task_id: "nightly".into(),
        }));
        assert_eq!(scheduled.detail.as_deref(), Some("scheduled task nightly"));

        let detached = background_job_row(&job(cognia_jobs::JobOwner::App));
        assert_eq!(detached.detail.as_deref(), Some("detached"));
    }

    #[test]
    fn background_job_row_prefers_an_explicit_label_over_the_raw_command() {
        let mut rec = job(cognia_jobs::JobOwner::App);
        rec.label = Some("dev server".into());
        assert_eq!(background_job_row(&rec).name, "dev server");
    }

    #[test]
    fn new_subsystems_serialize_camel_case() {
        let s = |v: &ManagedSubsystem| serde_json::to_string(v).unwrap();
        assert_eq!(s(&ManagedSubsystem::BackgroundJob), "\"backgroundJob\"");
        assert_eq!(s(&ManagedSubsystem::PluginHost), "\"pluginHost\"");
        assert_eq!(
            s(&ManagedSubsystem::HeadlessTerminal),
            "\"headlessTerminal\""
        );
        assert_eq!(s(&ManagedSubsystem::Tunnel), "\"tunnel\"");
    }

    #[test]
    fn every_subsystem_is_torn_down() {
        // `teardown_subsystem` is exhaustive by `match`, but the list it is
        // driven from is not. Pin the two together so a new variant cannot be
        // collected without also being shut down (the code-server leak).
        assert_eq!(ALL_SUBSYSTEMS.len(), 10);
        for (i, subsystem) in ALL_SUBSYSTEMS.iter().enumerate() {
            assert_eq!(
                subsystem_index(*subsystem),
                i,
                "{subsystem:?} is out of order or listed twice in ALL_SUBSYSTEMS"
            );
        }
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
