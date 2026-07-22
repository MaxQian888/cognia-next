//! macOS NSPanel behavior for the desktop-pet windows.
//!
//! The sprite (`"pet"`) and popup (`"pet-popup"`) windows are plain
//! `always_on_top` `WebviewWindow`s. On macOS that has two problems a real
//! desktop pet must not have: (1) showing/focusing the window ACTIVATES the app
//! and steals focus from the foreground app; (2) a normal window is bound to
//! one Space and hidden by full-screen apps. Reclassing each to a NON-ACTIVATING
//! `NSPanel` (`tauri-nspanel`) with an all-Spaces collection behavior fixes both:
//! the pet floats over every Space + full-screen apps and never steals focus.
//! The popup keeps `can_become_key_window: true` so its talk composer can still
//! be typed into (a borderless window otherwise rejects keystrokes).
//!
//! Live AppKit ops can't run under `tauri::test::mock_app()` (same constraint as
//! `pet_window/mod.rs`), so only the pure constants + the role policy are
//! unit-tested here; the runtime panel behavior is smoke-tested on a packaged
//! `.app` (`tauri-smoke`). This module is the single seam `mod.rs`/`popup.rs`
//! call, with a no-op shim off macOS so the call sites stay `cfg`-free.
#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use std::sync::Arc;
use std::sync::Mutex;

// `Manager` is required in scope on macOS only: the `tauri_panel!`-generated
// `from_window` calls `window.app_handle()` (a `Manager` method) when it
// reclasses the window. The off-macOS shim never touches it — cfg-gate the
// import so non-mac builds don't warn.
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{Runtime, WebviewWindow};

/// Which overlay window is being converted — decides the key-window policy
/// and the window level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PetPanelRole {
    /// The transparent sprite: never becomes key (fully non-activating).
    Sprite,
    /// The click popup: may become key so its text input accepts typing.
    Popup,
    /// The fleet island strip: key-capable like the popup (inline reply
    /// input), but floats ABOVE the menu bar — the strip hugs the true top
    /// edge of the screen, and at the pet's floating level (3) the menu bar
    /// (level 24) would draw over it on every non-fullscreen Space.
    Island,
}

static SPRITE_PANEL_GENERATION: AtomicU64 = AtomicU64::new(0);
static POPUP_PANEL_GENERATION: AtomicU64 = AtomicU64::new(0);
static ISLAND_PANEL_GENERATION: AtomicU64 = AtomicU64::new(0);
static SPRITE_PANEL_OPEN: AtomicBool = AtomicBool::new(false);
static POPUP_PANEL_OPEN: AtomicBool = AtomicBool::new(false);
static ISLAND_PANEL_OPEN: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
struct PanelLifecycle {
    destroying: bool,
    in_flight_builds: u64,
}

static SPRITE_PANEL_LIFECYCLE: Mutex<PanelLifecycle> = Mutex::new(PanelLifecycle {
    destroying: false,
    in_flight_builds: 0,
});
static POPUP_PANEL_LIFECYCLE: Mutex<PanelLifecycle> = Mutex::new(PanelLifecycle {
    destroying: false,
    in_flight_builds: 0,
});
static ISLAND_PANEL_LIFECYCLE: Mutex<PanelLifecycle> = Mutex::new(PanelLifecycle {
    destroying: false,
    in_flight_builds: 0,
});

fn panel_generation(role: PetPanelRole) -> &'static AtomicU64 {
    match role {
        PetPanelRole::Sprite => &SPRITE_PANEL_GENERATION,
        PetPanelRole::Popup => &POPUP_PANEL_GENERATION,
        PetPanelRole::Island => &ISLAND_PANEL_GENERATION,
    }
}

fn panel_open_intent(role: PetPanelRole) -> &'static AtomicBool {
    match role {
        PetPanelRole::Sprite => &SPRITE_PANEL_OPEN,
        PetPanelRole::Popup => &POPUP_PANEL_OPEN,
        PetPanelRole::Island => &ISLAND_PANEL_OPEN,
    }
}

