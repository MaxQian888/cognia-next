//! Screen-recording permission probe.
//!
//! # The failure this exists to prevent
//!
//! On macOS 10.15+ screen capture is TCC-gated, and a process without the
//! grant does **not** get an error. `CGDisplayCreateImage` and everything built
//! on it — including `xcap` — succeed and return a picture of the desktop
//! *with every window's contents omitted*: wallpaper, and on some systems the
//! menu bar. Feed that to OCR and it produces confident, well-formed text that
//! has nothing to do with what the user selected. That text would then be
//! offered as "your selection", sent to a model, or written into long-term
//! memory.
//!
//! There is no way to detect this after the fact — a wallpaper with words on it
//! is a perfectly valid image. The only correct move is to ask first and skip
//! the capture entirely when the answer is no.
//!
//! # Why it never prompts
//!
//! `CGRequestScreenCaptureAccess` shows the system dialog exactly once per
//! application, ever; a denial is permanent until the user goes to System
//! Settings themselves. Spending that single prompt silently, the first time a
//! drag happens to land in a PDF, would be a poor trade. This module only ever
//! *preflights*; surfacing the request is a decision for a settings screen the
//! user is already looking at.

#[cfg(target_os = "macos")]
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
extern "C" {
    /// Non-prompting check for the Screen Recording grant. Bound directly for
    /// the same reason `input_monitor/hook_mac.rs` binds `CGEventTapEnable`:
    /// the CoreGraphics crate we already link does not re-export it.
    fn CGPreflightScreenCaptureAccess() -> bool;
}

/// The grant only takes effect after the app is relaunched, so the value is
/// near-constant within a session. The cache exists to keep a settings screen
/// that re-renders from hammering a TCC lookup, not to track live changes.
#[cfg(target_os = "macos")]
const CACHE_TTL: Duration = Duration::from_secs(5);

#[cfg(target_os = "macos")]
static CACHE: Mutex<Option<(bool, Instant)>> = Mutex::new(None);

/// Whether this process may capture window contents.
///
/// Always `true` off macOS: Windows and Linux have no equivalent gate, and
/// reporting `false` there would disable the OCR fallback on platforms where
/// it works fine.
#[cfg(target_os = "macos")]
pub fn screen_capture_permitted() -> bool {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((value, checked_at)) = *cache {
        if checked_at.elapsed() < CACHE_TTL {
            return value;
        }
    }
    let value = unsafe { CGPreflightScreenCaptureAccess() };
    *cache = Some((value, Instant::now()));
    value
}

#[cfg(not(target_os = "macos"))]
pub fn screen_capture_permitted() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real answer depends on the host's TCC database, so — exactly as
    /// `raw.rs` does for `AXIsProcessTrusted` — this only asserts the symbol
    /// links and the function is total.
    #[test]
    fn permission_probe_is_callable_and_total() {
        let _: bool = screen_capture_permitted();
    }

    #[test]
    fn repeated_probes_agree_within_the_cache_window() {
        // Two calls in quick succession must not disagree; an OCR gate that
        // flickered would make the fallback nondeterministic.
        assert_eq!(screen_capture_permitted(), screen_capture_permitted());
    }
}
