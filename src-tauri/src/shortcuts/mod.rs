//! Unified global-shortcut registry.
//!
//! Replaces the inline chord match block that used to live in
//! `lib.rs:142-194`. The renderer is still the source of truth (persisted
//! bindings in `cognia.store.json`), and pushes them to Rust via
//! `shortcut_bind` / `shortcut_unbind` IPC. Hot-keys fire from a single
//! `tauri_plugin_global_shortcut` handler that delegates to
//! `ShortcutRegistry::dispatch`.
//!
//! Built-in shortcut ids that come pre-seeded (renderer-overridable):
//!   - `tray.show`            → toggle main window
//!   - `tray.open-logs`       → emit `tray://open-logs`
//!   - `tray.automation-kill` → engage automation kill switch
//!
//! Anything bound through this registry — including new ids the renderer
//! invents — emits `shortcut://triggered { id }` so the renderer's unified
//! dispatcher (`lib/tray/dispatcher.ts`) can route them.

pub mod commands;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod registry;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use registry::ShortcutRegistry;

// Non-desktop stub so the `commands::*` module can still reference the type.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub struct ShortcutRegistry;

#[cfg(any(target_os = "android", target_os = "ios"))]
impl Default for ShortcutRegistry {
    fn default() -> Self {
        Self
    }
}
