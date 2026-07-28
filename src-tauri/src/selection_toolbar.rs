//! System-wide text-selection toolbar.
//!
//! The coordinator is intentionally native: it observes passive OS input,
//! reads AX/UIA selections on the automation worker, and owns the transient
//! overlay window even while the main Cognia webview is hidden in the tray.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::automation::commands::AutomationState;
use crate::automation::input_monitor::{InputButton, InputEvent, InputSubscription};
use crate::automation::platform::shared::credential_window;
use crate::automation::selection::{build_text_selection, TextSelectionSnapshot};
use crate::automation::types::{Point, Rect};

pub const SELECTION_TOOLBAR_LABEL: &str = "selection-toolbar";
pub const SELECTION_CANDIDATE_EVENT: &str = "selection://candidate";
pub const SELECTION_DISMISS_EVENT: &str = "selection://dismiss";
pub const SELECTION_STAGE_EVENT: &str = "selection://stage";

const TOOLBAR_WIDTH: f64 = 360.0;
const TOOLBAR_HEIGHT: f64 = 44.0;
const TOOLBAR_MENU_HEIGHT: f64 = 280.0;
const EDGE_MARGIN: i32 = 8;
const IDLE_DISMISS_MS: u64 = 10_000;
const DEFAULT_BLOCKED_APPS: &[&str] = &[
    "1password",
    "authy",
    "bitwarden",
    "cognia",
    "dashlane",
    "keepass",
    "keychain access",
    "lastpass",
    "microsoft authenticator",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SelectionOrigin {
    Accessibility,
    Clipboard,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSelectionCandidate {
    pub id: String,
    pub text: String,
    pub source_app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_title: Option<String>,
    pub origin: SelectionOrigin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_rect: Option<Rect>,
    pub captured_at: i64,
    pub truncated: bool,
}

impl ExternalSelectionCandidate {
    fn from_snapshot(snapshot: TextSelectionSnapshot, origin: SelectionOrigin) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            text: snapshot.text,
            source_app: snapshot.source_app,
            source_title: snapshot.source_title,
            origin,
            anchor_rect: snapshot.anchor_rect,
            captured_at: chrono::Utc::now().timestamp_millis(),
            truncated: snapshot.truncated,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SelectionToolbarAction {
    Copy,
    Explain,
    Translate { target_locale: String },
    Ask,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionStagePayload {
    pub candidate: ExternalSelectionCandidate,
    pub action: SelectionToolbarAction,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelectionToolbarStartArgs {
    #[serde(default)]
    pub disabled_apps: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionToolbarStatus {
    pub running: bool,
    pub has_candidate: bool,
}

struct ActiveSelectionMonitor {
    _subscription: InputSubscription,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct SelectionToolbarInner {
    active: Mutex<Option<ActiveSelectionMonitor>>,
    candidate: Mutex<Option<ExternalSelectionCandidate>>,
    pending_stage: Mutex<Option<SelectionStagePayload>>,
    disabled_apps: Mutex<HashSet<String>>,
    generation: AtomicU64,
}

#[derive(Clone, Default)]
pub struct SelectionToolbarState {
    inner: Arc<SelectionToolbarInner>,
}

impl SelectionToolbarState {
    fn is_running(&self) -> bool {
        self.inner.active.lock().is_some()
    }

    fn status(&self) -> SelectionToolbarStatus {
        SelectionToolbarStatus {
            running: self.is_running(),
            has_candidate: self.inner.candidate.lock().is_some(),
        }
    }
}

#[tauri::command]
pub async fn selection_toolbar_start(
    app: AppHandle,
    automation: State<'_, AutomationState>,
    state: State<'_, SelectionToolbarState>,
    args: Option<SelectionToolbarStartArgs>,
) -> Result<SelectionToolbarStatus, String> {
    let args = args.unwrap_or_default();
    *state.inner.disabled_apps.lock() = args
        .disabled_apps
        .into_iter()
        .map(|app| app.to_lowercase())
        .collect();
    if state.is_running() {
        return Ok(state.status());
    }

    let mut subscription = automation.input_monitor.subscribe(128)?;
    let mut receiver = subscription.take_receiver();
    let coordinator = state.inner.clone();
    let automation_handle = automation.handle.clone();
    let app_handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                InputEvent::MouseUp {
                    x,
                    y,
                    button: InputButton::Left,
                    ..
                } => {
                    let generation = coordinator.generation.fetch_add(1, Ordering::SeqCst) + 1;
                    let coordinator = coordinator.clone();
                    let automation_handle = automation_handle.clone();
                    let app = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(60)).await;
                        let mut snapshot = read_accessibility_selection(&automation_handle).await;
                        if snapshot.is_none() {
                            tokio::time::sleep(Duration::from_millis(120)).await;
                            snapshot = read_accessibility_selection(&automation_handle).await;
                        }
                        if coordinator.generation.load(Ordering::SeqCst) != generation {
                            return;
                        }
                        let Some(mut snapshot) = snapshot else {
                            return;
                        };
                        if app_is_disabled(&coordinator, &snapshot.source_app) {
                            return;
                        }
                        if snapshot.anchor_rect.is_none() {
                            snapshot.anchor_rect = Some(Rect {
                                x,
                                y,
                                width: 1,
                                height: 1,
                            });
                        }
                        let candidate = ExternalSelectionCandidate::from_snapshot(
                            snapshot,
                            SelectionOrigin::Accessibility,
                        );
                        let _ = show_candidate(&app, &coordinator, candidate);
                    });
                }
                InputEvent::MouseDown { x, y, .. } => {
                    if !point_inside_toolbar(&app_handle, x, y) {
                        dismiss(&app_handle, &coordinator);
                    }
                }
                InputEvent::Scroll { .. } => dismiss(&app_handle, &coordinator),
                InputEvent::KeyDown { vk, .. } => {
                    let toolbar_focused = app_handle
                        .get_webview_window(SELECTION_TOOLBAR_LABEL)
                        .and_then(|window| window.is_focused().ok())
                        .unwrap_or(false);
                    if is_escape_key(vk) || !toolbar_focused {
                        dismiss(&app_handle, &coordinator);
                    }
                }
                _ => {}
            }
        }
    });

    *state.inner.active.lock() = Some(ActiveSelectionMonitor {
        _subscription: subscription,
        task,
    });
    Ok(state.status())
}

