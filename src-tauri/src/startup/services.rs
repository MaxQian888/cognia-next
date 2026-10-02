//! Boot steps for the app's background services: the gateway, companion
//! reachability, the Node runtime, the timers that fire while the app is
//! minimized (the workflow cron daemon + webhook router, ADR-0011, and the app
//! scheduler's alarm daemon), the A2UI bridge, background jobs, the agent
//! session store and the CLI bridge.

use std::path::{Path, PathBuf};

use tauri::{App, Emitter, Manager};

use crate::subscription::provider::ProviderId;

/// Resolve resources before any subsystem can spawn a sidecar.
pub(crate) fn sidecar_location(app: &App) {
    crate::codeserver::install_host(app.handle());
    let resource_dir = app.path().resource_dir().ok();
    let force_checkout =
        cfg!(feature = "agent-debug") && std::env::var_os("COGNIA_AGENT_DEBUG").is_some();
    match cognia_sidecar::locate(
        resource_dir.as_deref(),
        cfg!(debug_assertions),
        force_checkout,
    ) {
        Ok(directory) => {
            if let Err(error) = cognia_sidecar::SIDECAR.install(directory) {
                log::warn!("install sidecar directory: {error}");
            }
        }
        Err(error) => log::error!("resolve sidecar directory: {error}"),
    }
}

/// Where the app keeps its own state under the platform app-data dir. Existing
/// installs keep their data here: moving any of these strands it.
fn cognia_data_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("cognia")
}

fn agent_session_db(app_data_dir: &Path) -> PathBuf {
    cognia_data_dir(app_data_dir).join("agent-sessions.sqlite")
}

fn gateway_config_file(app_data_dir: &Path) -> PathBuf {
    cognia_data_dir(app_data_dir).join("gateway-config.json")
}

/// Whether a subscription commit for `provider` can change the gateway's
/// account snapshot. Registered API-key subscriptions (and the Opencode /
/// Command Code ones) also supply task-scoped gateway leases; an unrelated
/// OAuth refresh must not revoke unattended hosting.
fn leases_gateway_access(provider: &ProviderId) -> bool {
    matches!(
        provider,
        ProviderId::Opencode | ProviderId::Commandcode | ProviderId::Registered(_)
    )
}

/// Attach the gateway to the account security session, and invalidate the
/// gateway's account snapshot when a subscription that leases gateway access
/// commits.
pub(crate) fn gateway_session(app: &App) {
    let gateway_state = app.state::<crate::gateway::GatewayState>();
    app.state::<crate::account_auth::AccountSecuritySession>()
        .attach_gateway(gateway_state.inner().clone(), app.handle().clone());
    let gateway_for_vault = gateway_state.inner().clone();
    let app_for_vault = app.handle().clone();
    crate::subscription::vault::install_commit_observer(std::sync::Arc::new(
        move |local_account_id, provider| {
            if leases_gateway_access(&provider)
                && gateway_for_vault.invalidate_account_snapshot(local_account_id)
            {
                let _ = app_for_vault.emit("gateway://snapshot-invalidated", ());
            }
        },
    ));
}

/// Reachability is a host concern, not a renderer concern. Restore it even
/// for tray-only/autostart launches where no webview mounts.
pub(crate) fn companion_reachability(app: &App) {
    let reachability_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            crate::companion_api::commands::restore_reachability(reachability_handle).await
        {
            log::warn!("companion reachability restore failed: {error}");
        }
    });
}

/// Resolve one Node.js executable for every app-owned JavaScript child. A
/// missing system runtime is retained as an actionable error so the
/// lightweight shell can still open and guide repair.
pub(crate) fn node_runtime(app: &App) {
    crate::node_runtime::initialize(app.handle());
}

/// Workflow subsystem (ADR 0011) — construct the cron daemon + SQLite
/// run-state mirror once we have an AppHandle (needed for the trigger
/// emitter). Skip silently if the data dir resolution fails; web mode never
/// reaches this branch and `manage` falls back to a no-op state via the empty
/// in-memory mirror.
pub(crate) fn workflow(app: &App) {
    match dirs::data_dir() {
        Some(data_dir) => {
            let mirror_path = crate::workflow::default_mirror_path(&data_dir);
            let emitter = std::sync::Arc::new(crate::workflow::AppHandleEmitter {
                handle: app.handle().clone(),
            });
            match crate::workflow::WorkflowState::open(mirror_path, emitter.clone()) {
                Ok(state) => {
                    // Spawn the cron loop once. Cloning is cheap — the inner
                    // Arc is shared, so the daemon held by the managed state
                    // and the spawned loop drive the same schedule registry.
                    state.cron.clone().spawn();

                    // Spawn the webhook router on a tokio task so the axum
                    // listener is up by the time the renderer calls
                    // `workflow_get_webhook_url`. Port 0 lets the OS pick —
                    // the bound port flows back through the URL command.
                    // Errors (port collision, etc.) are logged but don't block
                    // app startup.
                    let webhook_clone = state.webhook.clone();
                    let webhook_emitter = emitter.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(err) = webhook_clone.start(webhook_emitter, 0).await {
                            log::warn!("workflow webhook router start failed: {err}");
                        }
                    });

                    app.manage(state);
                }
                Err(err) => {
                    log::warn!("workflow mirror open failed: {err}");
                }
            }
        }
        None => {
            log::warn!("dirs::data_dir() unavailable — workflow mirror not initialized");
        }
    }
}

