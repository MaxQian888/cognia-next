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

// `Manager` is required in scope: the `tauri_panel!`-generated `from_window`
// calls `window.app_handle()` (a `Manager` method) when it reclasses the window.
use tauri::{Manager, Runtime, WebviewWindow};

/// Which pet window is being converted — decides the key-window policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PetPanelRole {
    /// The transparent sprite: never becomes key (fully non-activating).
    Sprite,
    /// The click popup: may become key so its text input accepts typing.
    Popup,
}

impl PetPanelRole {
    /// Whether this panel may become the key window. The sprite never does (it
    /// only displays); the popup must, or its talk composer can't be typed into.
    pub(crate) fn can_become_key(self) -> bool {
        matches!(self, PetPanelRole::Popup)
    }
}

/// NSWindow level a desktop pet floats at (`NSFloatingWindowLevel` == 3). Pure so
/// the constant is pinned by a cross-platform unit test; the AppKit apply path is
/// smoke-tested on a packaged `.app`. `i64` to match `Panel::set_level`.
pub(crate) fn pet_panel_floating_level() -> i64 {
    3
}

/// The collection-behavior bitmask a desktop pet needs, for documentation +
/// pinning: `CanJoinAllSpaces(1) | Stationary(16) | FullScreenAuxiliary(256)`.
/// The macOS path constructs the equivalent via `tauri-nspanel`'s builder.
pub(crate) fn pet_collection_behavior_bits() -> u64 {
    (1 << 0) | (1 << 4) | (1 << 8)
}

#[cfg(target_os = "macos")]
use tauri_nspanel::tauri_panel;

#[cfg(target_os = "macos")]
tauri_panel! {
    // Sprite: never key → fully non-activating.
    panel!(PetSpritePanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
    // Popup: may become key so the talk composer accepts typing, but the
    // non-activating style mask keeps it from activating the app.
    panel!(PetPopupPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
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
    use tauri_nspanel::{CollectionBehavior, StyleMask, WebviewWindowExt};

    let behavior = CollectionBehavior::new()
        .can_join_all_spaces()
        .stationary()
        .full_screen_auxiliary();
    // Borderless (empty) + non-activating so showing/keying never activates the app.
    let style = StyleMask::empty().nonactivating_panel();

    match role {
        PetPanelRole::Sprite => {
            debug_assert!(!role.can_become_key());
            let panel = window
                .to_panel::<PetSpritePanel<R>>()
                .map_err(|e| format!("pet sprite to_panel failed: {e:?}"))?;
            panel.set_level(pet_panel_floating_level());
            panel.set_collection_behavior(behavior.into());
            panel.set_style_mask(style.into());
        }
        PetPanelRole::Popup => {
            debug_assert!(role.can_become_key());
            let panel = window
                .to_panel::<PetPopupPanel<R>>()
                .map_err(|e| format!("pet popup to_panel failed: {e:?}"))?;
            panel.set_level(pet_panel_floating_level());
            panel.set_collection_behavior(behavior.into());
            // Buttons don't pull key; only the <input> does — non-activating throughout.
            panel.set_becomes_key_only_if_needed(true);
            panel.set_style_mask(style.into());
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floating_level_is_ns_floating_window_level() {
        assert_eq!(pet_panel_floating_level(), 3);
    }

    #[test]
    fn collection_behavior_is_all_spaces_stationary_fullscreen_aux() {
        // CanJoinAllSpaces(1) | Stationary(16) | FullScreenAuxiliary(256) == 273.
        assert_eq!(pet_collection_behavior_bits(), 273);
    }

    #[test]
    fn only_the_popup_becomes_key() {
        assert!(!PetPanelRole::Sprite.can_become_key());
        assert!(PetPanelRole::Popup.can_become_key());
    }
}