#[tauri::command]
pub async fn selection_toolbar_stop(
    app: AppHandle,
    automation: State<'_, AutomationState>,
    state: State<'_, SelectionToolbarState>,
) -> Result<SelectionToolbarStatus, String> {
    if let Some(active) = state.inner.active.lock().take() {
        active.task.abort();
        drop(active);
    }
    dismiss(&app, &state.inner);
    automation.input_monitor.stop_if_idle();
    Ok(state.status())
}

#[tauri::command]
pub async fn selection_toolbar_status(
    state: State<'_, SelectionToolbarState>,
) -> Result<SelectionToolbarStatus, String> {
    Ok(state.status())
}

#[tauri::command]
pub async fn selection_toolbar_current_candidate(
    state: State<'_, SelectionToolbarState>,
) -> Result<Option<ExternalSelectionCandidate>, String> {
    Ok(state.inner.candidate.lock().clone())
}

#[tauri::command]
pub async fn selection_toolbar_capture_clipboard(
    app: AppHandle,
) -> Result<Option<ExternalSelectionCandidate>, String> {
    capture_clipboard_candidate(&app).await
}

#[tauri::command]
pub async fn selection_toolbar_execute(
    app: AppHandle,
    state: State<'_, SelectionToolbarState>,
    candidate_id: String,
    action: SelectionToolbarAction,
) -> Result<(), String> {
    let candidate = state
        .inner
        .candidate
        .lock()
        .clone()
        .filter(|candidate| candidate.id == candidate_id)
        .ok_or_else(|| "selection candidate is stale".to_string())?;

    match action {
        SelectionToolbarAction::Copy => {
            app.clipboard()
                .write_text(candidate.text.clone())
                .map_err(|error| error.to_string())?;
        }
        action => {
            if let Some(main) = app.get_webview_window("main") {
                let payload = SelectionStagePayload { candidate, action };
                *state.inner.pending_stage.lock() = Some(payload.clone());
                crate::window_utils::bring_window_to_front(&main);
                main.emit(SELECTION_STAGE_EVENT, payload)
                    .map_err(|error| error.to_string())?;
            } else {
                return Err("main window is unavailable".into());
            }
        }
    }
    dismiss(&app, &state.inner);
    Ok(())
}

