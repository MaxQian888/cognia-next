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

use std::sync::Arc;

use parking_lot::RwLock;

use crate::api_key::ApiKeyState;
use crate::claude::host::SidecarHost;
use crate::claude::SidecarState;
use crate::companion_api::event_bus::EventBus;

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

    #[test]
    fn install_and_clear_round_trip() {
        // NOTE: process-global — this test is the only one that installs into
        // the slot (dispatch tests construct `DispatchHost::Headless`
        // directly), so no cross-test lock is needed yet.
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
