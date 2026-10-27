//! Platform-aware tray icons: macOS templates follow the menu bar appearance;
//! other desktops retain the character artwork and colored status/usage badges.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{image::Image, AppHandle, Manager, Runtime};

use super::dto::TrayIconState;

pub const ICON_AS_TEMPLATE: bool = cfg!(target_os = "macos");

#[cfg(target_os = "macos")]
fn macos_template_icon() -> Result<Image<'static>, String> {
    Image::from_bytes(include_bytes!("../../icons/tray-template.png"))
        .map(Image::to_owned)
        .map_err(|e| format!("decode macOS tray template: {e}"))
}

/// Shared mutable handle to the current icon state plus the renderer-pushed
/// PNG buffers keyed by state. Lives in `app.manage(...)` so commands can
/// poke it from any thread.
#[derive(Default)]
pub struct TrayIconStateStore {
    inner: Mutex<TrayIconStateInner>,
}

#[derive(Default)]
struct TrayIconStateInner {
    current: TrayIconState,
    /// Renderer-rendered PNG bytes for each state. The renderer pushes
    /// these once at boot via `tray_register_icon`; `apply()` reads from
    /// here before falling back to the platform's bootstrap icon.
    rasters: HashMap<TrayIconState, Arc<Vec<u8>>>,
}

impl TrayIconStateStore {
    pub fn current(&self) -> TrayIconState {
        self.inner.lock().current
    }

    pub fn set(&self, state: TrayIconState) {
        self.inner.lock().current = state;
    }

    /// Store renderer-rendered PNG bytes for `state`. The buffer is wrapped
    /// in `Arc` so `apply()` can drop the lock before decoding the image.
    pub fn register_raster(&self, state: TrayIconState, png_bytes: Vec<u8>) {
        self.inner.lock().rasters.insert(state, Arc::new(png_bytes));
    }

    pub fn raster_for(&self, state: TrayIconState) -> Option<Arc<Vec<u8>>> {
        self.inner.lock().rasters.get(&state).cloned()
    }
}

/// Apply `state` to the main tray icon. Resolution order:
///   1. Renderer-rendered PNG bytes pushed via `tray_register_icon` (the
///      see `lib/tray/icon-builder.ts`).
///   2. Embedded template on macOS, including before renderer startup.
///   3. Built-in resource path `icons/tray/<state>.png` on other desktops.
///   4. Default window icon as a last-resort fallback on other desktops.
///
/// Set the image and template flag atomically to avoid a full-color flash
/// during swaps. AppKit owns light/dark and highlighted template rendering.
pub fn apply<R: Runtime>(app: &AppHandle<R>, state: TrayIconState) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "main-tray icon not registered".to_string())?;
    let image = load_image_for(app, state)?;
    tray.set_icon_with_as_template(Some(image), ICON_AS_TEMPLATE)
        .map_err(|e| format!("set_icon failed: {e}"))?;

    if let Some(store) = app.try_state::<Arc<TrayIconStateStore>>() {
        store.set(state);
    }
    Ok(())
}

/// Dispatch [`apply`] to the main thread. `apply` touches AppKit
/// (`NSStatusItem` icon swap; dropping the `tray_by_id` handle can tear down
/// the old status item), and AppKit traps (EXC_BREAKPOINT in
/// `removeStatusItem`) when that runs off-main — which is exactly where async
/// Tauri commands execute (tokio workers). Fire-and-forget: apply errors are
/// logged, not returned, since the caller can't await the main loop anyway.
pub fn apply_on_main<R: Runtime>(app: &AppHandle<R>, state: TrayIconState) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = apply(&handle, state) {
            log::warn!("tray: applying icon state failed: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

pub(super) fn load_image_for<R: Runtime>(
    app: &AppHandle<R>,
    state: TrayIconState,
) -> Result<Image<'static>, String> {
    // 1) Renderer-pushed platform-specific PNG bytes. Decode via
    //    `Image::from_bytes` which the project already enables through the
    //    `image-png` feature on `tauri`.
    if let Some(store) = app.try_state::<Arc<TrayIconStateStore>>() {
        if let Some(bytes) = store.raster_for(state) {
            return Image::from_bytes(bytes.as_slice())
                .map(Image::to_owned)
                .map_err(|e| format!("decode renderer-rendered tray icon: {e}"));
        }
    }

    #[cfg(target_os = "macos")]
    return macos_template_icon();

    #[cfg(not(target_os = "macos"))]
    {
        // 2) Bundled asset path: `<resource>/icons/tray/<state>.png`. Still
        //    useful for installs that pre-ship rasters; lives next to existing
        //    Tauri resources.
        let file = match state {
            TrayIconState::Idle => "icons/tray/idle.png",
            TrayIconState::Busy => "icons/tray/busy.png",
            TrayIconState::Error => "icons/tray/error.png",
            TrayIconState::Muted => "icons/tray/muted.png",
        };
        if let Ok(resolved) = app
            .path()
            .resolve(file, tauri::path::BaseDirectory::Resource)
        {
            if resolved.exists() {
                return Image::from_path(&resolved)
                    .map(Image::to_owned)
                    .map_err(|e| format!("load tray icon {file}: {e}"));
            }
        }

        // 3) Last-resort fallback: app's default window icon.
        let icon = app
            .default_window_icon()
            .ok_or_else(|| "no default window icon available".to_string())?;
        Ok(icon.clone().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_macos_character_retains_its_color_artwork() {
        let image = Image::from_bytes(include_bytes!("../../icons/128x128.png")).unwrap();
        assert!(image
            .rgba()
            .chunks_exact(4)
            .any(|pixel| { pixel[3] > 0 && (pixel[0] != pixel[1] || pixel[1] != pixel[2]) }));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn bootstrap_template_has_visible_strokes_and_transparent_interior() {
        let image = macos_template_icon().unwrap();
        assert_eq!((image.width(), image.height()), (36, 36));
        let pixels = image.rgba();
        assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] == 255));
        assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] == 0));
        assert!(pixels
            .chunks_exact(4)
            .filter(|p| p[3] > 0)
            .all(|p| p[..3] == [0, 0, 0]));
        // A filled square/character silhouette would have opaque center alpha.
        assert_eq!(pixels[(18 * 36 + 18) * 4 + 3], 0);
    }

    #[test]
    fn icon_state_store_round_trips_each_variant() {
        let store = TrayIconStateStore::default();
        assert_eq!(store.current(), TrayIconState::Idle);
        for state in [
            TrayIconState::Busy,
            TrayIconState::Error,
            TrayIconState::Muted,
            TrayIconState::Idle,
        ] {
            store.set(state);
            assert_eq!(store.current(), state);
        }
    }

    #[test]
    fn default_state_is_idle() {
        let store = TrayIconStateStore::default();
        assert!(matches!(store.current(), TrayIconState::Idle));
    }
}
