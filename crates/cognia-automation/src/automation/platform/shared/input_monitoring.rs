//! Non-prompting probe for the macOS Input Monitoring grant.
//!
//! Until now the only signal that this grant was missing was `HookGuard::install`
//! failing at the moment the user hit "start recording" — i.e. after they had
//! already chosen a scope, answered a consent prompt, and expected to be
//! recording. A preflight needs to know beforehand.
//!
//! `IOHIDCheckAccess` is the read-only counterpart of `IOHIDRequestAccess`;
//! only the latter prompts, and prompting from a probe would be exactly the
//! kind of unsolicited system dialog `screen_capture.rs` documents avoiding.
//! The 5-second cache mirrors that module for the same reason: a settings screen
//! that re-renders should not hammer a TCC lookup.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Result of a permission probe. `Unknown` is distinct from `Missing`: the
/// preflight tells the user "we could not check" rather than sending them to a
/// System Settings pane that may already be correct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeState {
    Ok,
    Missing,
    Unknown,
    /// This platform has no such gate. Reported as-is rather than as `Ok`, so
    /// the UI can omit the row instead of claiming a grant that does not exist.
    NotApplicable,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    /// `kIOHIDRequestTypeListenEvent` — the access class a CGEventTap needs.
    const REQUEST_TYPE_LISTEN_EVENT: u32 = 1;
    /// `kIOHIDAccessTypeGranted` / `Denied` / `Unknown`.
    const ACCESS_GRANTED: u32 = 0;
    const ACCESS_DENIED: u32 = 1;

    // IOKit is not otherwise in this crate's link set (the CoreGraphics /
    // CoreFoundation graph does not pull it in), so the framework is named
    // explicitly here rather than relying on a transitive link.
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        /// Read-only counterpart of `IOHIDRequestAccess`. Bound directly for the
        /// same reason `screen_capture.rs` binds
        /// `CGPreflightScreenCaptureAccess`: no crate we depend on re-exports it.
        fn IOHIDCheckAccess(request: u32) -> u32;
    }

    const CACHE_TTL: Duration = Duration::from_secs(5);
    static CACHE: Mutex<Option<(ProbeState, Instant)>> = Mutex::new(None);

    pub(super) fn state() -> ProbeState {
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((value, checked_at)) = *cache {
            if checked_at.elapsed() < CACHE_TTL {
                return value;
            }
        }
        // SAFETY: a pure IOKit query with an integer argument and no out-params.
        let value = match unsafe { IOHIDCheckAccess(REQUEST_TYPE_LISTEN_EVENT) } {
            ACCESS_GRANTED => ProbeState::Ok,
            ACCESS_DENIED => ProbeState::Missing,
            _ => ProbeState::Unknown,
        };
        *cache = Some((value, Instant::now()));
        value
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::ProbeState;

    /// Windows has no equivalent gate for `WH_*_LL` hooks (installation either
    /// succeeds or fails outright), and Linux is not a supported recording
    /// platform.
    pub(super) fn state() -> ProbeState {
        ProbeState::NotApplicable
    }
}

/// Whether this process may observe global keyboard/mouse input.
pub fn input_monitoring_state() -> ProbeState {
    imp::state()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_is_callable_and_total() {
        // Host-dependent — only totality and a repeat call through the cache are
        // asserted. Same shape as `screen_capture.rs`'s own probe test.
        let first = input_monitoring_state();
        let second = input_monitoring_state();
        assert_eq!(first, second, "the cache must not flip the answer");
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_reports_not_applicable() {
        assert_eq!(input_monitoring_state(), ProbeState::NotApplicable);
    }

    #[test]
    fn probe_state_serializes_camel_case() {
        assert_eq!(
            serde_json::to_string(&ProbeState::NotApplicable).unwrap(),
            "\"notApplicable\""
        );
        assert_eq!(serde_json::to_string(&ProbeState::Ok).unwrap(), "\"ok\"");
        let back: ProbeState = serde_json::from_str("\"missing\"").unwrap();
        assert_eq!(back, ProbeState::Missing);
    }

    #[test]
    fn unknown_is_distinct_from_missing() {
        // The preflight copy differs: "we could not check" must not send a user
        // to a settings pane that may already be correct.
        assert_ne!(ProbeState::Unknown, ProbeState::Missing);
    }
}
