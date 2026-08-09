//! Host surfaces the WASM runtime can reach, behind a trait so the crate
//! stays host-neutral.
//!
//! v0.1 shipped `clipboard`, `ai`, `notification`, and `workflow` as stubs for
//! one structural reason: [`HostState`](super::store::HostState) carried no
//! handle to anything outside the sandbox. This module is that handle.
//!
//! # Why every accessor returns `Option`
//!
//! `None` means "this host build cannot serve that ONE surface", and the caller
//! answers `HOST_UNAVAILABLE` for that surface alone. A headless
//! `cognia-server` has no clipboard but does have a workflow runtime; a desktop
//! build with the renderer still starting has a clipboard but no bridge. Making
//! the granularity structural is what turns "HOST_UNAVAILABLE without disabling
//! unrelated capabilities" into something the compiler helps enforce, rather
//! than a convention every new capability has to remember.
//!
//! # Why a trait rather than an `AppHandle`
//!
//! `cognia-plugin-runtime` is deliberately host-neutral: every Tauri command in
//! `wasm/commands.rs` has a `*_for_state` twin reached from the headless
//! companion RPC. Putting `tauri::AppHandle` on `HostState` would make that
//! coupling structural and leave the headless path with nothing that compiles.
//!
//! A process-global `OnceLock` installer (the `vscode::commands` precedent)
//! would have avoided touching `HostState` at all, but cargo runs unit tests as
//! parallel threads in one process — a global would make "desktop serves
//! clipboard" and "headless returns HOST_UNAVAILABLE" mutually unrunnable in
//! the same test binary. The per-store field lets each test inject its own
//! [`test_support::RecordingWasmHostServices`].

use std::sync::Arc;

use super::bridge::WasmRendererBridge;
use super::capabilities::notification::PendingNotification;
use super::errors::WasmErrorCode;

pub mod tauri;
pub mod test_support;

/// A failure from a backing host surface, carrying the code the guest sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostServiceError {
    pub code: WasmErrorCode,
    pub message: String,
}

impl HostServiceError {
    pub fn new(code: WasmErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The backing surface exists but failed.
    pub fn provider(message: impl Into<String>) -> Self {
        Self::new(WasmErrorCode::ProviderError, message)
    }

    /// Render as the `"<CODE>: <message>"` wire string.
    pub fn to_wire(&self) -> String {
        super::errors::coded(self.code, &self.message)
    }
}

pub trait ClipboardService: Send + Sync {
    fn read_text(&self) -> Result<String, HostServiceError>;
    fn write_text(&self, value: &str) -> Result<(), HostServiceError>;
}

pub trait NotificationService: Send + Sync {
    fn notify(&self, pending: &PendingNotification) -> Result<(), HostServiceError>;
}

/// The set of host surfaces one WASM plugin instance may reach.
pub trait WasmHostServices: Send + Sync + 'static {
    fn clipboard(&self) -> Option<&dyn ClipboardService> {
        None
    }
    fn notifications(&self) -> Option<&dyn NotificationService> {
        None
    }
    fn renderer_bridge(&self) -> Option<Arc<WasmRendererBridge>> {
        None
    }
    /// `"tauri"` | `"recording"`. Diagnostics only — never user data.
    fn kind(&self) -> &'static str;
}

/// Resolve a service handle or produce the canonical `HOST_UNAVAILABLE` error.
///
/// Centralised so every surface phrases the "no backend here" case identically,
/// and so the message names the surface rather than the host build (an author
/// debugging this needs to know *what* is missing, not which binary they are on).
pub fn host_unavailable(surface: &str) -> String {
    super::errors::coded(
        WasmErrorCode::HostUnavailable,
        format!("{surface} is not available in this host build"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Bare;
    impl WasmHostServices for Bare {
        fn kind(&self) -> &'static str {
            "bare"
        }
    }

    #[test]
    fn default_accessors_report_no_backend() {
        let bare = Bare;
        assert!(bare.clipboard().is_none());
        assert!(bare.notifications().is_none());
        assert!(bare.renderer_bridge().is_none());
        assert_eq!(bare.kind(), "bare");
    }

    #[test]
    fn host_unavailable_names_the_surface_and_carries_the_code() {
        let msg = host_unavailable("clipboard");
        assert!(msg.starts_with("HOST_UNAVAILABLE: "));
        assert!(msg.contains("clipboard"));
    }

    #[test]
    fn host_service_error_renders_its_code() {
        let err = HostServiceError::provider("clipboard is empty");
        assert_eq!(err.code, WasmErrorCode::ProviderError);
        assert_eq!(err.to_wire(), "PROVIDER_ERROR: clipboard is empty");
    }
}
