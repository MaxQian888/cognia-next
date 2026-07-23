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
    pub hwnd_id: u64,
}

/// Subtract `holes` from the interval `[start, end)`, returning the remaining
/// sub-intervals in ascending order. Holes may overlap each other and extend
/// past the interval; empty/inverted holes are ignored.
pub(crate) fn subtract_intervals(start: i32, end: i32, holes: &[(i32, i32)]) -> Vec<(i32, i32)> {
    let mut sorted: Vec<(i32, i32)> = holes.iter().copied().filter(|(s, e)| e > s).collect();
    sorted.sort_by_key(|h| h.0);
    let mut out = Vec::new();
    let mut cursor = start;
    for (hs, he) in sorted {
        if he <= cursor {
            continue;
        }
        if hs >= end {
            break;
        }
        if hs > cursor {
            out.push((cursor, hs.min(end)));
        }
        cursor = cursor.max(he);
        if cursor >= end {
            break;
        }
    }
    if cursor < end {
        out.push((cursor, end));
    }
    out
}

/// Pure filter + sort: turn raw candidates into perchable surfaces. Rejects
/// hidden / minimized / cloaked / tool / undersized / off-monitor / maximized
/// windows and our own windows, subtracts the horizontal spans of windows in
/// front that cover each surviving top edge (candidates arrive z-ordered,
/// front-most first — both `EnumWindows` and `CGWindowListCopyWindowInfo`
/// enumerate that way — so a fully covered window contributes no surface and a
/// partially covered one contributes only its visible segments, instead of the
/// pet perching "mid-air" on a hidden edge), then sorts by `(y, x)` for
/// deterministic perch selection.
pub(crate) fn filter_and_sort_surfaces(
    candidates: &[WindowCandidate],
    self_hwnds: &[u64],
    monitor_bounds: (i32, i32, i32, i32),
    min_width: i32,
    min_top_gap: i32,
) -> Vec<PetSurface> {
    let (mx, my, mw, mh) = monitor_bounds;
    let mut out: Vec<PetSurface> = Vec::new();
    for (idx, c) in candidates.iter().enumerate() {
        if !c.visible || c.minimized || c.cloaked || c.tool_window {
            continue;
        }
        if c.right - c.left < min_width || c.bottom <= c.top {
            continue;
        }
        if self_hwnds.contains(&c.hwnd_id) {
            continue;
        }
        // Fully off the monitor → skip.
        if !(c.right > mx && c.left < mx + mw && c.bottom > my && c.top < my + mh) {
            continue;
        }
        // Top edge at/above the monitor top (maximized / fullscreen) → skip.
        if c.top <= my + min_top_gap {
            continue;
        }
        // Windows IN FRONT (earlier in the z-ordered list) that intersect this
        // window's top-edge line occlude it. Tool windows count as occluders
        // (an always-on-top toolbar visually hides the edge even though it is
        // never itself a perch); our own overlay windows do not (the pet
        // sprite/popup float wherever the pet is).
        let holes: Vec<(i32, i32)> = candidates[..idx]
            .iter()
            .filter(|o| o.visible && !o.minimized && !o.cloaked)
            .filter(|o| !self_hwnds.contains(&o.hwnd_id))
            .filter(|o| o.top <= c.top && o.bottom > c.top)
            .map(|o| (o.left.max(c.left), o.right.min(c.right)))
            .collect();
        for (seg_start, seg_end) in subtract_intervals(c.left, c.right, &holes) {
            if seg_end - seg_start >= min_width {
                out.push(PetSurface {
                    x: seg_start as f64,
                    y: c.top as f64,
                    width: (seg_end - seg_start) as f64,
                });
            }
        }
    }
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
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongW, GetWindowRect, IsIconic, IsWindowVisible, GWL_EXSTYLE,
        WS_EX_TOOLWINDOW,
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

        // Prefer the DWM extended frame bounds — `GetWindowRect` includes the
        // invisible resize borders, so the pet perched a few px above the
        // visually true top edge. Fall back to `GetWindowRect` when DWM has no
        // answer (e.g. non-DWM legacy windows).
        let mut rect = RECT::default();
        let frame_ok = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok();
        if !frame_ok && GetWindowRect(hwnd, &mut rect).is_err() {
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

        out.push(WindowCandidate {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            visible,
            minimized,
            cloaked,
            tool_window,
            hwnd_id: hwnd.0 as u64,
        });
        BOOL(1)
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
        kCGWindowNumber, kCGWindowOwnerPID,
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
        let (owner_pid_key, bounds_key, layer_key, number_key) = unsafe {
            (
                kCGWindowOwnerPID,
                kCGWindowBounds,
                kCGWindowLayer,
                kCGWindowNumber,
            )
        };
        if dict_i64(dict, owner_pid_key) == Some(own_pid) {
            return None;
        }
        let rect = dict_rect(dict, bounds_key)?;
        let layer = dict_i64(dict, layer_key).unwrap_or(0);
        let window_id = dict_i64(dict, number_key).unwrap_or(0);
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
        fn maps_a_normal_window_including_bounds() {
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
            assert!(!candidate.tool_window);
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
/// primary, then a sane default), plus its scale factor.
fn pet_monitor_bounds<R: Runtime>(app: &AppHandle<R>) -> (i32, i32, i32, i32, f64) {
    let monitor = app
        .get_webview_window("pet")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let pos = m.position();
        let size = m.size();
        (
            pos.x,
            pos.y,
            size.width as i32,
            size.height as i32,
            m.scale_factor(),
        )
    } else {
        (0, 0, 1920, 1080, 1.0)
    }
}

/// Scale candidate rects from logical points to physical pixels. macOS
/// `CGWindowBounds` is in logical points, but the `PetSurface` contract — and
/// the Tauri monitor geometry candidates are filtered against — is physical
/// pixels; on any Retina display an unscaled candidate landed the pet mid-air
/// at 1/scale of the target. Scaling by the pet monitor's factor is exact for
/// candidates on the pet's own monitor — the only ones that survive the
/// monitor-bounds filter (mixed-DPI setups may mis-scale windows on *other*
/// monitors, which are rejected anyway).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn scale_candidates(
    candidates: Vec<WindowCandidate>,
    scale: f64,
) -> Vec<WindowCandidate> {
    if scale == 1.0 {
        return candidates;
    }
    candidates
        .into_iter()
        .map(|c| WindowCandidate {
            left: (c.left as f64 * scale).round() as i32,
            top: (c.top as f64 * scale).round() as i32,
            right: (c.right as f64 * scale).round() as i32,
            bottom: (c.bottom as f64 * scale).round() as i32,
            ..c
        })
        .collect()
}

/// Our own windows' HWND ids, so the pet never tries to perch on itself, its
/// own popup, the fleet island strip, or the main app window (and so none of
/// them count as occluders of other windows' edges).
#[cfg(target_os = "windows")]
fn self_hwnds<R: Runtime>(app: &AppHandle<R>) -> Vec<u64> {
    ["pet", "pet-popup", "island", "main"]
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

/// Raw top-level window facts, scaled to physical pixels for `scale`.
///
/// The one seam other subsystems borrow this enumeration through — the fleet
/// island uses it to tell a genuine full-screen Space from a merely maximized
/// window (`fleet/island_space.rs`). Kept here rather than duplicated there so
/// there is exactly one `CGWindowListCopyWindowInfo` / `EnumWindows` call site
/// in the app. Self-owned windows are already excluded by the platform layer
/// on macOS (owner-PID match); on Windows callers must still filter by
/// `hwnd_id` if that matters to them.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn enumerate_scaled_candidates(scale: f64) -> Vec<WindowCandidate> {
    let candidates = platform::enumerate();
    #[cfg(target_os = "macos")]
    let candidates = scale_candidates(candidates, scale);
    #[cfg(not(target_os = "macos"))]
    let _ = scale;
    candidates
}

/// Enumerate perchable window-top surfaces on the pet's monitor.
#[tauri::command]
pub async fn pet_window_get_surfaces(app: AppHandle) -> Result<PetSurfaces, String> {
    let (mx, my, mw, mh, _scale) = pet_monitor_bounds(&app);
    let hwnds = self_hwnds(&app);
    let candidates = platform::enumerate();
    // macOS reports window bounds in logical points; convert to the physical
    // pixel space everything downstream (monitor bounds, wander loop) uses.
    #[cfg(target_os = "macos")]
    let candidates = scale_candidates(candidates, _scale);
    let surfaces = filter_and_sort_surfaces(
        &candidates,
        &hwnds,
        (mx, my, mw, mh),
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
            hwnd_id: 1,
        }
    }

    fn run(c: WindowCandidate) -> Vec<PetSurface> {
        filter_and_sort_surfaces(&[c], &[], MONITOR, MIN_SURFACE_WIDTH, MIN_TOP_GAP)
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
    fn rejects_self_by_hwnd() {
        let mut by_id = candidate();
        by_id.hwnd_id = 9;
        assert!(
            filter_and_sort_surfaces(&[by_id], &[9], MONITOR, MIN_SURFACE_WIDTH, MIN_TOP_GAP)
                .is_empty()
        );
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
        // b/c are in front of a in z-order but do not overlap its top edge
        // (their bottoms are above a.top only if bottom <= a.top — here they
        // span past it, so place a's edge outside their horizontal span).
        a.left = 1300;
        a.right = 1700;
        let out =
            filter_and_sort_surfaces(&[a, b, c], &[], MONITOR, MIN_SURFACE_WIDTH, MIN_TOP_GAP);
        let ys: Vec<f64> = out.iter().map(|s| s.y).collect();
        let xs: Vec<f64> = out.iter().map(|s| s.x).collect();
        assert_eq!(ys, vec![200.0, 200.0, 400.0]);
        assert_eq!(xs, vec![100.0, 600.0, 1300.0]);
    }

    #[test]
    fn empty_candidates_yield_empty() {
        assert!(
            filter_and_sort_surfaces(&[], &[], MONITOR, MIN_SURFACE_WIDTH, MIN_TOP_GAP).is_empty()
        );
    }

    #[test]
    fn fully_covered_window_contributes_no_surface() {
        // Occluder is IN FRONT (earlier in the list) and spans the whole top
        // edge of the candidate behind it.
        let mut front = candidate();
        front.left = 100;
        front.right = 700;
        front.top = 250;
        front.bottom = 900;
        front.hwnd_id = 2;
        let back = candidate(); // 200..600 at top=300, inside front's rect
        let out =
            filter_and_sort_surfaces(&[front, back], &[], MONITOR, MIN_SURFACE_WIDTH, MIN_TOP_GAP);
        // Only the front window's own edge survives.
        assert_eq!(
            out,
            vec![PetSurface {
                x: 100.0,
                y: 250.0,
                width: 600.0
            }]
        );
    }

    #[test]
    fn partially_covered_edge_is_trimmed_to_visible_segments() {
        // Front window covers x 300..500 across the back window's top edge.
        let mut front = candidate();
        front.left = 300;
        front.right = 500;
        front.top = 250;
        front.bottom = 900;
        front.hwnd_id = 2;
        let mut back = candidate(); // 200..600 at top=300
        back.left = 80;
        back.right = 900;
        let out =
            filter_and_sort_surfaces(&[front, back], &[], MONITOR, MIN_SURFACE_WIDTH, MIN_TOP_GAP);
        // Back edge splits into [80, 300) and [500, 900); front's own edge at 250.
        assert_eq!(
            out,
            vec![
                PetSurface {
                    x: 300.0,
                    y: 250.0,
                    width: 200.0
                },
                PetSurface {
                    x: 80.0,
                    y: 300.0,
                    width: 220.0
                },
                PetSurface {
                    x: 500.0,
                    y: 300.0,
                    width: 400.0
                },
            ]
        );
    }

    #[test]
    fn occluder_below_the_edge_does_not_trim() {
        // A front window whose top is BELOW the back window's top edge does
        // not cover that edge line.
        let mut front = candidate();
        front.top = 400; // back.top is 300 → front does not span y=300
        front.bottom = 900;
        front.hwnd_id = 2;
        let back = candidate();
        let out =
            filter_and_sort_surfaces(&[front, back], &[], MONITOR, MIN_SURFACE_WIDTH, MIN_TOP_GAP);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn windows_behind_do_not_occlude() {
        // Same geometry as fully_covered_window_contributes_no_surface but the
        // large window is BEHIND (later in the list) — the small front window's
        // edge survives untouched.
        let small = candidate(); // 200..600 top=300, hwnd 1 (front)
        let mut big = candidate();
        big.left = 100;
        big.right = 700;
        big.top = 250;
        big.bottom = 900;
        big.hwnd_id = 2;
        let out =
            filter_and_sort_surfaces(&[small, big], &[], MONITOR, MIN_SURFACE_WIDTH, MIN_TOP_GAP);
        // big's edge (250) gets trimmed by small only where small spans y=250?
        // small.top=300 > 250, so small does NOT cover big's edge line.
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn tool_windows_occlude_but_never_perch() {
        // An always-on-top toolbar in front hides the edge below it even
        // though it is not itself a perch target.
        let mut toolbar = candidate();
        toolbar.tool_window = true;
        toolbar.left = 100;
        toolbar.right = 700;
        toolbar.top = 250;
        toolbar.bottom = 900;
        toolbar.hwnd_id = 2;
        let back = candidate();
        let out = filter_and_sort_surfaces(
            &[toolbar, back],
            &[],
            MONITOR,
            MIN_SURFACE_WIDTH,
            MIN_TOP_GAP,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn segments_narrower_than_min_width_are_dropped() {
        // Front window leaves a 60px sliver on each side of the back edge.
        let mut front = candidate();
        front.left = 260;
        front.right = 540;
        front.top = 250;
        front.bottom = 900;
        front.hwnd_id = 2;
        let back = candidate(); // 200..600 → slivers 200..260 and 540..600
        let out =
            filter_and_sort_surfaces(&[front, back], &[], MONITOR, MIN_SURFACE_WIDTH, MIN_TOP_GAP);
        // Only the front window's own (wide) edge remains.
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].y, 250.0);
    }

    #[test]
    fn subtract_intervals_handles_overlapping_and_out_of_range_holes() {
        // Overlapping holes merge; holes outside the interval are ignored.
        assert_eq!(
            subtract_intervals(0, 100, &[(10, 30), (20, 40), (-50, -10), (150, 200)]),
            vec![(0, 10), (40, 100)]
        );
        // Hole covering everything → nothing left.
        assert_eq!(subtract_intervals(0, 100, &[(-10, 110)]), vec![]);
        // No holes → whole interval.
        assert_eq!(subtract_intervals(5, 9, &[]), vec![(5, 9)]);
        // Inverted/empty holes are ignored.
        assert_eq!(subtract_intervals(0, 10, &[(7, 3)]), vec![(0, 10)]);
    }

    #[test]
    fn scale_candidates_converts_points_to_physical_pixels() {
        let scaled = scale_candidates(vec![candidate()], 2.0);
        assert_eq!(scaled[0].left, 400);
        assert_eq!(scaled[0].top, 600);
        assert_eq!(scaled[0].right, 1200);
        assert_eq!(scaled[0].bottom, 1600);
        // 1.0 scale is an identity pass-through.
        let same = scale_candidates(vec![candidate()], 1.0);
        assert_eq!(same[0].left, 200);
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