fn panel_lifecycle(role: PetPanelRole) -> &'static Mutex<PanelLifecycle> {
    match role {
        PetPanelRole::Sprite => &SPRITE_PANEL_LIFECYCLE,
        PetPanelRole::Popup => &POPUP_PANEL_LIFECYCLE,
        PetPanelRole::Island => &ISLAND_PANEL_LIFECYCLE,
    }
}

pub(crate) struct PanelBuildGuard {
    role: PetPanelRole,
}

impl Drop for PanelBuildGuard {
    fn drop(&mut self) {
        let mut lifecycle = panel_lifecycle(self.role)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        lifecycle.in_flight_builds = lifecycle.in_flight_builds.saturating_sub(1);
    }
}

/// Atomically claim a build/re-show lifecycle unless destruction already owns
/// the label. This closes the gap between a caller checking `destroying` and a
/// builder becoming visible to Tauri's window manager.
pub(crate) fn try_begin_panel_build(role: PetPanelRole) -> Option<PanelBuildGuard> {
    let mut lifecycle = panel_lifecycle(role)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if lifecycle.destroying || lifecycle.in_flight_builds != 0 {
        return None;
    }
    lifecycle.in_flight_builds += 1;
    Some(PanelBuildGuard { role })
}

/// Start a new open lifecycle and invalidate work from every older lifecycle.
pub(crate) fn begin_panel_open(role: PetPanelRole) -> u64 {
    panel_open_intent(role).store(true, Ordering::SeqCst);
    panel_generation(role).fetch_add(1, Ordering::SeqCst) + 1
}

/// Cancel every queued reveal and mark the panel as intentionally hidden.
pub(crate) fn cancel_panel_reveal(role: PetPanelRole) -> u64 {
    panel_open_intent(role).store(false, Ordering::SeqCst);
    panel_generation(role).fetch_add(1, Ordering::SeqCst) + 1
}

/// Mark a label as closing before `WebviewWindow::close` queues its native
/// close event. New opens must wait until Tauri removes the old label from its
/// manager; otherwise they can reveal the doomed window and have it disappear
/// when the queued close event finally runs.
pub(crate) fn begin_panel_destroy(role: PetPanelRole) {
    panel_lifecycle(role)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .destroying = true;
    cancel_panel_reveal(role);
}

pub(crate) fn finish_panel_destroy(role: PetPanelRole) -> bool {
    let mut lifecycle = panel_lifecycle(role)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if lifecycle.in_flight_builds != 0 {
        return false;
    }
    lifecycle.destroying = false;
    true
}

pub(crate) fn panel_is_destroying(role: PetPanelRole) -> bool {
    panel_lifecycle(role)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .destroying
}

pub(crate) fn panel_has_in_flight_builds(role: PetPanelRole) -> bool {
    panel_lifecycle(role)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .in_flight_builds
        != 0
}

pub(crate) fn current_panel_generation(role: PetPanelRole) -> u64 {
    panel_generation(role).load(Ordering::SeqCst)
}

pub(crate) fn panel_generation_is_current(role: PetPanelRole, expected: u64) -> bool {
    !panel_is_destroying(role)
        && panel_open_intent(role).load(Ordering::SeqCst)
        && current_panel_generation(role) == expected
}

impl PetPanelRole {
    /// Whether this panel may become the key window. The sprite never does (it
    /// only displays); the popup and island must, or their text inputs can't
    /// be typed into.
    pub(crate) fn can_become_key(self) -> bool {
        matches!(self, PetPanelRole::Popup | PetPanelRole::Island)
    }

