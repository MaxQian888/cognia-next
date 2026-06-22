//! Screen-off Computer Use — virtual display subsystem.
//!
//! Goal (Scenario A): keep Computer Use working when the physical monitor is
//! powered off / asleep but the Windows session stays UNLOCKED. Input
//! (`SendInput`) already works while unlocked; only *capture* breaks because
//! DXGI Desktop Duplication has no surface once the display sleeps or a
//! DisplayPort monitor drops HPD. The industry-standard fix (Parsec /
//! Sunshine / Anthropic-Xvfb) is a **virtual display** that always presents a
//! renderable surface. We bundle the MIT-licensed, Microsoft-signed
//! `parsec-vdd` driver and, while screen-off mode is active for a session,
//! create a virtual monitor, **make it primary** (so the existing
//! primary-display capture + `MOUSEEVENTF_ABSOLUTE` input both target it with
//! consistent coordinates), and restore the prior topology on exit.
//!
//! ```text
//!   plugin computer action ──► VirtualDisplayController.arm()
//!                                      │ (dedicated thread)
//!                                      ▼
//!     acquire: snapshot topology ─► add virtual display ─► set primary
//!                                      │
//!               100ms keep-alive ping ─┤ (recv_timeout loop)
//!                                      │
//!     release: remove display ─► restore topology   (idle 5m / kill / shutdown)
//! ```
//!
//! The state-machine (`controller.rs`) is fully cross-platform-testable
//! against an injectable [`VddDriver`]; the real Windows driver lives in
//! `driver_windows.rs` (built on the controller thread, so it may hold the
//! `!Send` device `HANDLE`). `parsec_vdd.rs` and `topology.rs` carry the
//! `cfg(windows)` Win32 FFI with non-Windows stubs so everything compiles and
//! the controller logic is exercised everywhere.

pub mod controller;
pub mod parsec_vdd;
pub mod topology;

#[cfg(target_os = "windows")]
pub mod driver_windows;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub use controller::VirtualDisplayController;

/// Stable backend id surfaced to the renderer's health badge.
pub const BACKEND_ID: &str = "windows-parsec-vdd";

/// Diagnostic snapshot reported by `virtual_display_health_probe`. Mirrors the
/// sandbox `SandboxHealth` shape so the Settings card can reuse the same badge
/// vocabulary (ok / setup-required / down).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VirtualDisplayHealth {
    /// True when the bundled driver is installed and the platform supports the
    /// screen-off path (Windows only). When false the renderer shows
    /// "Setup required" and the screen-off path denies strictly.
    pub available: bool,
    /// Whether the driver package is installed (marker present). Distinct from
    /// `available` so non-Windows can report `installed:false, available:false`
    /// without implying a failed Windows install.
    pub installed: bool,
    /// Stable backend id; the renderer switches copy on this.
    pub backend: String,
    /// Bundled driver / app version marker. Empty when nothing to surface.
    #[serde(default)]
    pub driver_version: String,
    /// Label of the virtual monitor while one is active (else empty).
    #[serde(default)]
    pub active_monitor: String,
    /// Last error observed (UAC denied, device open failure). Empty when fine.
    #[serde(default)]
    pub last_error: String,
}

/// Why the virtual display was torn down — recorded in the audit `reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseReason {
    /// No screen-off action for the idle window (default 5 min).
    Idle,
    /// Trust dropped via the automation kill switch.
    KillSwitch,
    /// The owning chat session closed.
    SessionClosed,
    /// App teardown.
    Shutdown,
    /// The virtual display driver stopped responding while active.
    DriverLost,
    /// Explicit manual release (e.g. the settings probe finished).
    Manual,
}

impl ReleaseReason {
    /// Human-readable audit reason string.
    pub fn as_reason(&self) -> &'static str {
        match self {
            ReleaseReason::Idle => "idle timeout",
            ReleaseReason::KillSwitch => "kill switch",
            ReleaseReason::SessionClosed => "session closed",
            ReleaseReason::Shutdown => "shutdown",
            ReleaseReason::DriverLost => "driver lost",
            ReleaseReason::Manual => "manual",
        }
    }
}

/// Failure modes for driver operations.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum VddError {
    /// Platform unsupported or the bundled driver is not installed. Strict
    /// mode surfaces this to the model verbatim instead of a black screenshot.
    #[error("virtual display unavailable: {0}")]
    Unavailable(String),
    /// The driver is installed but a device/IOCTL operation failed.
    #[error("virtual display driver error: {0}")]
    Driver(String),
    /// Display-topology snapshot / set-primary / restore failed.
    #[error("display topology error: {0}")]
    Topology(String),
}

/// The virtual monitor handed back by [`VddDriver::acquire`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquiredDisplay {
    /// Device label of the virtual monitor (e.g. `\\.\DISPLAY3`).
    pub label: String,
    pub width: u32,
    pub height: u32,
}

/// Result of [`VirtualDisplayController::arm`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArmOutcome {
    /// A virtual display was just created and made primary.
    Acquired { monitor: String },
    /// Already active — the idle timer was re-armed.
    AlreadyActive,
    /// Strict mode: the driver is unavailable; no display created.
    Unavailable(String),
}