#[tauri::command]
pub async fn selection_toolbar_take_pending_stage(
    state: State<'_, SelectionToolbarState>,
) -> Result<Option<SelectionStagePayload>, String> {
    Ok(state.inner.pending_stage.lock().take())
}

#[tauri::command]
pub async fn selection_toolbar_reveal(window: WebviewWindow) -> Result<(), String> {
    if window.label() != SELECTION_TOOLBAR_LABEL {
        return Err("selection toolbar reveal called from wrong window".into());
    }
    window.show().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn selection_toolbar_set_interactive(
    app: AppHandle,
    state: State<'_, SelectionToolbarState>,
    window: WebviewWindow,
    interactive: bool,
) -> Result<(), String> {
    if window.label() != SELECTION_TOOLBAR_LABEL {
        return Err("selection toolbar focus called from wrong window".into());
    }
    #[cfg(target_os = "windows")]
    set_windows_interactive(&window, interactive)?;
    if interactive {
        let anchor = state
            .inner
            .candidate
            .lock()
            .as_ref()
            .and_then(|candidate| candidate.anchor_rect)
            .unwrap_or(Rect {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            });
        let (x, y) = toolbar_position(
            &app,
            anchor,
            TOOLBAR_WIDTH as i32,
            TOOLBAR_MENU_HEIGHT as i32,
        );
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
        window
            .set_size(LogicalSize::new(TOOLBAR_WIDTH, TOOLBAR_MENU_HEIGHT))
            .map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    } else {
        let anchor = state
            .inner
            .candidate
            .lock()
            .as_ref()
            .and_then(|candidate| candidate.anchor_rect);
        window
            .set_size(LogicalSize::new(TOOLBAR_WIDTH, TOOLBAR_HEIGHT))
            .map_err(|error| error.to_string())?;
        if let Some(anchor) = anchor {
            let (x, y) =
                toolbar_position(&app, anchor, TOOLBAR_WIDTH as i32, TOOLBAR_HEIGHT as i32);
            window
                .set_position(PhysicalPosition::new(x, y))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn spawn_clipboard_capture<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = capture_clipboard_candidate(&app).await {
            log::warn!("selection toolbar clipboard capture failed: {error}");
        }
    });
}

async fn capture_clipboard_candidate<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<ExternalSelectionCandidate>, String> {
    let state = app.state::<SelectionToolbarState>();
    if !state.is_running() {
        return Ok(None);
    }
    let text = app
        .clipboard()
        .read_text()
        .map_err(|error| error.to_string())?;
    let automation = app.state::<AutomationState>();
    let focus = automation.handle.get_focus().await.ok();
    let cursor = automation
        .handle
        .cursor_position()
        .await
        .unwrap_or(Point { x: 0, y: 0 });
    let source_app = focus
        .as_ref()
        .and_then(|focus| focus.process_name.as_deref())
        .unwrap_or("Clipboard");
    if app_is_disabled(&state.inner, source_app) {
        return Ok(None);
    }
    let snapshot = build_text_selection(
        &text,
        source_app,
        focus
            .as_ref()
            .and_then(|focus| focus.window_title.as_deref()),
        Some(Rect {
            x: cursor.x,
            y: cursor.y,
            width: 1,
            height: 1,
        }),
    );
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let candidate = ExternalSelectionCandidate::from_snapshot(snapshot, SelectionOrigin::Clipboard);
    show_candidate(app, &state.inner, candidate.clone())?;
    Ok(Some(candidate))
}

async fn read_accessibility_selection(
    automation: &crate::automation::worker::AutomationHandle,
) -> Option<TextSelectionSnapshot> {
    if credential_window::is_credential_window_focused() {
        return None;
    }
    automation.read_text_selection().await.ok().flatten()
}

fn app_is_disabled(inner: &SelectionToolbarInner, source_app: &str) -> bool {
    let normalized = source_app.to_lowercase();
    is_default_blocked_app(&normalized) || inner.disabled_apps.lock().contains(&normalized)
}

fn is_default_blocked_app(normalized_app: &str) -> bool {
    DEFAULT_BLOCKED_APPS
        .iter()
        .any(|blocked| normalized_app.contains(blocked))
}

fn is_escape_key(vk: u32) -> bool {
    #[cfg(target_os = "macos")]
    {
        // macOS CGKeyCode for Escape.
        vk == 53
    }
    #[cfg(target_os = "windows")]
    {
        // Windows VK_ESCAPE.
        vk == 0x1B
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = vk;
        false
    }
}

fn show_candidate<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    candidate: ExternalSelectionCandidate,
) -> Result<(), String> {
    let anchor = candidate.anchor_rect.unwrap_or(Rect {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
    });
    let window = ensure_window(app)?;
    let (x, y) = toolbar_position(app, anchor, TOOLBAR_WIDTH as i32, TOOLBAR_HEIGHT as i32);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    *inner.candidate.lock() = Some(candidate.clone());
    window
        .emit(SELECTION_CANDIDATE_EVENT, candidate.clone())
        .map_err(|error| error.to_string())?;

    let app = app.clone();
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(IDLE_DISMISS_MS)).await;
        let current_matches = inner
            .candidate
            .lock()
            .as_ref()
            .is_some_and(|current| current.id == candidate.id);
        if current_matches {
            dismiss(&app, &inner);
        }
    });
    Ok(())
}

fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        SELECTION_TOOLBAR_LABEL,
        WebviewUrl::App("selection-toolbar".into()),
    )
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .inner_size(TOOLBAR_WIDTH, TOOLBAR_HEIGHT)
    .build()
    .map_err(|error| error.to_string())?;
    let _ = window.remove_menu();

    #[cfg(target_os = "macos")]
    {
        let panel = window.clone();
        app.run_on_main_thread(move || {
            if let Err(error) = crate::pet_window::apply_overlay_panel_behavior(
                &panel,
                crate::pet_window::OverlayPanelRole::Popup,
            ) {
                log::warn!("selection toolbar NSPanel setup failed: {error}");
            }
        })
        .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    apply_windows_no_activate(&window)?;

    Ok(window)
}

#[cfg(target_os = "windows")]
fn apply_windows_no_activate(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let current = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
    let next = current | WS_EX_NOACTIVATE.0 as i32 | WS_EX_TOOLWINDOW.0 as i32;
    unsafe {
        SetWindowLongW(hwnd, GWL_EXSTYLE, next);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_windows_interactive(window: &WebviewWindow, interactive: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let current = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
    let next = if interactive {
        current & !(WS_EX_NOACTIVATE.0 as i32) | WS_EX_TOOLWINDOW.0 as i32
    } else {
        current | WS_EX_NOACTIVATE.0 as i32 | WS_EX_TOOLWINDOW.0 as i32
    };
    unsafe {
        SetWindowLongW(hwnd, GWL_EXSTYLE, next);
    }
    Ok(())
}

fn toolbar_position<R: Runtime>(
    app: &AppHandle<R>,
    anchor: Rect,
    width: i32,
    height: i32,
) -> (i32, i32) {
    let preferred_x = anchor.x + anchor.width / 2 - width / 2;
    let preferred_y = anchor.y - height - EDGE_MARGIN;
    let monitor = app
        .monitor_from_point(anchor.x as f64, anchor.y as f64)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return (preferred_x, preferred_y.max(EDGE_MARGIN));
    };
    let work = monitor.work_area();
    clamp_toolbar_position(
        preferred_x,
        preferred_y,
        anchor,
        width,
        height,
        (
            work.position.x,
            work.position.y,
            work.size.width as i32,
            work.size.height as i32,
        ),
    )
}

fn clamp_toolbar_position(
    preferred_x: i32,
    preferred_y: i32,
    anchor: Rect,
    width: i32,
    height: i32,
    work: (i32, i32, i32, i32),
) -> (i32, i32) {
    let (work_x, work_y, work_width, work_height) = work;
    let max_x = work_x + work_width - width - EDGE_MARGIN;
    let max_y = work_y + work_height - height - EDGE_MARGIN;
    let x = preferred_x.clamp(work_x + EDGE_MARGIN, max_x.max(work_x + EDGE_MARGIN));
    let above_fits = preferred_y >= work_y + EDGE_MARGIN;
    let desired_y = if above_fits {
        preferred_y
    } else {
        anchor.y + anchor.height + EDGE_MARGIN
    };
    let y = desired_y.clamp(work_y + EDGE_MARGIN, max_y.max(work_y + EDGE_MARGIN));
    (x, y)
}

fn point_inside_toolbar<R: Runtime>(app: &AppHandle<R>, x: i32, y: i32) -> bool {
    let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) else {
        return false;
    };
    if !window.is_visible().unwrap_or(false) {
        return false;
    }
    let Ok(position) = window.outer_position() else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    x >= position.x
        && y >= position.y
        && x < position.x + size.width as i32
        && y < position.y + size.height as i32
}

