//! Headless services registry (ADR-0059 W4).
//!
//! When `cognia-server` runs without a Tauri runtime, the process-wide
//! services the RPC dispatch arms need (sidecar state + host, API keys,
//! exec backend, brain supervisor, event bus, connectors) are collected
//! here instead of Tauri's `app.state::<T>()`.
//!
//! R5 lands the registry shell so [`DispatchHost::Headless`] compiles and
//! the dispatch seam can be cut in one mechanical commit; R7 populates the
//! fields and wires the `claude_*` arms, R10-R12 add exec + connectors.
//!
//! Storage is the same module-global idiom as `companion_api`'s
//! `TLS_FINGERPRINT` / `data_plane::HEADLESS_STORE`: a process-wide slot
//! with install/read accessors, so the many `CompanionState` constructors
//! don't have to thread it.
//!
//! [`DispatchHost::Headless`]: crate::companion_api::dispatch_host::DispatchHost

use std::sync::Arc;

use parking_lot::RwLock;

/// Service container for the headless (no-Tauri) host. Fields land in R7+;
/// the shell exists so the `DispatchHost` seam (R5) is cuttable on its own.
#[derive(Default)]
pub struct HeadlessServices {}

impl HeadlessServices {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
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
        install_headless_services(Some(HeadlessServices::new()));
        assert!(headless_services().is_some());
        install_headless_services(None);
        assert!(headless_services().is_none());
    }
}