/// The lifecycle a [`VirtualDisplayController`] drives. Stateful and
/// thread-affine (a real impl holds the `!Send` device `HANDLE` and asserts
/// the thread-local `ES_SYSTEM_REQUIRED`), so it is built *on* the controller
/// thread via a `Send` builder closure — `VddDriver` itself is NOT `Send`.
pub trait VddDriver {
    /// Snapshot the display topology, create the virtual monitor, set it
    /// primary, and assert system-sleep keepalive. Returns the new monitor.
    fn acquire(&mut self) -> Result<AcquiredDisplay, VddError>;
    /// Keep-alive ping — parsec-vdd unplugs the display ~1 s after the last
    /// ping, so the controller calls this every ~100 ms while acquired.
    fn ping(&mut self) -> Result<(), VddError>;
    /// Remove the virtual display, restore the prior topology, clear the
    /// keepalive. Best-effort and infallible (logs internally).
    fn release(&mut self, reason: ReleaseReason);
    /// Whether a virtual display is currently acquired.
    fn is_acquired(&self) -> bool;
}

/// Driver used off-Windows or when the bundled driver is not installed. Every
/// `acquire` fails with [`VddError::Unavailable`] so strict mode engages.
pub struct NoopDriver {
    reason: String,
}

impl NoopDriver {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl VddDriver for NoopDriver {
    fn acquire(&mut self) -> Result<AcquiredDisplay, VddError> {
        Err(VddError::Unavailable(self.reason.clone()))
    }
    fn ping(&mut self) -> Result<(), VddError> {
        Err(VddError::Unavailable(self.reason.clone()))
    }
    fn release(&mut self, _reason: ReleaseReason) {}
    fn is_acquired(&self) -> bool {
        false
    }
}

/// Path of the marker the VDD installer writes on success — the cheap
/// "driver installed" probe (mirrors the sandbox `setup.ok` pattern).
pub fn marker_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("cognia").join("display").join("vdd-setup.ok"))
}

/// Cheap, read-only health probe for the Settings card. No device open — just
/// platform + marker presence, safe to poll on an interval.
pub fn probe_health() -> VirtualDisplayHealth {
    #[cfg(target_os = "windows")]
    {
        let installed = marker_path().map(|p| p.exists()).unwrap_or(false);
        VirtualDisplayHealth {
            available: installed,
            installed,
            backend: BACKEND_ID.into(),
            driver_version: env!("CARGO_PKG_VERSION").into(),
            active_monitor: String::new(),
            last_error: if installed {
                String::new()
            } else {
                "Virtual display driver not installed. Settings → Automation → \
                 Screen-off → Set up to trigger the UAC prompt."
                    .into()
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        VirtualDisplayHealth {
            available: false,
            installed: false,
            backend: BACKEND_ID.into(),
            driver_version: String::new(),
            active_monitor: String::new(),
            last_error: "Screen-off mode is Windows-only.".into(),
        }
    }
}

/// Build the platform-appropriate driver. Runs *on* the controller thread, so
/// the returned `Box<dyn VddDriver>` may hold `!Send` OS handles. Falls back
/// to [`NoopDriver`] (strict mode) when unsupported / not installed.
pub fn build_driver() -> Box<dyn VddDriver> {
    #[cfg(target_os = "windows")]
    {
        if marker_path().map(|p| p.exists()).unwrap_or(false) {
            Box::new(driver_windows::WindowsVddDriver::new())
        } else {
            Box::new(NoopDriver::new(
                "Virtual display driver not installed — run setup first.",
            ))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Box::new(NoopDriver::new("Screen-off mode is Windows-only."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_reason_strings_are_stable() {
        assert_eq!(ReleaseReason::Idle.as_reason(), "idle timeout");
        assert_eq!(ReleaseReason::KillSwitch.as_reason(), "kill switch");
        assert_eq!(ReleaseReason::SessionClosed.as_reason(), "session closed");
        assert_eq!(ReleaseReason::Shutdown.as_reason(), "shutdown");
        assert_eq!(ReleaseReason::DriverLost.as_reason(), "driver lost");
        assert_eq!(ReleaseReason::Manual.as_reason(), "manual");
    }

    #[test]
    fn noop_driver_is_always_unavailable() {
        let mut d = NoopDriver::new("nope");
        assert!(matches!(d.acquire(), Err(VddError::Unavailable(_))));
        assert!(matches!(d.ping(), Err(VddError::Unavailable(_))));
        assert!(!d.is_acquired());
        d.release(ReleaseReason::Manual); // must not panic
    }

    #[test]
    fn health_serializes_camel_case() {
        let h = VirtualDisplayHealth {
            available: true,
            installed: true,
            backend: BACKEND_ID.into(),
            driver_version: "0.1.0".into(),
            active_monitor: "\\\\.\\DISPLAY3".into(),
            last_error: String::new(),
        };
        let v = serde_json::to_value(&h).unwrap();
        assert_eq!(v["available"], true);
        assert_eq!(v["activeMonitor"], "\\\\.\\DISPLAY3");
        assert_eq!(v["driverVersion"], "0.1.0");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn probe_health_is_unavailable_off_windows() {
        let h = probe_health();
        assert!(!h.available);
        assert!(!h.installed);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn build_driver_off_windows_is_noop() {
        let mut d = build_driver();
        assert!(matches!(d.acquire(), Err(VddError::Unavailable(_))));
    }
}