    /// NSWindow level for this role. Pure so the constants are pinned by
    /// cross-platform unit tests; the AppKit apply path is smoke-tested on a
    /// packaged `.app`. `i64` to match `Panel::set_level`.
    pub(crate) fn window_level(self) -> i64 {
        match self {
            // `NSFloatingWindowLevel` — above normal windows, below the menu bar.
            PetPanelRole::Sprite | PetPanelRole::Popup => 3,
            // `NSStatusWindowLevel` (25) — one above `NSMainMenuWindowLevel`
            // (24) so the top-hugging island draws over the menu bar instead
            // of hiding behind it.
            PetPanelRole::Island => 25,
        }
    }

    /// A desktop companion stays visible while another application is active.
    pub(crate) fn hides_on_deactivate(self) -> bool {
        false
    }

    /// Keep the overlay operable while Cognia itself owns a modal sheet.
    pub(crate) fn works_when_modal(self) -> bool {
        true
    }
}

/// NSWindow level a desktop pet floats at (`NSFloatingWindowLevel` == 3).
/// Kept as a named seam for the pet call sites; the role method above is the
/// single source of truth.
pub(crate) fn pet_panel_floating_level() -> i64 {
    PetPanelRole::Sprite.window_level()
}

/// The collection-behavior bitmask a desktop pet needs, for documentation +
/// pinning: `CanJoinAllSpaces(1) | Stationary(16) | IgnoresCycle(64) |
/// FullScreenAuxiliary(256) | CanJoinAllApplications(262144)`.
pub(crate) fn pet_collection_behavior_bits() -> u64 {
    (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8) | (1 << 18)
}

#[cfg(target_os = "macos")]
use tauri_nspanel::tauri_panel;

#[cfg(target_os = "macos")]
tauri_panel! {
    // Sprite: never key → fully non-activating.
    panel!(PetSpritePanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true,
            hides_on_deactivate: false,
            works_when_modal: true
        }
    })
    // Popup: may become key so the talk composer accepts typing, but the
    // non-activating style mask keeps it from activating the app.
    panel!(PetPopupPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true,
            hides_on_deactivate: false,
            works_when_modal: true
        }
    })
}

/// Run an AppKit operation synchronously. Tauri's `run_on_main_thread` only
/// enqueues work, so callers must wait for the result or a later close/destroy
/// can be overtaken by a stale reveal. The cancellation flag prevents a timed-
/// out task that has not started from mutating the window later.
#[cfg(target_os = "macos")]
fn run_on_appkit_thread<R, T, F>(
    window: &WebviewWindow<R>,
    operation_name: &'static str,
    operation: F,
) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    use objc2::MainThreadMarker;
    use std::sync::mpsc;
    use std::time::Duration;

    if MainThreadMarker::new().is_some() {
        return operation();
    }

    let (tx, rx) = mpsc::sync_channel(1);
    let pending = Arc::new(AtomicBool::new(true));
    let task_pending = Arc::clone(&pending);
    window
        .run_on_main_thread(move || {
            if !task_pending.swap(false, Ordering::SeqCst) {
                return;
            }
            let _ = tx.send(operation());
        })
        .map_err(|error| format!("pet: scheduling {operation_name} failed: {error}"))?;

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(error) => {
            pending.store(false, Ordering::SeqCst);
            Err(format!(
                "pet: {operation_name} main-thread task failed: {error}"
            ))
        }
    }
}

