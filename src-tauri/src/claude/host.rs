//! `SidecarHost` — the host abstraction behind the Claude sidecar supervisor
//! (ADR-0059 W4, slice R6).
//!
//! `sidecar::spawn` historically took a raw `tauri::AppHandle`, coupling the
//! supervisor to the WebView shell through resource resolution, provider-env
//! injection (`app.try_state::<ApiKeyState>`), and event emission
//! (`app.emit`). This trait collapses those host-specific seams:
//!
//! - [`TauriSidecarHost`] — the desktop app, using bundled scripts and Node.
//! - [`HeadlessSidecarHost`] — the `cognia-server` binary. The script comes
//!   from `COGNIA_SIDECAR_SCRIPT`; events publish into the companion
//!   [`EventBus`], riding `/ws/v1/events` to every connected client with the
//!   **unchanged** channel names and payloads.
//!
//! # Permission forwarding is load-bearing
//!
//! `handle_permission_request` forwards un-blocked `permission_request`
//! events through [`SidecarHost::emit`]. On the desktop that reaches the
//! approval store via the WebView listener; headless it MUST reach the
//! EventBus (and thus the phone / brain over `/ws/v1/events`) — otherwise
//! every gated tool call deadlocks waiting for an approval nobody saw.

use std::path::PathBuf;
#[cfg(test)]
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio::process::Command;

use crate::api_key::ApiKeyState;

pub use cognia_companion_rpc::sidecar_runtime::SidecarHost;
#[cfg(test)]
pub use cognia_companion_rpc::sidecar_runtime::HeadlessSidecarHost;
use cognia_companion_rpc::sidecar_runtime::{inject_provider_env, inject_runtime_env, report_sidecar_failure, dispatch_runtime_rpc};

// ---------------------------------------------------------------------------
// Desktop host
// ---------------------------------------------------------------------------

/// Desktop host: resource-dir script + Node runtime, Tauri-managed
/// [`ApiKeyState`], and events via `AppHandle::emit`.
pub struct TauriSidecarHost(pub tauri::AppHandle);

#[async_trait]
impl SidecarHost for TauriSidecarHost {
    fn resolve_script(&self) -> Result<PathBuf, String> {
        super::sidecar::resolve_sidecar_script(&self.0)
    }

    fn resolve_node_executable(&self) -> Result<PathBuf, String> {
        cognia_core::node_runtime::node_executable().map_err(|error| error.to_string())
    }

    fn emit(&self, channel: &str, payload: &Value) {
        use tauri::Emitter;
        use tauri::Manager;
        if let Err(e) = self.0.emit(channel, payload) {
            log::error!("failed to emit {channel}: {e}");
        }
        if channel == super::sidecar::AGENT_EVENT {
            if let Some(state) = self
                .0
                .try_state::<crate::cli_bridge::CliBridgeServerState>()
            {
                if let Some(envelope) = crate::cli_bridge::canonical_agent_envelope(payload) {
                    state.agent_events().publish(envelope);
                }
            }
            if let Some(state) = self
                .0
                .try_state::<crate::companion_api::CompanionServerState>()
            {
                if let Some(event_bus) = state.event_bus.read().clone() {
                    event_bus.publish(channel.to_string(), payload.clone());
                }
            }
        }
    }

    async fn inject_env(&self, cmd: &mut Command) {
        use tauri::Manager;
        if let Some(api_key_state) = self.0.try_state::<ApiKeyState>() {
            inject_provider_env(&api_key_state, cmd).await;
        }
        inject_runtime_env(cmd).await;
    }

    fn is_disabled(&self) -> bool {
        crate::recovery::is_subsystem_disabled(
            cognia_observability::recovery::RecoverySubsystem::Sidecar,
        )
    }

    fn report_failure(&self) {
        report_sidecar_failure();
    }

    async fn dispatch_host_rpc(&self, method: &str, params: &Value) -> Result<Value, String> {
        dispatch_runtime_rpc(method, params).await
    }

    fn kind(&self) -> &'static str {
        "tauri"
    }
}

// ---------------------------------------------------------------------------
// Headless host
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use parking_lot::Mutex;

    /// Records emissions; used by sidecar/commands tests that need a host
    /// without a WebView or an EventBus.
    #[derive(Default)]
    pub struct RecordingSidecarHost {
        pub emitted: Mutex<Vec<(String, Value)>>,
        pub script: Option<PathBuf>,
        pub node_executable: Option<PathBuf>,
    }

    impl RecordingSidecarHost {
        #[cfg(not(unix))]
        pub fn with_script(script: PathBuf) -> Arc<Self> {
            Arc::new(Self {
                emitted: Mutex::new(Vec::new()),
                script: Some(script),
                node_executable: None,
            })
        }

        pub fn with_script_and_node(script: PathBuf, node_executable: PathBuf) -> Arc<Self> {
            Arc::new(Self {
                emitted: Mutex::new(Vec::new()),
                script: Some(script),
                node_executable: Some(node_executable),
            })
        }

        pub fn events(&self) -> Vec<(String, Value)> {
            self.emitted.lock().clone()
        }
    }

    #[async_trait]
    impl SidecarHost for RecordingSidecarHost {
        fn resolve_script(&self) -> Result<PathBuf, String> {
            self.script
                .clone()
                .ok_or_else(|| "recording host has no script".to_string())
        }

        fn resolve_node_executable(&self) -> Result<PathBuf, String> {
            Ok(self
                .node_executable
                .clone()
                .unwrap_or_else(|| PathBuf::from("node")))
        }

        fn emit(&self, channel: &str, payload: &Value) {
            self.emitted
                .lock()
                .push((channel.to_string(), payload.clone()));
        }

        async fn inject_env(&self, _cmd: &mut Command) {}

        fn is_disabled(&self) -> bool {
            false
        }
        fn report_failure(&self) {}
        async fn dispatch_host_rpc(&self, method: &str, params: &Value) -> Result<Value, String> {
            dispatch_runtime_rpc(method, params).await
        }
        fn kind(&self) -> &'static str {
            "recording"
        }
    }
}


#[cfg(test)]
mod tests {
    #[test]
    fn the_desktop_adapter_forwards_canonical_agent_events() {
        let source = include_str!("host.rs").split("#[cfg(test)]").next().unwrap();
        assert!(source.contains("crate::cli_bridge::canonical_agent_envelope(payload)"));
        assert!(source.contains("event_bus.publish(channel.to_string(), payload.clone())"));
    }
}
