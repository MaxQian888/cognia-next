//! UI Automation subsystem.
//!
//! Architecture (see design at `docs/superpowers/specs/2026-05-12-ui-
//! automation-subsystem-design.md`):
//!
//! ```text
//!   Tauri commands ──► permission gate ──► worker thread ──► backend
//!                                                ▲
//!                                                └── audit ring
//! ```
//!
//! The worker thread owns the back-end so all calls reach a stable OS thread
//! (critical for Windows UIA, which initializes COM on `UIAutomation::new`).
//! Renderer-facing types live in `types.rs`; the trait the worker dispatches
//! against is in `backend.rs`.

pub mod audit;
pub mod backend;
pub mod commands;
pub mod consent;
pub mod cua_route;
pub mod dispatcher;
pub mod events;
pub mod input_monitor;
pub mod instruction_pack;
pub mod kill_switch;
pub mod locked_use;
pub mod permission;
pub mod persist;
pub mod platform;
pub mod policy;
pub mod record;
pub mod screenshot_dedup;
pub mod selection;
pub mod selection_events;
pub mod session;
pub mod tool_exec;
pub mod types;
pub mod virtual_display;
pub mod worker;

use parking_lot::Mutex;
use serde_json::json;
use tauri::{AppHandle, Emitter};

// Public re-exports — only the names lib.rs reaches for directly. Everything
// else stays accessible via its fully-qualified path (e.g.
// `automation::permission::AutomationSettings`) to keep this surface tight.
pub use audit::AuditRing;
pub use backend::AutomationBackend;
pub use consent::ConsentBroker;
pub use permission::PermissionGate;
pub use types::Platform;
pub use virtual_display::VirtualDisplayController;
pub use worker::Worker;

/// ADR-0020 W1 — when `make_default_backend_with_app` falls back to the
/// `StubBackend` because real-backend init failed, the failure reason is
/// stashed here so a Tauri command can flush it once the renderer is up
/// (the worker thread itself does not have an `AppHandle`). The Overview
/// tab calls `automation_drain_init_failure` on mount to render a
/// destructive `<Alert>` instead of silently presenting "Computer Use
/// available" while every call fails `UnsupportedPlatform`.
static INIT_FAILURE: parking_lot::Mutex<Option<InitFailure>> = Mutex::new(None);

/// Snapshot of a backend init failure — surfaced to the renderer via
/// `automation:backend-init-failed` events and the
/// `automation_drain_init_failure` Tauri command (whichever the renderer
/// observes first; both yield the same row).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitFailure {
    pub platform: Platform,
    pub error: String,
}

/// Pull (and clear) the most recent backend init failure, if any. The
/// renderer calls this on Overview tab mount so a failure that happened
/// before the renderer attached an event listener is still surfaced.
pub fn drain_init_failure() -> Option<InitFailure> {
    INIT_FAILURE.lock().take()
}

/// Best-effort: stash the failure for `drain_init_failure` AND emit
/// `automation:backend-init-failed` when an `AppHandle` is available.
/// Called from `make_default_backend_with_app`.
fn record_init_failure(app: Option<&AppHandle>, platform: Platform, error: String) {
    let failure = InitFailure {
        platform,
        error: error.clone(),
    };
    *INIT_FAILURE.lock() = Some(failure.clone());
    if let Some(handle) = app {
        let _ = handle.emit("automation:backend-init-failed", json!(failure));
    }
}

/// ADR-0020 W1 — build the platform-appropriate back-end with Tauri
/// `AppHandle` plumbed in so a backend-init failure can emit
/// `automation:backend-init-failed` AND stash the reason for the Overview
/// tab to drain on mount. Falls back to `StubBackend` on failure (today's
/// behaviour) but the operator is no longer in the dark.
///
/// Must be called *from* the automation worker thread — Windows COM
/// initialization is per-thread, and `UIAutomation::new()` initializes the
/// MTA apartment for whichever thread it lands on. `app` is `Option` so
/// the unit-test stub worker (which has no Tauri runtime) can still build
/// a backend without standing up an `AppHandle`.
pub fn make_default_backend_with_app(app: Option<AppHandle>) -> Box<dyn AutomationBackend> {
    #[cfg(target_os = "windows")]
    {
        match platform::uia::UiaBackend::new() {
            Ok(b) => Box::new(b),
            Err(err) => {
                let msg = err.to_string();
                log::warn!("uia backend init failed ({msg}); falling back to stub backend",);
                record_init_failure(app.as_ref(), Platform::Windows, msg);
                Box::new(backend::StubBackend {
                    platform: Platform::Unsupported,
                })
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        match platform::ax::AxBackend::new() {
            Ok(b) => Box::new(b),
            Err(err) => {
                let msg = err.to_string();
                log::warn!("ax backend init failed ({msg}); falling back to stub backend");
                record_init_failure(app.as_ref(), Platform::Macos, msg);
                Box::new(backend::StubBackend {
                    platform: Platform::Macos,
                })
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        match platform::atspi::AtspiBackend::new() {
            Ok(b) => Box::new(b),
            Err(err) => {
                let msg = format!("{err}");
                log::warn!("atspi backend init failed ({msg}); falling back to stub backend");
                record_init_failure(app.as_ref(), Platform::Linux, msg);
                Box::new(backend::StubBackend {
                    platform: Platform::Linux,
                })
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = app;
        Box::new(backend::StubBackend {
            platform: Platform::Unsupported,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex as StdMutex, MutexGuard, OnceLock};

    static INIT_FAILURE_TEST_LOCK: OnceLock<StdMutex<()>> = OnceLock::new();

    fn init_failure_test_guard() -> MutexGuard<'static, ()> {
        INIT_FAILURE_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .expect("init failure test lock poisoned")
    }

    #[test]
    fn drain_init_failure_clears_after_read() {
        let _guard = init_failure_test_guard();
        // Stash a synthetic failure (we can't reproduce a real one
        // without standing up a Windows COM environment), then prove the
        // first `drain` returns it and the second returns `None`. The
        // important invariant is that the renderer only sees the failure
        // once even if multiple tabs mount and call drain.
        *INIT_FAILURE.lock() = Some(InitFailure {
            platform: Platform::Windows,
            error: "synthetic init failure for test".into(),
        });
        let first = drain_init_failure();
        assert!(first.is_some());
        assert_eq!(first.as_ref().unwrap().platform, Platform::Windows);
        let second = drain_init_failure();
        assert!(second.is_none());
    }

    #[test]
    fn record_init_failure_without_app_handle_still_stashes() {
        let _guard = init_failure_test_guard();
        *INIT_FAILURE.lock() = None;
        record_init_failure(None, Platform::Linux, "no xdotool".into());
        let drained = drain_init_failure();
        assert!(drained.is_some());
        assert_eq!(drained.unwrap().platform, Platform::Linux);
    }
}
