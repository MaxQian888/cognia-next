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

/// The process hosting this RPC dispatch: the desktop Tauri app, or the
/// headless `cognia-server` service registry.
#[derive(Clone)]
pub enum DispatchHost {
    Tauri(tauri::AppHandle),
    Headless(Arc<HeadlessServices>),
}

impl DispatchHost {
    /// Resolve the data directory owned by the execution host.
    pub fn data_dir(&self) -> Result<std::path::PathBuf, String> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.path()
                    .app_data_dir()
                    .map_err(|error| format!("resolve host app data directory: {error}"))
            }
            Self::Headless(services) => Ok(services.data_dir.clone()),
        }
    }

    /// Resolve the host for the current process: the Tauri `AppHandle` when
    /// the WebView shell is up, else the headless services registry installed
    /// by `cognia-server` at boot. `None` in bare unit-test states — the
    /// caller maps that to the historical test-mode 503.
    pub fn from_state(state: &SharedState) -> Option<Self> {
        if let Some(app) = state.app_handle.clone() {
            return Some(Self::Tauri(app));
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

    /// The headless services registry, when this host is headless.
    #[allow(dead_code)] // consumed by later slices (R10/R12).
    pub fn headless(&self) -> Option<&Arc<HeadlessServices>> {
        match self {
            Self::Tauri(_) => None,
            Self::Headless(services) => Some(services),
        }
    }

    /// The sidecar supervisor state for this host (Tauri-managed on desktop,
    /// registry-owned headless). Panics if the desktop app never managed
    /// `SidecarState` — identical to the old `app.state::<T>()` behavior.
    pub fn sidecar_state(&self) -> crate::claude::SidecarState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::claude::SidecarState>().inner().clone()
            }
            Self::Headless(services) => services.sidecar.clone(),
        }
    }

    /// The provider-env store for this host.
    pub fn api_keys(&self) -> crate::api_key::ApiKeyState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::api_key::ApiKeyState>().inner().clone()
            }
            Self::Headless(services) => services.api_keys.clone(),
        }
    }

    /// Snapshot the embedded MCP server status from the process that owns it.
    pub fn mcp_server_status(&self) -> crate::mcp_server::types::McpServerStatus {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::mcp_server::McpServerState>().status()
            }
            Self::Headless(services) => services.mcp_server.status(),
        }
    }

    /// Snapshot durable host-owned terminal sessions visible to the caller.
    pub async fn terminal_list_all(
        &self,
        device_id: &str,
    ) -> Result<Vec<cognia_terminal::host::HostSessionInfo>, String> {
        #[cfg(test)]
        if let Self::Headless(services) = self {
            return Ok(services.terminal_sessions_for_tests.read().await.clone());
        }
        let app = match self {
            Self::Tauri(app) => Some(app),
            Self::Headless(_) => None,
        };
        crate::terminal_host_bridge::terminal_host_remote_list(app, device_id).await
    }

    pub async fn terminal_list_for_project(
        &self,
        device_id: &str,
        project_id: &str,
    ) -> Result<Vec<cognia_terminal::host::HostSessionInfo>, String> {
        Ok(self
            .terminal_list_all(device_id)
            .await?
            .into_iter()
            .filter(|session| session.project_id.as_deref() == Some(project_id))
            .collect())
    }

    /// Terminate a durable host-owned terminal after taking its controller
    /// lease on behalf of the authenticated device.
    pub async fn terminal_kill(&self, device_id: &str, session_id: &str) -> Result<(), String> {
        let app = match self {
            Self::Tauri(app) => Some(app),
            Self::Headless(_) => None,
        };
        crate::terminal_host_bridge::terminal_host_remote_kill(app, device_id, session_id).await
    }

    /// The terminal host's own settings, as the file on disk has them.
    ///
    /// Host-neutral: they live next to the terminal host, not in Tauri state,
    /// so the desktop and a headless `cognia-server` answer identically.
    pub async fn terminal_host_status(
        &self,
    ) -> Result<crate::terminal_host_bridge::TerminalHostStatus, String> {
        crate::terminal_host_bridge::terminal_host_remote_status().await
    }

    /// Apply terminal-host settings on behalf of an authenticated administrator.
    pub async fn terminal_host_configure(
        &self,
        settings: crate::terminal_host_service::TerminalHostSettings,
    ) -> Result<crate::terminal_host_bridge::TerminalHostStatus, String> {
        let app = match self {
            Self::Tauri(app) => Some(app),
            Self::Headless(_) => None,
        };
        crate::terminal_host_bridge::terminal_host_remote_configure(app, settings).await
    }

    /// Install a paired device's terminal profiles on the host.
    pub async fn terminal_host_sync_profiles(
        &self,
        device_id: &str,
        profiles: Vec<serde_json::Value>,
    ) -> Result<usize, String> {
        let app = match self {
            Self::Tauri(app) => Some(app),
            Self::Headless(_) => None,
        };
        crate::terminal_host_bridge::terminal_host_remote_sync_profiles(app, device_id, profiles)
            .await
    }

    /// The sidecar host seam for this host — what `sidecar::spawn` needs.
    pub fn sidecar_host(&self) -> Arc<dyn crate::claude::host::SidecarHost> {
        match self {
            Self::Tauri(app) => Arc::new(crate::claude::host::TauriSidecarHost(app.clone())),
            Self::Headless(services) => Arc::clone(&services.sidecar_host),
        }
    }

    /// `"tauri"` | `"headless"` — for logs and error strings.
    #[allow(dead_code)]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Tauri(_) => "tauri",
            Self::Headless(_) => "headless",
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

    /// The process/exec backend that owns external agents on this host.
    pub fn exec_backend(&self) -> Arc<dyn crate::external_agent::exec_backend::ExecBackend> {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::external_agent::commands::ExternalAgentState>()
                    .backend()
            }
            Self::Headless(services) => Arc::clone(&services.exec),
        }
    }

    /// Where agent lifecycle events are published for this host: the Tauri
    /// event channels the desktop UI already listens on, or the companion
    /// EventBus a remote client reads through `/ws/events`.
    pub fn agent_event_emitter(
        &self,
    ) -> Arc<dyn crate::external_agent::exec_backend::AgentEventEmitter> {
        match self {
            Self::Tauri(app) => {
                Arc::new(crate::external_agent::commands::TauriAgentEmitter { app: app.clone() })
            }
            Self::Headless(services) => {
                Arc::new(super::rpc::BusAgentEmitter(Arc::clone(&services.event_bus)))
            }
        }
    }

    /// The spawn policy this host applies to a REMOTE spawn request.
    ///
    /// Deliberately the strict `SpawnPolicy` on both hosts, never the desktop's
    /// laxer `validate_desktop`: that relaxation exists because a local Tauri
    /// `invoke` implies a human sitting at the machine, which is exactly the
    /// premise a network-reachable arm does not get to assume. Remote spawn is
    /// RCE-grade on a desktop for the same reason it is in the cloud.
    pub fn remote_spawn_policy(
        &self,
    ) -> Result<crate::external_agent::presets::SpawnPolicy, String> {
        match self {
            Self::Tauri(app) => {
                let data_root = crate::external_agent::dsh_runtime::host_data_root(app)?;
                Ok(crate::external_agent::presets::SpawnPolicy::from_env(
                    &data_root,
                ))
            }
            Self::Headless(services) => Ok(services.spawn_policy.clone()),
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

    // Plain reference accessors, not combinators: Tauri's `State::inner()`
    // hands back `&'r T` whose lifetime comes from the manager borrow rather
    // than from the temporary `State` value, so both arms can yield a
    // reference tied to `&self`. (The generic-future combinator this replaced
    // could not express "the returned future borrows the argument" and failed
    // to compile.) Returning an owned `Arc` is not an option either —
    // `PluginRuntimeState` is not `Clone`, and a clone would be a different
    // registry even if it were.

    /// Native plugin install/permission/snapshot service this host owns.
    pub fn plugin_runtime(&self) -> &crate::plugin_api::PluginRuntimeState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::plugin_api::PluginRuntimeState>().inner()
            }
            Self::Headless(services) => services.plugin_runtime.as_ref(),
        }
    }

    /// VS Code extension sidecar registry — what the system LSP host arms need.
    pub fn vscode_plugins(&self) -> &crate::plugin_api::vscode::VscodeExtensionState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::plugin_api::vscode::VscodeExtensionState>()
                    .inner()
            }
            Self::Headless(services) => services.vscode_plugins.as_ref(),
        }
    }

    /// Connector adapter registry + the single-owner runtime lease.
    ///
    /// Both hosts own one: the desktop as Tauri managed state, the headless
    /// container inside `HeadlessServices`. Host-neutral because the lease is
    /// the arbiter between EVERY runtime attached to this companion — the
    /// desktop's own webview and any brain process pointed at it — and an arm
    /// that only exists on one host cannot arbitrate between two.
    pub fn connectors_state(&self) -> &crate::connectors::ConnectorsState {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::connectors::ConnectorsState>().inner()
            }
            Self::Headless(services) => &services.connectors,
        }
    }

    /// Native OCR backend registry this host owns.
    ///
    /// Async because the headless registry installs its compiled backends
    /// lazily on first use; the desktop's is built at startup. Returns an
    /// owned clone — `NativeOcrRegistry` is `Clone` and the desktop's Tauri
    /// `State` borrow cannot outlive the call.
    pub async fn ocr_registry(&self) -> crate::ocr::NativeOcrRegistry {
        match self {
            Self::Tauri(app) => {
                use tauri::Manager;
                app.state::<crate::ocr::NativeOcrRegistry>().inner().clone()
            }
            Self::Headless(services) => services.ocr_registry().await.clone(),
        }
    }

    /// Where `ocr://download-progress` is published.
    ///
    /// The desktop emits on the Tauri event channel its UI listens to; the
    /// headless host publishes to the companion `EventBus`, which a remote
    /// client reads through `/ws/events`. Same topic name either way, so a
    /// paired device sees model-download progress on both hosts.
    pub fn ocr_progress_emitter(
        &self,
    ) -> std::sync::Arc<dyn Fn(crate::ocr::DownloadProgressEvent) + Send + Sync> {
        match self {
            Self::Tauri(app) => {
                use tauri::Emitter as _;
                let app = app.clone();
                std::sync::Arc::new(move |event| {
                    let _ = app.emit("ocr://download-progress", event);
                })
            }
            Self::Headless(services) => {
                let bus = std::sync::Arc::clone(&services.event_bus);
                std::sync::Arc::new(move |event| {
                    // A progress frame that will not serialize is dropped, not
                    // fatal — the download itself is unaffected.
                    if let Ok(payload) = serde_json::to_value(event) {
                        bus.publish("ocr://download-progress".to_string(), payload);
                    }
                })
            }
        }
    }

    /// Publish a host-originated event on `topic`, whichever host this is.
    ///
    /// The desktop `emit`s and lets `event_channels`'s forwarder relay the
    /// frame onto the bus for paired devices; a headless host has no Tauri
    /// runtime, so it publishes straight to the bus. Emitting AND publishing on
    /// the desktop would deliver the frame twice to every remote subscriber,
    /// which is why this is a match and not a helper that does both.
    ///
    /// The topic must be catalogued in `event_channels::EVENT_CHANNELS`, or it
    /// reaches the desktop renderer and no remote client at all.
    pub fn publish_host_event(&self, topic: &str, payload: serde_json::Value) {
        match self {
            Self::Tauri(app) => {
                use tauri::Emitter as _;
                let _ = app.emit(topic, payload);
            }
            Self::Headless(services) => {
                services.event_bus.publish(topic.to_string(), payload);
            }
        }
    }

    /// Apply this host's OS confinement to an already policy-validated spawn.
    ///
    /// The desktop wraps children in its sandbox host (the local Tauri command
    /// does the same); the headless container relies on the `ExecBackend` it
    /// was configured with (local / bollard / kube) for isolation, so there is
    /// nothing to wrap.
    pub fn harden_spawn_config(
        &self,
        config: crate::external_agent::process::ExternalAgentSpawnConfig,
    ) -> Result<crate::external_agent::process::ExternalAgentSpawnConfig, String> {
        match self {
            Self::Tauri(_) => crate::external_agent::sandbox::wrap_with_sandbox(
                config,
                &crate::external_agent::sandbox::DesktopSandboxHost,
            )
            .map_err(|error| error.to_string()),
            Self::Headless(_) => Ok(config),
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
