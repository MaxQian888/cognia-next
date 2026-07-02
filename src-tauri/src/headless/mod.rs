//! Headless services registry (ADR-0059 W4).
//!
//! When `cognia-server` runs without a Tauri runtime, the process-wide
//! services the RPC dispatch arms need are collected here instead of Tauri's
//! `app.state::<T>()`:
//!
//! - R7 (this slice): the sidecar supervisor (`SidecarState` +
//!   `HeadlessSidecarHost`) and the provider-env store (`ApiKeyState`) — the
//!   `claude_*` dispatch arms work headless.
//! - R8: the brain supervisor. R10: the exec backend. R12: connectors.
//!
//! Storage is the same module-global idiom as `companion_api`'s
//! `TLS_FINGERPRINT` / `data_plane::HEADLESS_STORE`: a process-wide slot
//! with install/read accessors, so the many `CompanionState` constructors
//! don't have to thread it.

pub mod brain;

use std::sync::Arc;

use parking_lot::RwLock;

use crate::claude::SidecarState;
use crate::companion_api::event_bus::EventBus;

// Re-exports for the `cognia-server` binary (the `api_key` / `claude` /
// `secret_store` modules are crate-private; this module is the headless
// boot surface). The `pub use` also brings the names into scope here.
pub use crate::api_key::ApiKeyState;
pub use crate::claude::host::{HeadlessSidecarHost, SidecarHost, SIDECAR_SCRIPT_ENV};
pub use crate::claude::sidecar::kill_sidecar;
pub use crate::secret_store::{
    generate_master_key, init_headless as init_secret_store, parse_master_key,
    resolve_master_key_from_env, rotate_master_key, MASTER_KEY_ENV, MASTER_KEY_FILE_ENV,
};

/// Service container for the headless (no-Tauri) host. The `cognia-server`
/// binary constructs one at boot (R8) and installs it process-wide; the
/// dispatch arms reach it through `DispatchHost::Headless`.
pub struct HeadlessServices {
    /// Sidecar supervisor state — same struct Tauri manages on desktop.
    pub sidecar: SidecarState,
    /// The sidecar's host seam (script resolution, env injection, event
    /// emission into the EventBus).
    pub sidecar_host: Arc<dyn SidecarHost>,
    /// Provider-env store fed by the `claude_set_*` RPC arms.
    pub api_keys: ApiKeyState,
    /// The companion event bus — every host-emitted event rides
    /// `/ws/v1/events` from here.
    pub event_bus: Arc<EventBus>,
    /// Execution plane for external agents (ADR-0059 R10). Local processes
    /// in Phase 1; `ExecBackend::Container` swaps in at T2 (R13).
    pub exec: Arc<dyn crate::external_agent::exec_backend::ExecBackend>,
}

impl HeadlessServices {
    pub fn new(
        sidecar_host: Arc<dyn SidecarHost>,
        api_keys: ApiKeyState,
        event_bus: Arc<EventBus>,
    ) -> Arc<Self> {
        Arc::new(Self {
            sidecar: SidecarState::new(),
            sidecar_host,
            api_keys,
            event_bus,
            exec: crate::external_agent::exec_backend::LocalProcessBackend::new(),
        })
    }

    /// A registry with a never-resolving sidecar script — for dispatch tests
    /// that need a headless host but never actually spawn the sidecar.
    #[cfg(test)]
    pub fn stub_for_tests() -> Arc<Self> {
        use crate::claude::host::HeadlessSidecarHost;
        let event_bus = EventBus::new();
        let api_keys = ApiKeyState::new();
        let sidecar_host = Arc::new(HeadlessSidecarHost::new(
            std::path::PathBuf::from("cognia-headless-test-missing.mjs"),
            Arc::clone(&event_bus),
            api_keys.clone(),
        ));
        Self::new(sidecar_host, api_keys, event_bus)
    }
}

static SERVICES: RwLock<Option<Arc<HeadlessServices>>> = RwLock::new(None);

/// Install (or clear with `None`) the process-wide headless services.
/// Called by the `cognia-server` binary at boot (R8), before the axum
/// server spawns. Idempotent.
pub fn install_headless_services(services: Option<Arc<HeadlessServices>>) {
    *SERVICES.write() = services;
}

/// The installed headless services, if any. `None` on desktop and in
/// unit-test states.
pub fn headless_services() -> Option<Arc<HeadlessServices>> {
    SERVICES.read().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn install_and_clear_round_trip() {
        // Process-global slot — serialize with the other global-slot tests
        // (healthz's headless-shape test installs here too).
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        install_headless_services(Some(HeadlessServices::stub_for_tests()));
        assert!(headless_services().is_some());
        install_headless_services(None);
        assert!(headless_services().is_none());
    }

    #[tokio::test]
    async fn stub_registry_exposes_working_api_keys_and_bus() {
        let services = HeadlessServices::stub_for_tests();
        services.api_keys.set(Some("sk-headless".into())).await;
        assert_eq!(
            services.api_keys.get().await.as_deref(),
            Some("sk-headless")
        );
        assert!(!services.sidecar.is_ready().await);
        // The sidecar host publishes into the same bus the registry exposes.
        services
            .sidecar_host
            .emit("claude://message", &serde_json::json!({ "type": "x" }));
        // (Publish is fire-and-forget; the frame lands in the bus's ring.)
        let now_ms = 0;
        match services.event_bus.subscribe(Some(0), now_ms) {
            crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => {
                assert_eq!(replay.len(), 1);
                assert_eq!(replay[0].event_type, "claude://message");
            }
            _ => panic!("subscribe failed"),
        }
    }
}
