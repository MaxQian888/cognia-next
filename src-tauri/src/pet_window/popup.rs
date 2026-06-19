//! Desktop-pet click popup ("分小窗口") — a dedicated small window for the pet's
//! interaction panel + quick actions, separate from the transparent sprite
//! window (label `"pet"`).
//!
//! Why a separate window: the sprite window used to *grow* to make room for the
//! right-click menu and then shift itself up — that resize/reposition raced the
//! menu's pointer anchor and the wander/throw position writes, so the popup
//! jittered and the menu clipped at the window edge. A dedicated OS window
//! (label `"pet-popup"`) renders the panel at its natural size (never clipped),
//! and the sprite window stops resizing entirely (the races are gone).
//!
//! Stability comes from native blur-to-close: the popup is created `focused`,
//! and an `on_window_event` handler hides it on `WindowEvent::Focused(false)`,
//! so clicking anywhere else dismisses it exactly like a system context menu.
//!
//! Placement is computed renderer-side (`lib/pet/popup-geometry.ts`) from the
//! sprite window position + work area, and passed in as already-physical,
//! already-clamped `x`/`y`. Like `mod.rs`, only the serde shape is unit-tested
//! here; the live window ops are smoke-tested via `pnpm tauri dev`.

use serde::Deserialize;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WindowEvent};

/// Window label of the click popup. Kept in sync with `lib/pet/window-role.ts`
/// (`PET_POPUP_WINDOW_LABEL`) so the popup webview resolves the "popup" role and
/// `PetMount` contributes nothing there.
pub(crate) const PET_POPUP_LABEL: &str = "pet-popup";

/// Options the renderer passes when opening / re-showing the popup window.
/// Mirrors the TS wrapper in `lib/tauri/pet-window.ts`. `width`/`height` are
/// logical; `x`/`y` are physical (already clamped on-screen by the renderer).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPopupOpts {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
}

/// Hide the popup window (toggle / blur). Cheap to re-show, so we hide rather
/// than destroy. Generic so `mod.rs` (also generic over runtime) can reuse it
/// when the sprite window is hidden or destroyed.
pub(crate) fn close_pet_popup_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_POPUP_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open (or show + reposition + focus, if it already exists) the popup window.
/// On first create it is frameless, transparent, always-on-top, skip-taskbar,
/// non-resizable, and `focused` (so the blur-to-close handler fires).
#[tauri::command]
pub async fn open_pet_popup(app: AppHandle, opts: PetPopupOpts) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_POPUP_LABEL) {
        window
            .set_size(LogicalSize::new(opts.width, opts.height))
            .map_err(|e| e.to_string())?;
        window
            .set_position(PhysicalPosition::new(opts.x, opts.y))
            .map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        &app,
        PET_POPUP_LABEL,
        tauri::WebviewUrl::App("pet-popup".into()),
    )
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(true)
    .visible(false)
    .inner_size(opts.width, opts.height)
    .build()
    .map_err(|e| e.to_string())?;

    window
        .set_position(PhysicalPosition::new(opts.x, opts.y))
        .map_err(|e| e.to_string())?;

    // Native blur-to-close: clicking outside the popup (it loses focus) hides
    // it, mirroring a system context menu. Scoped to this window — no global
    // event handler needed. Re-look-up by label so the closure owns no window
    // handle (avoids a self-referential capture).
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(false)) {
            if let Some(w) = app_handle.get_webview_window(PET_POPUP_LABEL) {
                let _ = w.hide();
            }
        }
    });

    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

/// Hide the popup window (renderer Esc / explicit close action).
#[tauri::command]
pub async fn close_pet_popup(app: AppHandle) -> Result<(), String> {
    close_pet_popup_inner(&app)
}

/// Resize the popup's inner content area to fit its panel (the talk composer
/// expands/collapses). Logical pixels.
#[tauri::command]
pub async fn pet_popup_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_POPUP_LABEL) {
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opts_deserializes_camel_case_payload() {
        let opts: PetPopupOpts =
            serde_json::from_str(r#"{"width":288,"height":360,"x":1200,"y":640}"#).unwrap();
        assert_eq!(opts.width, 288.0);
        assert_eq!(opts.height, 360.0);
        assert_eq!(opts.x, 1200.0);
        assert_eq!(opts.y, 640.0);
    }

    #[test]
    fn opts_rejects_missing_required_field() {
        // Unlike the sprite window's opts, x/y are required (the renderer always
        // computes placement) — a missing field is a hard error, not a default.
        let res: Result<PetPopupOpts, _> = serde_json::from_str(r#"{"width":288,"height":360}"#);
        assert!(res.is_err());
    }

    #[test]
    fn label_matches_renderer_contract() {
        // Must stay in lockstep with `lib/pet/window-role.ts` PET_POPUP_WINDOW_LABEL.
        assert_eq!(PET_POPUP_LABEL, "pet-popup");
    }
}
