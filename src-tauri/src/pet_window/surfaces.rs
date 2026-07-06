//! Perchable "surfaces" for the desktop pet: the top edges of visible top-level
//! windows the pet can climb onto / walk along (Shimeji-style). Windows-only;
//! other platforms return an empty list so the overlay degrades to its normal
//! floor-wander behavior.
//!
//! Three layers keep the business logic testable without a live desktop:
//!   1. `PetSurface` / `PetSurfaces` — the serde DTO (named struct, NOT a tuple
//!      — a bare tuple serializes as a JSON array and the TS wrapper silently
//!      reads `undefined`; see the regression note in `mod.rs`).
//!   2. `filter_and_sort_surfaces` — pure predicate over plain `WindowCandidate`
//!      records, fully unit-tested.
//!   3. `platform::enumerate` — the thin `EnumWindows` call (smoke-tested via
//!      `pnpm tauri dev` only).

use serde::Serialize;

/// One perchable platform: the top edge of a window. Physical pixels; `y` is the
/// window's top, `x`/`width` its horizontal span.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSurface {
    pub x: f64,
    pub y: f64,
    pub width: f64,
}

/// Wrapper so the IPC payload is a named object (forward-compatible), never a
/// bare JSON array.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSurfaces {
    pub surfaces: Vec<PetSurface>,
}

/// Minimum window width to bother perching on (skip slivers / tooltips).
pub(crate) const MIN_SURFACE_WIDTH: i32 = 120;
/// A window whose top edge is within this many px of the monitor top is treated
/// as maximized / fullscreen and rejected (the pet would sit over its content).
pub(crate) const MIN_TOP_GAP: i32 = 8;

/// Raw per-window facts gathered from the OS (or synthesized in tests).
#[derive(Debug, Clone)]
pub(crate) struct WindowCandidate {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub visible: bool,
    pub minimized: bool,
    pub cloaked: bool,
    pub tool_window: bool,
    pub title: String,
    pub hwnd_id: u64,
}

/// Pure filter + sort: turn raw candidates into perchable surfaces. Rejects
/// hidden / minimized / cloaked / tool / undersized / off-monitor / maximized
/// windows and our own windows, then sorts by `(y, x)` for deterministic perch
/// selection.
pub(crate) fn filter_and_sort_surfaces(
    candidates: &[WindowCandidate],
    self_titles: &[&str],
    self_hwnds: &[u64],
    monitor_bounds: (i32, i32, i32, i32),
    min_width: i32,
    min_top_gap: i32,
) -> Vec<PetSurface> {
    let (mx, my, mw, mh) = monitor_bounds;
    let mut out: Vec<PetSurface> = candidates
        .iter()
        .filter(|c| c.visible && !c.minimized && !c.cloaked && !c.tool_window)
        .filter(|c| c.right - c.left >= min_width)
        .filter(|c| c.bottom > c.top) // positive height
        .filter(|c| !self_hwnds.contains(&c.hwnd_id))
        .filter(|c| !self_titles.iter().any(|t| *t == c.title))
        // Fully off the monitor → skip.
        .filter(|c| c.right > mx && c.left < mx + mw && c.bottom > my && c.top < my + mh)
        // Top edge at/above the monitor top (maximized / fullscreen) → skip.
        .filter(|c| c.top > my + min_top_gap)
        .map(|c| PetSurface {
            x: c.left as f64,
            y: c.top as f64,
            width: (c.right - c.left) as f64,
        })
        .collect();
    out.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });
    out
}