fn dismiss<R: Runtime>(app: &AppHandle<R>, inner: &Arc<SelectionToolbarInner>) {
    inner.generation.fetch_add(1, Ordering::SeqCst);
    *inner.candidate.lock() = None;
    if let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) {
        let _ = window.emit(SELECTION_DISMISS_EVENT, ());
        let _ = window.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placement_prefers_above_and_clamps_horizontally() {
        let position = clamp_toolbar_position(
            -150,
            120,
            Rect {
                x: 5,
                y: 172,
                width: 20,
                height: 18,
            },
            360,
            44,
            (0, 0, 1280, 720),
        );
        assert_eq!(position, (8, 120));
    }

    #[test]
    fn placement_moves_below_when_top_edge_has_no_room() {
        let position = clamp_toolbar_position(
            100,
            -20,
            Rect {
                x: 260,
                y: 12,
                width: 50,
                height: 20,
            },
            360,
            44,
            (0, 0, 1280, 720),
        );
        assert_eq!(position, (100, 40));
    }

    #[test]
    fn action_wire_shape_is_tagged_and_camel_case() {
        let action = SelectionToolbarAction::Translate {
            target_locale: "zh-CN".into(),
        };
        assert_eq!(
            serde_json::to_value(action).unwrap(),
            serde_json::json!({"kind": "translate", "targetLocale": "zh-CN"})
        );
    }

    #[test]
    fn default_sensitive_apps_are_blocked_without_user_configuration() {
        assert!(is_default_blocked_app("1password 8"));
        assert!(is_default_blocked_app("cognia"));
        assert!(is_default_blocked_app("bitwarden.exe"));
        assert!(!is_default_blocked_app("textedit"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recognizes_macos_escape_key() {
        assert!(is_escape_key(53));
        assert!(!is_escape_key(0x1B));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn recognizes_windows_escape_key() {
        assert!(is_escape_key(0x1B));
        assert!(!is_escape_key(53));
    }
}
