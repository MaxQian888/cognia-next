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
//! # Headless availability (Phase 1)
//!
//! | Family | Headless | Via |
//! | --- | --- | --- |
//! | `sync_pull`, `message_*`, `session_list` | ✅ | connected brain (`ws_bridge`) or degraded store |
//! | desktop-write group (`character_*`, `workflow_*`, …) | ✅ | connected brain |
//! | `claude_*` (send/interrupt/…, provider env) | R7 | `HeadlessServices` sidecar |
//! | `spawn/send/kill/status_external_agent` | R11 | `ExecBackend` behind service scope |
//! | `connectors_*` | R12 | `HeadlessServices.connectors` |
//! | `git_*`, `fs_*`, `terminal_*`, `plugin_*`, `skills_*`, mcp, agent-config, backup, automation consent | ❌ Phase 1 | `headless_unsupported` (documented follow-up) |

use std::sync::Arc;

use axum::{http::StatusCode, Json};

use super::rpc::RpcError;
use super::SharedState;
use crate::headless::HeadlessServices;

/// The process hosting this RPC dispatch: the desktop Tauri app, or the
/// headless `cognia-server` service registry.
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
        let err = host.tauri_app("claude_send").expect_err("headless has no AppHandle");
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
    }
}
