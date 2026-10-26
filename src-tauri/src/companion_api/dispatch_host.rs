//! `DispatchHost` — the host abstraction behind the RPC dispatch table
//! (ADR-0059 W4, slice R5).
//!
//! `rpc::dispatch` historically took a raw `tauri::AppHandle`, which made the
//! whole companion RPC surface unreachable without a WebView (the Phase-D
//! `cognia-server` 503'd every command). This enum splits the host:
//!
//! - [`DispatchHost::Tauri`] — the desktop app. Arms reach Tauri-managed
//!   state via `host.tauri_app(name)?.state::<T>()`, byte-identical to the
//!   old flow.
//! - [`DispatchHost::Headless`] — the `cognia-server` binary. Arms that only
//!   need the data plane (`DataPlane::pick`, `resolve_bridge_transport`)
//!   work as-is; arms that genuinely need the desktop reply with a per-arm
//!   `503 headless_unsupported` via [`DispatchHost::tauri_app`].
//!
//! # Headless availability
//!
//! | Family | Headless | Via |
//! | --- | --- | --- |
//! | `sync_pull`, `message_*`, `session_list` | ✅ | connected brain (`ws_bridge`) or degraded store |
//! | desktop-write group (`character_*`, `workflow_*`, …) | ✅ | connected brain |
//! | `claude_*` (send/interrupt/…, provider env) | ✅ | `HeadlessServices` sidecar |
//! | `spawn/send/kill/status_external_agent` | ✅ | `ExecBackend` behind service scope |
//! | `connectors_*` | ✅ | `HeadlessServices.connectors` |
//! | `mcp_server_status` | ✅ | process-owned `McpServerState` |
//! | `git_*`, workspace-confined `fs_*`, `skills_*`, agent-config, backup | ✅ | host-neutral command bodies / data plane |
//! | live terminal registry and `plugin_*` | ✅ | process-owned registries |
//! | automation consent / remote notifications | ✅ | shared broker + authenticated `EventBus` |
//! | Server OCR | ✅ | lazy `NativeOcrRegistry`; progress through `EventBus` |
//! | Remote Browser | dynamic | `browser_runtime_status` live workspace probe |

use std::sync::Arc;

use axum::{http::StatusCode, Json};

use super::rpc::RpcError;
use super::SharedState;
use crate::headless::HeadlessServices;
pub use cognia_companion_rpc::rpc_host::{HostAutomation, OcrProgressEmitter, RpcHost};

/// The process hosting this RPC dispatch: the desktop Tauri app, or the
/// headless `cognia-server` service registry.
///
/// Both arms answer [`RpcHost`]: the desktop arm here, the headless arm by
/// delegating to the registry's own implementation in `cognia-companion-rpc`,
/// so a family that moved into that crate sees the same host either way.
#[derive(Clone)]
pub enum DispatchHost {
    Tauri(tauri::AppHandle),
    Headless(Arc<HeadlessServices>),
}

impl DispatchHost {
    /// Resolve the host for the current process: the Tauri `AppHandle` when
    /// the WebView shell is up, else the headless services registry installed
    /// by `cognia-server` at boot. `None` in bare unit-test states — the
    /// caller maps that to the historical test-mode 503.
    pub fn from_state(state: &SharedState) -> Option<Self> {
        if let Some(app) = super::host::tauri_app(&state.renderer) {
            return Some(Self::Tauri(app.clone()));
        }
        crate::headless::headless_services().map(Self::Headless)
    }

    /// The Tauri `AppHandle`, or a per-arm `503 headless_unsupported` error
    /// naming the command — used by every arm whose body still requires the
    /// desktop (see the availability table in the module docs).
    pub fn tauri_app(&self, name: &str) -> Result<&tauri::AppHandle, (StatusCode, Json<RpcError>)> {
        match self {
            Self::Tauri(app) => Ok(app),
            Self::Headless(_) => Err(RpcError::headless_unsupported(name)),
        }
    }
}