/// App-scheduler alarm daemon (headless timing) — build + spawn it now that an
/// AppHandle exists for the `scheduler:task-due` emitter. The SchedulerState
/// was `.manage()`-d earlier (cheap, lazy); we only attach the daemon here.
/// Mirrors the workflow cron daemon so chat/agent/skill tasks fire while
/// minimized to the tray.
pub(crate) fn scheduler_alarm(app: &App) {
    let scheduler_state = app.state::<crate::scheduler::SchedulerState>();
    scheduler_state.install_alarm(std::sync::Arc::new(
        crate::scheduler::AppHandleTaskDueEmitter {
            handle: app.handle().clone(),
        },
    ));
}

/// A2UI bridge socket — listens for `a2ui_dispatch` lines emitted by
/// `sidecar/a2ui-mcp.mjs` (spawned by external agents like Claude Code CLI).
/// The path is exposed via the `COGNIA_BRIDGE_SOCKET` env var; adapters
/// propagate it through `McpServer.config.env` when projecting a2ui-bridge.
pub(crate) fn a2ui_bridge(app: &App) {
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        crate::a2ui_bridge::spawn(app).await;
    });
}

/// Background-job supervisor. Installed synchronously and BEFORE the sidecar
/// can serve its first `host_rpc`, because installation is also boot
/// reconcile: rows left `running` by a previous lifetime must become
/// `interrupted` before any spawn, or the concurrency caps count ghosts and
/// reject real work.
pub(crate) fn jobs_supervisor(app: &App) {
    if let Ok(dir) = app.path().app_data_dir() {
        match crate::jobs::install(cognia_data_dir(&dir)) {
            Ok(supervisor) => {
                let handle = app.handle().clone();
                supervisor.on_exit(std::sync::Arc::new(move |exit| {
                    let _ = handle.emit("jobs://exited", exit);
                }));
                if let Some(monitors) = crate::jobs::monitors() {
                    let handle = app.handle().clone();
                    monitors.on_fired(std::sync::Arc::new(move |monitor| {
                        let _ = handle.emit("jobs://monitor-fired", monitor);
                    }));
                }
            }
            Err(e) => log::warn!("background-job supervisor unavailable: {e}"),
        }
    }
}

/// Where the Claude Agent SDK session mirror lives (ADR-0090 Stage 4). Only
/// the PATH is set here: the database is opened on the first
/// `sessionStore.*` host_rpc, so a user who never runs an agent session never
/// gets the file. Same reason it sits beside the job supervisor — both must be
/// configured before the sidecar can serve its first host_rpc.
pub(crate) fn agent_session_store(app: &App) {
    if let Ok(dir) = app.path().app_data_dir() {
        crate::agent_session_store::configure_path(agent_session_db(&dir));
    }
}

/// Inbound LLM gateway auto-start (ADR-0043 M3). Mirrors the remote-control
/// gate: only starts when `enabled` is persisted true AND the keyring still
/// has a token (`GatewayState::new()` clears `enabled` when the token is
/// missing). Requests are served from the renderer-pushed routing snapshot, so
/// a window-closed boot serves nothing until the first push — that's
/// intentional (the SERVICE_UNAVAILABLE body tells the caller).
pub(crate) fn gateway_autostart(app: &App) {
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let gw_state = app.state::<crate::gateway::GatewayState>();
        // Load the persisted config (port / allowlist / timeouts / retry /
        // model exposure / bind interface / enabled) before the auto-start
        // check. A missing / corrupt file leaves the in-memory defaults
        // (gateway stays off).
        if let Ok(dir) = app.path().app_data_dir() {
            gw_state.hydrate_from_disk(gateway_config_file(&dir));
        }
        if gw_state.config().enabled {
            let host: std::sync::Arc<dyn crate::gateway::host::GatewayHost> =
                std::sync::Arc::new(crate::gateway::host::TauriGatewayHost(app.clone()));
            match gw_state.start(host).await {
                Ok(()) => log::info!("inbound gateway listener started"),
                Err(e) => log::warn!("inbound gateway auto-start skipped: {e}"),
            }
        }
    });
}

/// CLI bridge auto-start (plugin-author tooling). Binds an ephemeral loopback
/// port, writes the endpoint discovery file so `cognia plugin install` etc.
/// can find us. Best-effort — failure is logged and the rest of the app keeps
/// booting.
#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
pub(crate) fn cli_bridge(app: &App) {
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let bridge_state = app.state::<crate::cli_bridge::CliBridgeServerState>();
        match crate::cli_bridge::init(app.clone(), bridge_state.inner()).await {
            Ok(port) => log::info!("cli_bridge listening on 127.0.0.1:{port}"),
            Err(e) => log::warn!("cli_bridge auto-start failed: {e:#}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_gateway_leasing_subscriptions_invalidate_the_gateway_snapshot() {
        assert!(leases_gateway_access(&ProviderId::Opencode));
        assert!(leases_gateway_access(&ProviderId::Commandcode));
        assert!(leases_gateway_access(&ProviderId::Registered(
            "acme-api-key".into()
        )));
        assert!(!leases_gateway_access(&ProviderId::Anthropic));
        assert!(!leases_gateway_access(&ProviderId::Codex));
    }

    /// These are where existing installs keep their data.
    #[test]
    fn app_state_paths_stay_where_existing_installs_keep_them() {
        let app_data = Path::new("/data/com.cognia.app");
        assert_eq!(
            cognia_data_dir(app_data),
            PathBuf::from("/data/com.cognia.app/cognia")
        );
        assert_eq!(
            agent_session_db(app_data),
            PathBuf::from("/data/com.cognia.app/cognia/agent-sessions.sqlite")
        );
        assert_eq!(
            gateway_config_file(app_data),
            PathBuf::from("/data/com.cognia.app/cognia/gateway-config.json")
        );
    }
}