/// Reclass a freshly-built pet window into a non-activating NSPanel and apply the
/// float-over-everything collection behavior. macOS only; a no-op elsewhere.
#[cfg(target_os = "macos")]
pub(crate) fn apply_pet_panel_behavior<R: Runtime>(
    window: &WebviewWindow<R>,
    role: PetPanelRole,
) -> Result<(), String> {
    debug_assert!(objc2::MainThreadMarker::new().is_some());
    use objc2_app_kit::NSWindowCollectionBehavior;
    use tauri_nspanel::{CollectionBehavior, StyleMask, WebviewWindowExt};

    let behavior = CollectionBehavior::from_raw(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::CanJoinAllApplications,
    );
    // Borderless (empty) + non-activating so showing/keying never activates the app.
    let style = StyleMask::empty().nonactivating_panel();

    let panel = match role {
        PetPanelRole::Sprite => {
            debug_assert!(!role.can_become_key());
            window
                .to_panel::<PetSpritePanel<R>>()
                .map_err(|e| format!("pet sprite to_panel failed: {e:?}"))?
        }
        // The island shares the popup's panel class (key-capable,
        // non-activating); only its window level differs.
        PetPanelRole::Popup | PetPanelRole::Island => {
            debug_assert!(role.can_become_key());
            let panel = window
                .to_panel::<PetPopupPanel<R>>()
                .map_err(|e| format!("overlay panel to_panel failed: {e:?}"))?;
            // Buttons don't pull key; only the <input> does — non-activating throughout.
            panel.set_becomes_key_only_if_needed(true);
            panel
        }
    };
    panel.set_collection_behavior(behavior.into());
    panel.set_style_mask(style.into());
    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(role.hides_on_deactivate());
    panel.set_works_when_modal(role.works_when_modal());
    panel.set_released_when_closed(false);
    panel.set_has_shadow(false);
    panel.set_transparent(true);
    panel.set_opaque(false);
    // Set the level last: `setFloatingPanel:` can reset an NSPanel's level to
    // `NSFloatingWindowLevel`, which would leave the island (level 25,
    // NSStatusWindowLevel) drawing behind the menu bar instead of above it.
    panel.set_level(role.window_level());
    Ok(())
}

/// Convert a hidden webview to its NSPanel class and wait until AppKit has
/// applied the complete role policy. Callers can therefore close the window on
/// failure instead of returning success with a half-configured normal window.
#[cfg(target_os = "macos")]
pub(crate) fn configure_pet_panel<R: Runtime>(
    window: &WebviewWindow<R>,
    role: PetPanelRole,
) -> Result<(), String> {
    let win = window.clone();
    run_on_appkit_thread(window, "panel conversion", move || {
        apply_pet_panel_behavior(&win, role)
    })
}

/// Reveal through `NSPanel::orderFrontRegardless` so another active app never
/// suppresses the pet. If initial conversion is still queued or failed, retry
/// conversion and reveal together on the main thread.
#[cfg(target_os = "macos")]
pub(crate) fn reveal_pet_panel<R: Runtime>(
    window: &WebviewWindow<R>,
    role: PetPanelRole,
    focus: bool,
    expected_generation: u64,
) -> Result<(), String> {
    use tauri_nspanel::ManagerExt;

    let app = window.app_handle().clone();
    let win = window.clone();
    run_on_appkit_thread(window, "panel reveal", move || {
        if !panel_generation_is_current(role, expected_generation) {
            return Ok(());
        }
        let panel = match app.get_webview_panel(win.label()) {
            Ok(panel) => panel,
            Err(_) => {
                apply_pet_panel_behavior(&win, role)?;
                app.get_webview_panel(win.label()).map_err(|error| {
                    format!("pet: native panel missing after conversion: {error:?}")
                })?
            }
        };
        if !panel_generation_is_current(role, expected_generation) {
            return Ok(());
        }
        if focus {
            panel.show_and_make_key();
        } else {
            panel.show();
        }
        Ok(())
    })
}

/// Remove the retained tauri-nspanel manager entry and restore the original
/// NSWindow class before a webview is destroyed. Without this, recreating the
/// same label can retrieve and reveal the closed native panel.
#[cfg(target_os = "macos")]
pub(crate) fn detach_pet_panel<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    use tauri_nspanel::ManagerExt;

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    run_on_appkit_thread(window, "panel detach", move || {
        if let Ok(panel) = app.get_webview_panel(&label) {
            panel.hide();
            let _ = panel.to_window();
        }
        Ok(())
    })
}