#[async_trait::async_trait]
impl RpcHost for DispatchHost {
    fn kind(&self) -> &'static str {
        match self {
            Self::Tauri(_) => "tauri",
            Self::Headless(services) => RpcHost::kind(services),
        }
    }

    fn to_shared(&self) -> Arc<dyn RpcHost> {
        Arc::new(self.clone())
    }

    fn data_dir(&self) -> Result<std::path::PathBuf, String> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.path()
                    .app_data_dir()
                    .map_err(|error| format!("resolve host app data directory: {error}"))
            }
            Self::Headless(services) => RpcHost::data_dir(services),
        }
    }

    fn headless(&self) -> Option<&Arc<HeadlessServices>> {
        match self {
            Self::Tauri(_) => None,
            Self::Headless(services) => Some(services),
        }
    }

    fn resource_dir(&self) -> Option<std::path::PathBuf> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager as _;
                app.path().resource_dir().ok()
            }
            Self::Headless(services) => RpcHost::resource_dir(services),
        }
    }

    /// The agent-drive verbs were classified `target: "client"`, so a desktop
    /// that had taken over a remote host sent every one of them to its own
    /// machine, where no instance for that root exists. Routing them makes
    /// "which machine owns this workbench" the dispatcher's question rather
    /// than the caller's. On the desktop `authorize_workspace_root` has already
    /// canonicalized the root against the active project and the instance map
    /// is not device-scoped, so there is nothing left to check.
    async fn ide_canonical_root(&self, root: &str, device_id: &str) -> Result<String, String> {
        match self {
            Self::Tauri(_) => Ok(root.to_string()),
            Self::Headless(services) => {
                RpcHost::ide_canonical_root(services, root, device_id).await
            }
        }
    }

    /// The four lifecycle verbs were headless-only, which made a paired
    /// phone's `codeserver_ensure` answer `503 headless_host_required` on a
    /// desktop-hosted companion server.
    ///
    /// Both hosts hand a paired device the `/ide/relay/{id}` front door. On
    /// the desktop the workbench runs with `--auth none` and full terminals
    /// for its owner, so relaying it off the machine needs the owner's
    /// approval for this device and this project: without one, the desktop is
    /// asked ([`crate::codeserver::relay_grants::CODESERVER_RELAY_GRANT_EVENT`])
    /// and the caller is told to wait (`CODESERVER_RELAY_GRANT_REQUIRED`).
    async fn ide_ensure(
        &self,
        root: &str,
        profile: crate::codeserver::profile::IdeProfile,
        device_id: &str,
        via_relay: bool,
    ) -> Result<crate::codeserver::remote::RemoteCodeServerStatus, String> {
        match self {
            Self::Tauri(app) => {
                use tauri::{Emitter, Manager};
                let state = app.state::<crate::codeserver::CodeServerState>();
                if via_relay && !state.relay_granted(device_id, root) {
                    let ask = state.request_relay_grant(device_id, root)?;
                    if let Err(error) = app.emit(
                        crate::codeserver::relay_grants::CODESERVER_RELAY_GRANT_EVENT,
                        &ask,
                    ) {
                        log::warn!("emit Pro IDE relay approval request: {error}");
                    }
                    return Err(crate::codeserver::error_code::coded(
                        crate::codeserver::error_code::CodeServerErrorCode::RelayGrantRequired,
                        "approve this device for this project on the host computer",
                    ));
                }
                state.ensure_profile(app, root, profile).await?;
                let relay_path = if via_relay {
                    Some(crate::codeserver::relay_table::relay_path(
                        &state.admit_relay(root, device_id).await?,
                    ))
                } else {
                    None
                };
                Ok(crate::codeserver::remote::desktop_running_status(
                    profile, root, relay_path,
                ))
            }
            Self::Headless(services) => {
                RpcHost::ide_ensure(services, root, profile, device_id, via_relay).await
            }
        }
    }

    /// The desktop map is not device-scoped — `authorize_workspace_root` has
    /// already bound the root to the active project — so `device_id` is only
    /// consulted on the headless side.
    async fn ide_status(
        &self,
        root: &str,
        device_id: &str,
    ) -> Result<crate::codeserver::remote::RemoteCodeServerStatus, String> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                let (running, _port, profile) = app
                    .state::<crate::codeserver::CodeServerState>()
                    .status(root)
                    .await;
                // The tuple's port is deliberately dropped here. Disclosure is
                // the arm's decision, made against `ExecutionPlane`, not this
                // seam's — same rule the headless side encodes by keeping
                // `loopback_port` a separate question from `status`.
                let state = app.state::<crate::codeserver::CodeServerState>();
                Ok(match (running, profile) {
                    (true, Some(profile)) => {
                        // Only a device the owner approved, and that `ensure`
                        // admitted, learns the way in.
                        let relay_path = state
                            .relay_id_for(root, device_id)
                            .await
                            .map(|id| crate::codeserver::relay_table::relay_path(&id));
                        crate::codeserver::remote::desktop_running_status(profile, root, relay_path)
                    }
                    _ => crate::codeserver::remote::stopped_status(),
                })
            }
            Self::Headless(services) => RpcHost::ide_status(services, root, device_id).await,
        }
    }

    async fn ide_stop(&self, root: &str) -> bool {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::codeserver::CodeServerState>()
                    .stop(root)
                    .await
            }
            Self::Headless(services) => RpcHost::ide_stop(services, root).await,
        }
    }

    async fn ide_stop_all(&self) {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::codeserver::CodeServerState>()
                    .stop_all()
                    .await
            }
            Self::Headless(services) => RpcHost::ide_stop_all(services).await,
        }
    }

    /// On the desktop the port comes from the local instance map, which the
    /// desktop's own renderer already reads through `codeserver_status`.
    async fn ide_loopback_port(&self, root: &str, device_id: &str) -> Option<u16> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                let (_running, port, _profile) = app
                    .state::<crate::codeserver::CodeServerState>()
                    .status(root)
                    .await;
                port
            }
            Self::Headless(services) => RpcHost::ide_loopback_port(services, root, device_id).await,
        }
    }

    /// Unlike the verbs above this one needs the running instance's binary and
    /// data directories, which only the owning state holds, so it stays a
    /// per-host branch.
    async fn ide_open_file(
        &self,
        root: &str,
        device_id: &str,
        path: &str,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<(), String> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::codeserver::CodeServerState>()
                    .open_file(root, path, line, column)
                    .await
            }
            Self::Headless(services) => {
                RpcHost::ide_open_file(services, root, device_id, path, line, column).await
            }
        }
    }

    async fn ide_read_user_settings(
        &self,
        profile: crate::codeserver::profile::IdeProfile,
    ) -> Result<String, String> {
        match self {
            Self::Tauri(app) => {
                let app = app.clone();
                tokio::task::spawn_blocking(move || {
                    let path =
                        crate::codeserver::process::user_settings_path_for_profile(&app, profile)?;
                    crate::codeserver::commands::read_text_or_empty(&path)
                })
                .await
                .map_err(|error| format!("read code-server settings task: {error}"))?
            }
            Self::Headless(services) => RpcHost::ide_read_user_settings(services, profile).await,
        }
    }

    async fn ide_write_user_settings(
        &self,
        contents: String,
        profile: crate::codeserver::profile::IdeProfile,
    ) -> Result<(), String> {
        match self {
            Self::Tauri(app) => {
                let app = app.clone();
                tokio::task::spawn_blocking(move || {
                    let path =
                        crate::codeserver::process::user_settings_path_for_profile(&app, profile)?;
                    crate::codeserver::commands::atomic_write_text(&path, &contents)
                })
                .await
                .map_err(|error| format!("write code-server settings task: {error}"))?
            }
            Self::Headless(services) => {
                RpcHost::ide_write_user_settings(services, contents, profile).await
            }
        }
    }

    async fn ide_read_runtime_args(
        &self,
        profile: crate::codeserver::profile::IdeProfile,
    ) -> Result<String, String> {
        match self {
            Self::Tauri(app) => {
                let app = app.clone();
                tokio::task::spawn_blocking(move || {
                    let path =
                        crate::codeserver::process::runtime_args_path_for_profile(&app, profile)?;
                    crate::codeserver::commands::read_text_or_empty(&path)
                })
                .await
                .map_err(|error| format!("read code-server runtime args task: {error}"))?
            }
            Self::Headless(services) => RpcHost::ide_read_runtime_args(services, profile).await,
        }
    }

    async fn ide_write_runtime_args(
        &self,
        contents: String,
        profile: crate::codeserver::profile::IdeProfile,
    ) -> Result<(), String> {
        match self {
            Self::Tauri(app) => {
                let app = app.clone();
                tokio::task::spawn_blocking(move || {
                    let path =
                        crate::codeserver::process::runtime_args_path_for_profile(&app, profile)?;
                    crate::codeserver::commands::atomic_write_text(&path, &contents)
                })
                .await
                .map_err(|error| format!("write code-server runtime args task: {error}"))?
            }
            Self::Headless(services) => {
                RpcHost::ide_write_runtime_args(services, contents, profile).await
            }
        }
    }

    /// Panics if the desktop app never managed `SidecarState` — identical to
    /// the old `app.state::<T>()` behavior.
    fn sidecar_state(&self) -> crate::claude::SidecarState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::claude::SidecarState>().inner().clone()
            }
            Self::Headless(services) => RpcHost::sidecar_state(services),
        }
    }

    fn api_keys(&self) -> crate::api_key::ApiKeyState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::api_key::ApiKeyState>().inner().clone()
            }
            Self::Headless(services) => RpcHost::api_keys(services),
        }
    }

    fn mcp_server_status(&self) -> crate::mcp_server::types::McpServerStatus {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::mcp_server::McpServerState>().status()
            }
            Self::Headless(services) => RpcHost::mcp_server_status(services),
        }
    }

    fn sidecar_host(&self) -> Arc<dyn crate::claude::host::SidecarHost> {
        match self {
            Self::Tauri(app) => Arc::new(crate::claude::host::TauriSidecarHost(app.clone())),
            Self::Headless(services) => RpcHost::sidecar_host(services),
        }
    }

    // ── External-agent execution plane ──────────────────────────────────────
    //
    // `spawn/send/kill/get_status_external_agent` are `target=execution` over
    // http/websocket/webrtc, so a paired phone addresses them on EITHER host.
    // They used to be implemented against `host.headless()` alone, which meant
    // a phone paired to a DESKTOP got a 503 whose message said the command
    // "requires the desktop app" — the exact opposite of the truth, and the
    // reason remote agent control worked only against a cloud deployment.
    //
    // The desktop already owns an `ExecBackend` (`ExternalAgentState::backend`,
    // whose own doc comment claims "one code path with the headless RPC arms"),
    // so the fix is an accessor, not a second implementation.

    fn exec_backend(&self) -> Arc<dyn crate::external_agent::exec_backend::ExecBackend> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::external_agent::commands::ExternalAgentState>()
                    .exec()
            }
            Self::Headless(services) => RpcHost::exec_backend(services),
        }
    }

    /// The Tauri event channels the desktop UI already listens on, or the
    /// companion EventBus a remote client reads through `/ws/events`.
    fn agent_event_emitter(
        &self,
    ) -> Arc<dyn crate::external_agent::exec_backend::AgentEventEmitter> {
        match self {
            Self::Tauri(app) => {
                Arc::new(crate::external_agent::commands::TauriAgentEmitter { app: app.clone() })
            }
            Self::Headless(services) => RpcHost::agent_event_emitter(services),
        }
    }

    /// Deliberately the strict `SpawnPolicy` on both hosts, never the desktop's
    /// laxer `validate_desktop`: that relaxation exists because a local Tauri
    /// `invoke` implies a human sitting at the machine, which is exactly the
    /// premise a network-reachable arm does not get to assume. Remote spawn is
    /// RCE-grade on a desktop for the same reason it is in the cloud.
    fn remote_spawn_policy(&self) -> Result<crate::external_agent::presets::SpawnPolicy, String> {
        match self {
            Self::Tauri(app) => {
                let data_root = crate::external_agent::dsh_runtime::host_data_root(app)?;
                Ok(crate::external_agent::presets::SpawnPolicy::from_env(
                    &data_root,
                ))
            }
            Self::Headless(services) => RpcHost::remote_spawn_policy(services),
        }
    }

    /// The desktop wraps children in its sandbox host (the local Tauri command
    /// does the same); the headless container relies on the `ExecBackend` it
    /// was configured with, see its own implementation.
    ///
    /// # The two confinements are mutually exclusive
    ///
    /// A spawn that carries a runtime-environment placement (ADR-0182) runs
    /// inside the project's own container, and the desktop sandbox host
    /// rewrites `command` and `args` to its own launcher. Doing both would
    /// hand the container a command the agent bundle has no entry for, so the
    /// sandbox driver would refuse `sandbox_command_unavailable` — a spawn
    /// that looks like a bundle problem and is really a double-wrap. The
    /// container is the stronger confinement of the two, so it wins and the
    /// desktop wrapper stands down — but only when this desktop's sandbox
    /// router (ADR-0221) will place it. With no router the placement falls
    /// back to this host, so it is wrapped like any other spawn; with one,
    /// the router wraps a fallback itself.
    ///
    /// `COGNIA_AGENT_STATE_KEY` (ADR-0216) names a private state root on THIS
    /// host, which the desktop wrapper resolves.
    fn harden_spawn_config(
        &self,
        config: crate::external_agent::process::ExternalAgentSpawnConfig,
        backend: &dyn crate::external_agent::exec_backend::ExecBackend,
    ) -> Result<crate::external_agent::process::ExternalAgentSpawnConfig, String> {
        match self {
            Self::Tauri(_) => crate::external_agent::sandbox::harden_desktop_spawn(
                config,
                backend.routes_sandboxes(),
            ),
            Self::Headless(services) => RpcHost::harden_spawn_config(services, config, backend),
        }
    }

    // ── Plugin runtimes ─────────────────────────────────────────────────────
    //
    // Both hosts own these outright — the desktop `.manage()`s the very same
    // state types at boot (`lib.rs`), and the underlying helpers are already
    // written as `*_for_state(state, …)`. The arms were nonetheless reachable
    // only on headless, so a paired phone could grant a plugin permission or
    // invoke a plugin API against a cloud host and not against the desktop it
    // was actually paired to.
    //
    // Plain reference accessors: Tauri's `State::inner()` hands back `&'r T`
    // whose lifetime comes from the manager borrow rather than from the
    // temporary `State` value, so both arms can yield a reference tied to
    // `&self`. Returning an owned `Arc` is not an option — `PluginRuntimeState`
    // is not `Clone`, and a clone would be a different registry even if it
    // were.

    fn plugin_runtime(&self) -> &crate::plugin_api::PluginRuntimeState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::plugin_api::PluginRuntimeState>().inner()
            }
            Self::Headless(services) => RpcHost::plugin_runtime(services),
        }
    }

    fn vscode_plugins(&self) -> &crate::plugin_api::vscode::VscodeExtensionState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::plugin_api::vscode::VscodeExtensionState>()
                    .inner()
            }
            Self::Headless(services) => RpcHost::vscode_plugins(services),
        }
    }

    /// Host-neutral because the lease is the arbiter between EVERY runtime
    /// attached to this companion — the desktop's own webview and any brain
    /// process pointed at it — and an arm that only exists on one host cannot
    /// arbitrate between two.
    fn connectors_state(&self) -> &crate::connectors::ConnectorsState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::connectors::ConnectorsState>().inner()
            }
            Self::Headless(services) => RpcHost::connectors_state(services),
        }
    }

    /// The headless registry installs its compiled backends lazily on first
    /// use; the desktop's is built at startup.
    async fn ocr_registry(&self) -> crate::ocr::NativeOcrRegistry {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::ocr::NativeOcrRegistry>().inner().clone()
            }
            Self::Headless(services) => RpcHost::ocr_registry(services).await,
        }
    }

    /// The desktop emits on the Tauri event channel its UI listens to. Same
    /// topic name on both hosts, so a paired device sees model-download
    /// progress either way.
    fn ocr_progress_emitter(&self) -> OcrProgressEmitter {
        match self {
            Self::Tauri(app) => {
                use tauri::Emitter as _;
                let app = app.clone();
                std::sync::Arc::new(move |event| {
                    let _ = app.emit("ocr://download-progress", event);
                })
            }
            Self::Headless(services) => RpcHost::ocr_progress_emitter(services),
        }
    }

    /// The desktop `emit`s and lets `event_channels`'s forwarder relay the
    /// frame onto the bus for paired devices. Emitting AND publishing on the
    /// desktop would deliver the frame twice to every remote subscriber,
    /// which is why this is a match and not a helper that does both.
    fn publish_host_event(&self, topic: &str, payload: serde_json::Value) {
        match self {
            Self::Tauri(app) => {
                use tauri::Emitter as _;
                let _ = app.emit(topic, payload);
            }
            Self::Headless(services) => RpcHost::publish_host_event(services, topic, payload),
        }
    }

    fn cognia_data_dir(&self) -> Result<std::path::PathBuf, String> {
        match self {
            Self::Tauri(_) => Ok(self.data_dir()?.join("cognia")),
            Self::Headless(services) => RpcHost::cognia_data_dir(services),
        }
    }

    fn workflow_state(&self) -> Option<&crate::workflow::WorkflowState> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.try_state::<crate::workflow::WorkflowState>()
                    .map(|state| state.inner())
            }
            Self::Headless(services) => RpcHost::workflow_state(services),
        }
    }

    fn mcp_server(&self) -> &crate::mcp_server::McpServerState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::mcp_server::McpServerState>().inner()
            }
            Self::Headless(services) => RpcHost::mcp_server(services),
        }
    }

    /// The sidecar bundled in the app resources, else the `~/.cognia`
    /// user-install convention: the same resolver the settings snippet reads,
    /// so the path spawned and the path the user is told to paste agree.
    fn mcp_sidecar_path(&self) -> Option<std::path::PathBuf> {
        match self {
            Self::Tauri(app) => crate::mcp_server::commands::resolve_sidecar_path(app),
            Self::Headless(services) => RpcHost::mcp_sidecar_path(services),
        }
    }

    fn mcp_orchestration_sink(
        &self,
    ) -> crate::mcp_server::orchestration_proxy::OrchestrationEventSink {
        match self {
            Self::Tauri(app) => {
                crate::mcp_server::orchestration_proxy::tauri_event_sink(app.clone())
            }
            Self::Headless(services) => RpcHost::mcp_orchestration_sink(services),
        }
    }

    fn automation(&self) -> Option<HostAutomation<'_>> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                Some(HostAutomation {
                    state: app
                        .state::<crate::automation::commands::AutomationState>()
                        .inner(),
                    events: Arc::new(app.clone()),
                })
            }
            Self::Headless(services) => RpcHost::automation(services),
        }
    }

    fn mcp_automation_binding(&self) -> Option<crate::mcp_server::AutomationBinding> {
        self.automation().map(|automation| {
            (
                automation.state.handle.clone(),
                crate::automation::dispatcher::Enforcement::from_state(automation.state),
            )
        })
    }

    fn companion_server(&self) -> Option<&super::CompanionServerState> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.try_state::<super::CompanionServerState>()
                    .map(|state| state.inner())
            }
            Self::Headless(services) => RpcHost::companion_server(services),
        }
    }

    fn app_version(&self) -> String {
        match self {
            Self::Tauri(app) => app.package_info().version.to_string(),
            Self::Headless(services) => RpcHost::app_version(services),
        }
    }

    fn gateway(&self) -> Option<&crate::gateway::GatewayState> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.try_state::<crate::gateway::GatewayState>()
                    .map(|state| state.inner())
            }
            Self::Headless(services) => RpcHost::gateway(services),
        }
    }

    fn gateway_event_host(
        &self,
        event_bus: Arc<super::event_bus::EventBus>,
    ) -> Arc<dyn crate::gateway::host::GatewayHost> {
        match self {
            Self::Tauri(app) => Arc::new(crate::gateway::host::TauriGatewayHost(app.clone())),
            Self::Headless(services) => RpcHost::gateway_event_host(services, event_bus),
        }
    }

    fn pi_sidecar_dir(&self) -> Option<std::path::PathBuf> {
        match self {
            Self::Tauri(app) => crate::claude::sidecar::sidecar_dir(app).ok(),
            Self::Headless(services) => RpcHost::pi_sidecar_dir(services),
        }
    }

    fn codex_app_host(&self) -> Option<Box<dyn crate::codex_app_dispatch::CodexAppHost + '_>> {
        match self {
            Self::Tauri(app) => Some(Box::new(crate::codex_app_dispatch::TauriCodexAppHost(app))),
            Self::Headless(services) => RpcHost::codex_app_host(services),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headless_host() -> DispatchHost {
        DispatchHost::Headless(HeadlessServices::stub_for_tests())
    }

    #[test]
    fn tauri_app_on_headless_is_a_503_naming_the_command() {
        let host = headless_host();
        let err = host
            .tauri_app("claude_send")
            .expect_err("headless has no AppHandle");
        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.1 .0.code, "headless_unsupported");
        assert!(err.1 .0.message.contains("claude_send"));
    }

    fn spawn_config(placed: bool) -> crate::external_agent::process::ExternalAgentSpawnConfig {
        use cognia_external_agent::sandbox_routing_backend::SandboxPlacement;
        crate::external_agent::process::ExternalAgentSpawnConfig {
            id: "agent-1".into(),
            command: "codex".into(),
            args: vec!["acp".into()],
            cwd: None,
            env: Default::default(),
            framing: Default::default(),
            sandbox_policy: Default::default(),
            sandbox: placed.then(|| SandboxPlacement::Container {
                binding: None,
                hosted_tool_host_lease_ids: Vec::new(),
                provider: None,
                workspace: None,
                spec: serde_json::json!({ "projectId": "prj1" }),
                isolation_mandatory: false,
            }),
        }
    }

    /// ADR-0182. The desktop sandbox host rewrites `command`/`args` to its own
    /// launcher, which the agent bundle has no entry for — so wrapping a
    /// placed spawn would refuse `sandbox_command_unavailable` and look like a
    /// bundle problem. The container is the stronger confinement and wins
    /// where a router will place it (ADR-0221); with no router the placement
    /// runs on this host and is wrapped.
    #[test]
    fn the_desktop_wrapper_stands_down_for_a_spawn_that_runs_in_a_container() {
        use crate::external_agent::sandbox::desktop_wrapper_applies;
        assert!(!desktop_wrapper_applies(&spawn_config(true), true));
        assert!(desktop_wrapper_applies(&spawn_config(true), false));
        assert!(desktop_wrapper_applies(&spawn_config(false), true));
    }

    #[test]
    fn a_headless_host_drops_a_state_key_it_cannot_honour() {
        let host = headless_host();
        let mut config = spawn_config(true);
        config.env.insert(
            cognia_external_agent::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "cfg".into(),
        );
        let hardened = host
            .harden_spawn_config(config, host.exec_backend().as_ref())
            .expect("nothing to wrap");
        assert!(!hardened
            .env
            .contains_key(cognia_external_agent::state_isolation::AGENT_STATE_KEY_ENV));
    }

    /// The headless host confines through its `ExecBackend`, so a placed spawn
    /// reaches it byte for byte — including the placement the router reads.
    #[test]
    fn a_headless_host_hardens_a_placed_spawn_by_leaving_it_alone() {
        let host = headless_host();
        let config = spawn_config(true);
        let hardened = host
            .harden_spawn_config(config.clone(), host.exec_backend().as_ref())
            .expect("nothing to wrap");
        assert_eq!(hardened.command, config.command);
        assert_eq!(hardened.args, config.args);
        assert!(hardened.sandbox.is_some());
    }

    #[test]
    fn headless_accessor_and_kind() {
        let host = headless_host();
        assert!(host.headless().is_some());
        assert_eq!(host.kind(), "headless");
    }

    #[tokio::test]
    async fn headless_service_accessors_share_the_registry_instances() {
        let services = HeadlessServices::stub_for_tests();
        let host = DispatchHost::Headless(Arc::clone(&services));

        // api_keys is the same store the registry owns.
        host.api_keys().set(Some("sk-x".into())).await;
        assert_eq!(services.api_keys.get().await.as_deref(), Some("sk-x"));

        // sidecar_state shares the registry's supervisor (Arc-backed clone).
        assert!(!host.sidecar_state().is_ready().await);
        assert_eq!(host.sidecar_host().kind(), "headless");

        // Process services stay available without a Tauri AppHandle.
        assert!(!host.mcp_server_status().running);
    }

    /// The accessors behind the `target=execution` arms must hand back the very
    /// instance the host owns, not a copy. A copy compiles, passes a smoke
    /// test, and then silently spawns agents into a registry that `kill` and
    /// `status` cannot see.
    #[test]
    fn execution_accessors_yield_the_host_owned_instance() {
        let services = HeadlessServices::stub_for_tests();
        let host = DispatchHost::Headless(Arc::clone(&services));

        assert!(Arc::ptr_eq(&host.exec_backend(), &services.exec));
        assert!(std::ptr::eq(
            host.plugin_runtime(),
            services.plugin_runtime.as_ref()
        ));
        assert!(std::ptr::eq(
            host.vscode_plugins(),
            services.vscode_plugins.as_ref()
        ));
    }

    #[test]
    fn headless_remote_spawn_policy_is_the_registry_policy() {
        let host = headless_host();
        assert!(host.remote_spawn_policy().is_ok());
    }
}
