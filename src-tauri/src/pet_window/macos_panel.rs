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

/// Reclass a freshly-built pet window into a non-activating NSPanel and apply the
/// float-over-everything collection behavior. macOS only; a no-op elsewhere.
#[cfg(target_os = "macos")]
pub(crate) fn apply_pet_panel_behavior<R: Runtime>(
    window: &WebviewWindow<R>,
    role: PetPanelRole,
) -> Result<(), String> {
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
    panel.set_level(role.window_level());
    panel.set_collection_behavior(behavior.into());
    panel.set_style_mask(style.into());
    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(role.hides_on_deactivate());
    panel.set_works_when_modal(role.works_when_modal());
    panel.set_released_when_closed(false);
    panel.set_has_shadow(false);
    panel.set_transparent(true);
    panel.set_opaque(false);
    Ok(())
}

/// Reveal through `NSPanel::orderFrontRegardless` so another active app never
/// suppresses the pet. If initial conversion is still queued or failed, retry
/// conversion and reveal together on the main thread.
#[cfg(target_os = "macos")]
pub(crate) fn reveal_pet_panel<R: Runtime>(
    window: &WebviewWindow<R>,
    role: PetPanelRole,
    focus: bool,
) -> Result<(), String> {
    use tauri_nspanel::ManagerExt;

    let app = window.app_handle().clone();
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let panel = app.get_webview_panel(win.label()).ok().or_else(|| {
                if let Err(error) = apply_pet_panel_behavior(&win, role) {
                    log::error!("pet: native panel conversion retry failed: {error}");
                    return None;
                }
                app.get_webview_panel(win.label()).ok()
            });
            match panel {
                Some(panel) if focus => panel.show_and_make_key(),
                Some(panel) => panel.show(),
                None => {
                    log::error!("pet: native panel reveal failed after conversion retry");
                    let _ = win.show();
                    if focus {
                        let _ = win.set_focus();
                    }
                }
            }
        })
        .map_err(|e| e.to_string())
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
pub(crate) fn reveal_pet_panel<R: Runtime>(
    window: &WebviewWindow<R>,
    _role: PetPanelRole,
    focus: bool,
) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    if focus {
        window.set_focus().map_err(|e| e.to_string())?;
    }
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
}
