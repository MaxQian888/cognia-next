//! Keep a window out of every screenshot the recorder itself takes.
//!
//! A visible-but-capturable controller would put a picture of the recorder's own
//! UI into every frame of the bundle — and then into whatever the model reads.
//! So this is fail-closed at the call site: if exclusion cannot be established,
//! the window is closed and `record_start` fails rather than recording through
//! it.
//!
//! **No FFI needed.** `tao` already implements both halves —
//! `NSWindow.setSharingType(NSWindowSharingType::None)` on macOS and
//! `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on Windows — and Tauri
//! surfaces them as `WebviewWindow::set_content_protected`. Both are effective
//! against *our* capture path specifically: `xcap` uses `CGWindowListCreateImage`
//! on macOS (which honours sharingType) and a desktop-DC `BitBlt` on Windows
//! (which honours display affinity).
//!
//! This module exists as a named seam anyway, so failures are loud rather than
//! swallowed and the re-apply points are greppable.

use tauri::{Runtime, WebviewWindow};

/// Exclude (or re-include) a window from screen capture.
pub fn set_capture_excluded<R: Runtime>(
    window: &WebviewWindow<R>,
    excluded: bool,
) -> Result<(), String> {
    window
        .set_content_protected(excluded)
        .map_err(|error| format!("recorder controller capture exclusion failed: {error}"))?;
    verify(window, excluded)
}

/// What to do once the OS has reported the affinity it actually applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum AffinityOutcome {
    /// The OS applied what we asked for.
    Satisfied,
    /// Exclusion was refused; try `WDA_MONITOR` so the window renders black.
    FallBackToBlackout,
    /// Nothing left to try — the caller must fail closed.
    Failed(&'static str),
}

/// Decide the next move from the requested and the observed affinity.
///
/// Split from the FFI because this is the part that can be wrong without any OS
/// involvement — and the interesting branch (a pre-19041 Windows refusing
/// `WDA_EXCLUDEFROMCAPTURE`) is unreachable on the machines this repo is
/// developed on, so a real-window test would never cover it.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn affinity_outcome(excluded: bool, applied: bool) -> AffinityOutcome {
    match (excluded, applied) {
        (_, true) => AffinityOutcome::Satisfied,
        // Un-excluding is all-or-nothing: leaving a stale affinity on a window
        // the caller asked to release is a lie, not a degraded mode.
        (false, false) => AffinityOutcome::Failed("could not clear the window's display affinity"),
        // Pre-19041: exclusion is unavailable, but blacking out is not.
        (true, false) => AffinityOutcome::FallBackToBlackout,
    }
}

/// Windows-only post-check.
///
/// `WDA_EXCLUDEFROMCAPTURE` needs Windows 10 2004 (build 19041), and `tao`
/// ignores the return value of `SetWindowDisplayAffinity` — so
/// `set_content_protected` returns `Ok` even when the OS refused. On an older
/// build we fall back to `WDA_MONITOR`, which renders the window black in
/// captures. Black is acceptable; visible is not.
#[cfg(target_os = "windows")]
fn verify<R: Runtime>(window: &WebviewWindow<R>, excluded: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_MONITOR,
        WDA_NONE, WINDOW_DISPLAY_AFFINITY,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let want = if excluded {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    let mut actual = WINDOW_DISPLAY_AFFINITY::default();
    // SAFETY: `hwnd` is a live window handle owned by this process and `actual`
    // is a stack out-param of the required type.
    if unsafe { GetWindowDisplayAffinity(hwnd, &mut actual) }.is_err() {
        return Err("could not read the window's display affinity".into());
    }
    match affinity_outcome(excluded, actual == want) {
        AffinityOutcome::Satisfied => Ok(()),
        AffinityOutcome::Failed(message) => Err(message.into()),
        AffinityOutcome::FallBackToBlackout => {
            // SAFETY: same handle; `WDA_MONITOR` is a valid affinity constant.
            if unsafe { SetWindowDisplayAffinity(hwnd, WDA_MONITOR) }.is_err() {
                return Err(
                    "this Windows build supports neither capture exclusion nor capture blackout"
                        .into(),
                );
            }
            log::warn!(
                "recorder controller: WDA_EXCLUDEFROMCAPTURE unavailable (needs Windows 10 build \
                 19041); falling back to WDA_MONITOR, so the controller renders black in captures"
            );
            Ok(())
        }
    }
}

/// macOS has no read-back API for `sharingType`, and `setSharingType` does not
/// fail — a successful `set_content_protected` is the confirmation.
#[cfg(not(target_os = "windows"))]
fn verify<R: Runtime>(_window: &WebviewWindow<R>, _excluded: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{affinity_outcome, AffinityOutcome};

    #[test]
    fn an_applied_affinity_is_satisfied_in_both_directions() {
        assert_eq!(affinity_outcome(true, true), AffinityOutcome::Satisfied);
        assert_eq!(affinity_outcome(false, true), AffinityOutcome::Satisfied);
    }

    #[test]
    fn a_refused_exclusion_falls_back_to_blackout() {
        // The pre-19041 branch. Black is acceptable; visible is not — so this
        // must never be `Failed`, or the recorder would refuse to start on an
        // older Windows that can still hide the controller adequately.
        assert_eq!(
            affinity_outcome(true, false),
            AffinityOutcome::FallBackToBlackout
        );
    }

    #[test]
    fn a_refused_release_fails_closed() {
        // Asymmetric on purpose: a window we could not un-exclude is not a
        // degraded mode, it is a window whose state we are lying about.
        assert!(matches!(
            affinity_outcome(false, false),
            AffinityOutcome::Failed(_)
        ));
    }
}