#[cfg(target_os = "windows")]
mod platform {
    use super::WindowCandidate;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsIconic,
        IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    /// Collect every top-level window's facts. SAFETY: all calls are read-only
    /// Win32 queries; the callback only pushes into a `Vec` borrowed through the
    /// `LPARAM`.
    pub fn enumerate() -> Vec<WindowCandidate> {
        let mut out: Vec<WindowCandidate> = Vec::new();
        unsafe {
            let _ = EnumWindows(
                Some(enum_cb),
                LPARAM(&mut out as *mut Vec<WindowCandidate> as isize),
            );
        }
        out
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<WindowCandidate>);

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return BOOL(1); // keep enumerating
        }

        let visible = IsWindowVisible(hwnd).as_bool();
        let minimized = IsIconic(hwnd).as_bool();
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let tool_window = ex_style & WS_EX_TOOLWINDOW.0 != 0;

        // DWM cloaking (virtual-desktop / UWP ghost windows).
        let mut cloaked_flag: u32 = 0;
        let cloaked = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked_flag as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
        .map(|_| cloaked_flag != 0)
        .unwrap_or(false);

        let title = window_title(hwnd);

        out.push(WindowCandidate {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            visible,
            minimized,
            cloaked,
            tool_window,
            title,
            hwnd_id: hwnd.0 as u64,
        });
        BOOL(1)
    }

    unsafe fn window_title(hwnd: HWND) -> String {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }
}

#[cfg(target_os = "macos")]
mod platform {
    //! `CGWindowListCopyWindowInfo`-based enumeration. Reuses the automation
    //! backend's existing `core-graphics`/`core-foundation` dependencies
    //! (`Cargo.toml`, macOS target deps) — no new crates. Self-exclusion is by
    //! owner PID (`kCGWindowOwnerPID` vs `std::process::id()`), which catches
    //! every window of this process (main/pet/popup) at once — simpler and
    //! more robust than Windows' per-label HWND list, and needs no AppKit/
    //! `NSWindow` interop (`self_hwnds` below stays empty on this platform;
    //! see the non-Windows branch).

    use super::WindowCandidate;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::geometry::CGRect;
    use core_graphics::window::{
        create_description_from_array, create_window_list, kCGNullWindowID, kCGWindowBounds,
        kCGWindowLayer, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
        kCGWindowName, kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
    };

    fn cf_key(raw: CFStringRef) -> CFString {
        // SAFETY: the `kCGWindow*` statics are process-lifetime CFStrings
        // owned by the CoreGraphics framework; `wrap_under_get_rule` retains
        // rather than takes ownership, matching how the crate's own
        // `copy_window_info` wraps framework-owned values.
        unsafe { CFString::wrap_under_get_rule(raw) }
    }

