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
pub mod permission;
pub mod platform;
pub mod types;
pub mod worker;

// Public re-exports — only the names lib.rs reaches for directly. Everything
// else stays accessible via its fully-qualified path (e.g.
// `automation::permission::AutomationSettings`) to keep this surface tight.
pub use audit::AuditRing;
pub use backend::AutomationBackend;
pub use permission::PermissionGate;
pub use types::Platform;
pub use worker::Worker;

/// Builds the platform-appropriate back-end. On Windows this is the real
/// UIA-backed implementation; on macOS/Linux it's the M1 stub.
///
/// Must be called *from* the automation worker thread — Windows COM
/// initialization is per-thread, and `UIAutomation::new()` initializes the
/// MTA apartment for whichever thread it lands on.
pub fn make_default_backend() -> Box<dyn AutomationBackend> {
    #[cfg(target_os = "windows")]
    {
        match platform::uia::UiaBackend::new() {
            Ok(b) => Box::new(b),
            Err(err) => {
                log::warn!(
                    "uia backend init failed ({err}); falling back to stub backend",
                );
                Box::new(backend::StubBackend {
                    platform: Platform::Unsupported,
                })
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(backend::StubBackend {
            platform: Platform::Macos,
        })
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(backend::StubBackend {
            platform: Platform::Linux,
        })
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )))]
    {
        Box::new(backend::StubBackend {
            platform: Platform::Unsupported,
        })
    }
}