/// Off macOS the builder flags already give the desired behavior — no-op.
#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_pet_panel_behavior<R: Runtime>(
    _window: &WebviewWindow<R>,
    role: PetPanelRole,
) -> Result<(), String> {
    let _ = role.can_become_key();
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn configure_pet_panel<R: Runtime>(
    window: &WebviewWindow<R>,
    role: PetPanelRole,
) -> Result<(), String> {
    apply_pet_panel_behavior(window, role)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn reveal_pet_panel<R: Runtime>(
    window: &WebviewWindow<R>,
    role: PetPanelRole,
    focus: bool,
    expected_generation: u64,
) -> Result<(), String> {
    if !panel_generation_is_current(role, expected_generation) {
        return Ok(());
    }
    window.show().map_err(|e| e.to_string())?;
    if focus {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn detach_pet_panel<R: Runtime>(_window: &WebviewWindow<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floating_level_is_ns_floating_window_level() {
        assert_eq!(pet_panel_floating_level(), 3);
        assert_eq!(PetPanelRole::Sprite.window_level(), 3);
        assert_eq!(PetPanelRole::Popup.window_level(), 3);
    }

    #[test]
    fn island_floats_above_the_menu_bar() {
        // NSStatusWindowLevel (25) > NSMainMenuWindowLevel (24): a strip at
        // the true top edge must draw over the menu bar, not behind it.
        assert_eq!(PetPanelRole::Island.window_level(), 25);
    }

    #[test]
    fn collection_behavior_is_all_spaces_stationary_fullscreen_aux() {
        // CanJoinAllSpaces(1) | Stationary(16) | IgnoresCycle(64) |
        // FullScreenAuxiliary(256) | CanJoinAllApplications(262144) == 262481.
        assert_eq!(pet_collection_behavior_bits(), 262_481);
    }

    #[test]
    fn only_text_input_roles_become_key() {
        assert!(!PetPanelRole::Sprite.can_become_key());
        assert!(PetPanelRole::Popup.can_become_key());
        assert!(PetPanelRole::Island.can_become_key());
    }

    #[test]
    fn overlay_roles_stay_visible_and_operable_when_the_app_deactivates() {
        for role in [
            PetPanelRole::Sprite,
            PetPanelRole::Popup,
            PetPanelRole::Island,
        ] {
            assert!(!role.hides_on_deactivate());
            assert!(role.works_when_modal());
        }
    }

    #[test]
    fn closing_a_panel_invalidates_queued_reveal_work() {
        let generation = begin_panel_open(PetPanelRole::Sprite);
        assert!(panel_generation_is_current(
            PetPanelRole::Sprite,
            generation
        ));

        cancel_panel_reveal(PetPanelRole::Sprite);
        assert!(!panel_generation_is_current(
            PetPanelRole::Sprite,
            generation
        ));
    }

    #[test]
    fn destroying_a_panel_blocks_new_reveal_work_until_removal_finishes() {
        let build = try_begin_panel_build(PetPanelRole::Popup).unwrap();
        assert!(try_begin_panel_build(PetPanelRole::Popup).is_none());
        let generation = begin_panel_open(PetPanelRole::Popup);
        begin_panel_destroy(PetPanelRole::Popup);
        assert!(panel_is_destroying(PetPanelRole::Popup));
        assert!(panel_has_in_flight_builds(PetPanelRole::Popup));
        assert!(!panel_generation_is_current(
            PetPanelRole::Popup,
            generation
        ));

        // Destroy owns the lifecycle atomically: no new builder may start, and
        // the gate cannot clear while the pre-existing builder is still live.
        assert!(try_begin_panel_build(PetPanelRole::Popup).is_none());
        assert!(!finish_panel_destroy(PetPanelRole::Popup));

        drop(build);
        assert!(!panel_has_in_flight_builds(PetPanelRole::Popup));
        assert!(finish_panel_destroy(PetPanelRole::Popup));
        let reopened_generation = begin_panel_open(PetPanelRole::Popup);
        assert!(panel_generation_is_current(
            PetPanelRole::Popup,
            reopened_generation
        ));
        cancel_panel_reveal(PetPanelRole::Popup);
    }
}