    fn dict_i64(dict: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<i64> {
        dict.find(&cf_key(key))?.downcast::<CFNumber>()?.to_i64()
    }

    fn dict_string(dict: &CFDictionary<CFString, CFType>, key: CFStringRef) -> String {
        dict.find(&cf_key(key))
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
            .unwrap_or_default()
    }

    /// `kCGWindowBounds`'s value is itself a dictionary in the standard
    /// `CGRectMakeWithDictionaryRepresentation` format (documented X/Y/Width/
    /// Height keys) — `CGRect::from_dict_representation` (from the
    /// `core-graphics-types` crate `core-graphics` re-exports) decodes it
    /// directly, no manual FFI binding needed.
    fn dict_rect(dict: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<CGRect> {
        let bounds = dict.find(&cf_key(key))?.downcast::<CFDictionary>()?;
        CGRect::from_dict_representation(&bounds)
    }

    /// Map one window's description dictionary into a `WindowCandidate`, or
    /// `None` if it belongs to this process (never a perch target) or its
    /// bounds can't be decoded. Pure aside from the CG/CF calls the fields
    /// themselves require — no live window query — so it's unit-testable
    /// with synthetic dictionaries.
    fn candidate_from_dict(
        dict: &CFDictionary<CFString, CFType>,
        own_pid: i64,
    ) -> Option<WindowCandidate> {
        // SAFETY: the `kCGWindow*` keys are immutable, process-lifetime
        // `CFStringRef` constants exported by CoreGraphics; reading them is
        // always sound. rustc now requires the read of an extern `static` to
        // sit in an `unsafe` block, so bind them once up front.
        let (owner_pid_key, bounds_key, layer_key, number_key, name_key, owner_name_key) = unsafe {
            (
                kCGWindowOwnerPID,
                kCGWindowBounds,
                kCGWindowLayer,
                kCGWindowNumber,
                kCGWindowName,
                kCGWindowOwnerName,
            )
        };
        if dict_i64(dict, owner_pid_key) == Some(own_pid) {
            return None;
        }
        let rect = dict_rect(dict, bounds_key)?;
        let layer = dict_i64(dict, layer_key).unwrap_or(0);
        let window_id = dict_i64(dict, number_key).unwrap_or(0);
        let name = dict_string(dict, name_key);
        let title = if !name.is_empty() {
            name
        } else {
            dict_string(dict, owner_name_key)
        };
        Some(WindowCandidate {
            left: rect.origin.x as i32,
            top: rect.origin.y as i32,
            right: (rect.origin.x + rect.size.width) as i32,
            bottom: (rect.origin.y + rect.size.height) as i32,
            // Implied by `kCGWindowListOptionOnScreenOnly` — minimized/hidden
            // windows aren't returned at all, so there's no separate signal
            // to read (unlike Windows' `IsIconic`/`IsWindowVisible`).
            visible: true,
            minimized: false,
            // No DWM-style cloaking concept on macOS; `kCGWindowLayer != 0`
            // (menu bar / dock / Spotlight / other system chrome) covers the
            // same "don't perch here" cases Windows' tool-window check does.
            cloaked: false,
            tool_window: layer != 0,
            title,
            hwnd_id: window_id as u64,
        })
    }

    pub fn enumerate() -> Vec<WindowCandidate> {
        let own_pid = std::process::id() as i64;
        let Some(ids) = create_window_list(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        ) else {
            return Vec::new();
        };
        let Some(dicts) = create_description_from_array(ids) else {
            return Vec::new();
        };
        dicts
            .iter()
            .filter_map(|d| candidate_from_dict(&d, own_pid))
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Builds the standard `CGRectMakeWithDictionaryRepresentation` dict
        /// shape (documented X/Y/Width/Height keys) so `dict_rect` round-trips
        /// through the real native decoder.
        fn bounds_dict(x: f64, y: f64, w: f64, h: f64) -> CFDictionary<CFString, CFType> {
            CFDictionary::from_CFType_pairs(&[
                (
                    CFString::from_static_string("X"),
                    CFNumber::from(x).as_CFType(),
                ),
                (
                    CFString::from_static_string("Y"),
                    CFNumber::from(y).as_CFType(),
                ),
                (
                    CFString::from_static_string("Width"),
                    CFNumber::from(w).as_CFType(),
                ),
                (
                    CFString::from_static_string("Height"),
                    CFNumber::from(h).as_CFType(),
                ),
            ])
        }

        fn window_dict(
            pid: i64,
            layer: i64,
            window_id: i64,
            name: &str,
            owner: &str,
            bounds: CFDictionary<CFString, CFType>,
        ) -> CFDictionary<CFString, CFType> {
            CFDictionary::from_CFType_pairs(&[
                (
                    CFString::from_static_string("kCGWindowOwnerPID"),
                    CFNumber::from(pid).as_CFType(),
                ),
                (
                    CFString::from_static_string("kCGWindowLayer"),
                    CFNumber::from(layer).as_CFType(),
                ),
                (
                    CFString::from_static_string("kCGWindowNumber"),
                    CFNumber::from(window_id).as_CFType(),
                ),
                (
                    CFString::from_static_string("kCGWindowName"),
                    CFString::from(name).as_CFType(),
                ),
                (
                    CFString::from_static_string("kCGWindowOwnerName"),
                    CFString::from(owner).as_CFType(),
                ),
                (
                    CFString::from_static_string("kCGWindowBounds"),
                    bounds.as_CFType(),
                ),
            ])
        }

        // These fixtures key by literal string ("kCGWindowBounds" etc.) —
        // Apple's own `CGWindowListCopyWindowInfo` output confirms the
        // `kCGWindow*` CFString constants' runtime values are exactly their
        // symbol names (e.g. a real dump shows `kCGWindowOwnerPID = 507;`),
        // so these match what `candidate_from_dict` looks up via the actual
        // native constants.

        #[test]
        fn maps_a_normal_window_including_bounds_and_title_fallback() {
            let dict = window_dict(
                999,
                0,
                42,
                "",
                "Finder",
                bounds_dict(10.0, 20.0, 300.0, 400.0),
            );
            let candidate = candidate_from_dict(&dict, 1).expect("should map");
            assert_eq!(candidate.left, 10);
            assert_eq!(candidate.top, 20);
            assert_eq!(candidate.right, 310);
            assert_eq!(candidate.bottom, 420);
            assert_eq!(candidate.hwnd_id, 42);
            assert_eq!(candidate.title, "Finder"); // empty kCGWindowName → owner name
            assert!(!candidate.tool_window);
        }

        #[test]
        fn prefers_the_window_name_over_the_owner_name() {
            let dict = window_dict(
                999,
                0,
                1,
                "Untitled Document",
                "TextEdit",
                bounds_dict(0.0, 0.0, 200.0, 200.0),
            );
            let candidate = candidate_from_dict(&dict, 1).expect("should map");
            assert_eq!(candidate.title, "Untitled Document");
        }

        #[test]
        fn excludes_windows_owned_by_this_process() {
            let dict = window_dict(
                1234,
                0,
                1,
                "Cognia",
                "Cognia",
                bounds_dict(0.0, 0.0, 200.0, 200.0),
            );
            assert!(candidate_from_dict(&dict, 1234).is_none());
        }

        #[test]
        fn nonzero_layer_marks_the_window_as_tool_window_equivalent() {
            let dict = window_dict(
                999,
                25, // e.g. the menu bar / Spotlight layer
                1,
                "",
                "SystemUIServer",
                bounds_dict(0.0, 0.0, 1920.0, 24.0),
            );
            let candidate = candidate_from_dict(&dict, 1).expect("should map");
            assert!(candidate.tool_window);
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::WindowCandidate;
    /// No window enumeration on this platform — Wayland has no stable
    /// cross-app window-geometry API (a deliberate security boundary), and
    /// X11-only support was judged not worth the maintenance surface for a
    /// shrinking minority of Linux sessions. The pet keeps its floor-wander.
    pub fn enumerate() -> Vec<WindowCandidate> {
        Vec::new()
    }
}

use tauri::{AppHandle, Manager, Runtime};

/// Physical-pixel bounds of the monitor the pet window sits on (falls back to
/// primary, then a sane default).
fn pet_monitor_bounds<R: Runtime>(app: &AppHandle<R>) -> (i32, i32, i32, i32) {
    let monitor = app
        .get_webview_window("pet")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let pos = m.position();
        let size = m.size();
        (pos.x, pos.y, size.width as i32, size.height as i32)
    } else {
        (0, 0, 1920, 1080)
    }
}

/// Our own windows' HWND ids, so the pet never tries to perch on itself or the
/// main app window.
#[cfg(target_os = "windows")]
fn self_hwnds<R: Runtime>(app: &AppHandle<R>) -> Vec<u64> {
    ["pet", "main"]
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .filter_map(|w| w.hwnd().ok())
        .map(|h| h.0 as u64)
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn self_hwnds<R: Runtime>(_app: &AppHandle<R>) -> Vec<u64> {
    Vec::new()
}

/// Enumerate perchable window-top surfaces on the pet's monitor.
#[tauri::command]
pub async fn pet_window_get_surfaces(app: AppHandle) -> Result<PetSurfaces, String> {
    let bounds = pet_monitor_bounds(&app);
    let hwnds = self_hwnds(&app);
    let candidates = platform::enumerate();
    let surfaces = filter_and_sort_surfaces(
        &candidates,
        &["pet", "main"],
        &hwnds,
        bounds,
        MIN_SURFACE_WIDTH,
        MIN_TOP_GAP,
    );
    Ok(PetSurfaces { surfaces })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: (i32, i32, i32, i32) = (0, 0, 1920, 1080);

    fn candidate() -> WindowCandidate {
        WindowCandidate {
            left: 200,
            top: 300,
            right: 600,
            bottom: 800,
            visible: true,
            minimized: false,
            cloaked: false,
            tool_window: false,
            title: "Editor".into(),
            hwnd_id: 1,
        }
    }

    fn run(c: WindowCandidate) -> Vec<PetSurface> {
        filter_and_sort_surfaces(
            &[c],
            &["pet", "main"],
            &[],
            MONITOR,
            MIN_SURFACE_WIDTH,
            MIN_TOP_GAP,
        )
    }

    #[test]
    fn maps_a_normal_window_to_its_top_edge() {
        let out = run(candidate());
        assert_eq!(
            out,
            vec![PetSurface {
                x: 200.0,
                y: 300.0,
                width: 400.0
            }]
        );
    }

    #[test]
    fn rejects_hidden_minimized_cloaked_and_tool_windows() {
        for mutate in [
            |c: &mut WindowCandidate| c.visible = false,
            |c: &mut WindowCandidate| c.minimized = true,
            |c: &mut WindowCandidate| c.cloaked = true,
            |c: &mut WindowCandidate| c.tool_window = true,
        ] {
            let mut c = candidate();
            mutate(&mut c);
            assert!(run(c).is_empty());
        }
    }

    #[test]
    fn rejects_undersized_and_zero_height_windows() {
        let mut narrow = candidate();
        narrow.right = narrow.left + MIN_SURFACE_WIDTH - 1;
        assert!(run(narrow).is_empty());

        let mut flat = candidate();
        flat.bottom = flat.top;
        assert!(run(flat).is_empty());
    }

    #[test]
    fn rejects_self_by_hwnd_and_title() {
        let mut by_id = candidate();
        by_id.hwnd_id = 9;
        assert!(filter_and_sort_surfaces(
            &[by_id],
            &["pet", "main"],
            &[9],
            MONITOR,
            MIN_SURFACE_WIDTH,
            MIN_TOP_GAP
        )
        .is_empty());

        let mut by_title = candidate();
        by_title.title = "pet".into();
        assert!(run(by_title).is_empty());
    }

    #[test]
    fn rejects_offscreen_and_maximized_windows() {
        let mut offscreen = candidate();
        offscreen.left = 3000;
        offscreen.right = 3400;
        assert!(run(offscreen).is_empty());

        let mut maximized = candidate();
        maximized.top = MIN_TOP_GAP; // at the monitor top
        assert!(run(maximized).is_empty());
    }

    #[test]
    fn sorts_by_top_then_left() {
        let mut a = candidate();
        a.top = 400;
        a.left = 800;
        a.right = 1200;
        a.hwnd_id = 1;
        let mut b = candidate();
        b.top = 200;
        b.left = 100;
        b.right = 500;
        b.hwnd_id = 2;
        let mut c = candidate();
        c.top = 200;
        c.left = 600;
        c.right = 1000;
        c.hwnd_id = 3;
        let out = filter_and_sort_surfaces(
            &[a, b, c],
            &["pet", "main"],
            &[],
            MONITOR,
            MIN_SURFACE_WIDTH,
            MIN_TOP_GAP,
        );
        let ys: Vec<f64> = out.iter().map(|s| s.y).collect();
        let xs: Vec<f64> = out.iter().map(|s| s.x).collect();
        assert_eq!(ys, vec![200.0, 200.0, 400.0]);
        assert_eq!(xs, vec![100.0, 600.0, 800.0]);
    }

    #[test]
    fn empty_candidates_yield_empty() {
        assert!(
            filter_and_sort_surfaces(&[], &[], &[], MONITOR, MIN_SURFACE_WIDTH, MIN_TOP_GAP)
                .is_empty()
        );
    }

    #[test]
    fn surface_serializes_as_named_object_not_tuple() {
        let json = serde_json::to_value(PetSurface {
            x: 12.0,
            y: 34.0,
            width: 56.0,
        })
        .unwrap();
        assert_eq!(json["x"], 12.0);
        assert_eq!(json["y"], 34.0);
        assert_eq!(json["width"], 56.0);
        assert!(json.as_object().is_some());
    }

    #[test]
    fn surfaces_wrapper_serializes_camel_case() {
        let json = serde_json::to_value(PetSurfaces {
            surfaces: vec![PetSurface {
                x: 1.0,
                y: 2.0,
                width: 3.0,
            }],
        })
        .unwrap();
        assert!(json["surfaces"].is_array());
    }

    // Only the fallback stub (non-Windows, non-macOS) returns an empty list —
    // Windows and macOS have real window-enumeration backends. Gate this to
    // exactly the stub platform, mirroring the stub `mod platform` cfg above.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn enumerate_is_empty_on_stub_platforms() {
        assert!(platform::enumerate().is_empty());
    }
}
