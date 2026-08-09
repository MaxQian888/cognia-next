//! The Tauri-backed implementation of [`WasmHostServices`].
//!
//! This is the ONLY file in the WASM subtree that touches `tauri::AppHandle`.
//! Everything else — the capability modules, the linker, the bridge — works
//! against the traits in [`super`], which is what keeps the headless
//! `*_for_state` command path compiling and testable.
//!
//! Clipboard and notification are served **in-process**: both Tauri plugins are
//! already initialised by the app and already granted in
//! `src-tauri/capabilities/default.json`, so there is no reason to pay a
//! renderer round trip (and no reason for those two to fail when the WebView is
//! busy). Only AI and workflow genuinely need the renderer, because the
//! provider chain, the PII gate, and the workflow trigger registry live in TS.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

use super::super::bridge::{WasmBridgeTransport, WasmRendererBridge};
use super::super::capabilities::notification::{NotificationKind, PendingNotification};
use super::{ClipboardService, HostServiceError, NotificationService, WasmHostServices};

/// Emits bridge frames into the desktop WebView.
pub struct TauriWasmBridgeTransport(AppHandle);

impl TauriWasmBridgeTransport {
    pub fn new(app: AppHandle) -> Self {
        Self(app)
    }
}

impl WasmBridgeTransport for TauriWasmBridgeTransport {
    fn emit(&self, channel: &str, payload: Value) -> Result<(), String> {
        self.0
            .emit(channel, payload)
            .map_err(|e| format!("emit {channel}: {e}"))
    }

    fn kind(&self) -> &'static str {
        "webview"
    }
}

struct TauriClipboard(AppHandle);

impl ClipboardService for TauriClipboard {
    fn read_text(&self) -> Result<String, HostServiceError> {
        self.0
            .clipboard()
            .read_text()
            // The message is the OS/plugin error, never the clipboard contents.
            .map_err(|e| HostServiceError::provider(format!("clipboard read failed: {e}")))
    }

    fn write_text(&self, value: &str) -> Result<(), HostServiceError> {
        self.0
            .clipboard()
            .write_text(value.to_string())
            .map_err(|e| HostServiceError::provider(format!("clipboard write failed: {e}")))
    }
}

struct TauriNotifications(AppHandle);

impl NotificationService for TauriNotifications {
    fn notify(&self, pending: &PendingNotification) -> Result<(), HostServiceError> {
        let mut builder = self.0.notification().builder().title(&pending.title);
        if !pending.body.is_empty() {
            builder = builder.body(&pending.body);
        }
        builder.show().map_err(|e| {
            // v0.1 logged the title and body here at info level. That leak does
            // not come across the cutover: only the backend's own error text.
            HostServiceError::provider(format!(
                "notification ({}) failed: {e}",
                kind_label(pending.kind)
            ))
        })
    }
}

const fn kind_label(kind: NotificationKind) -> &'static str {
    match kind {
        NotificationKind::Info => "info",
        NotificationKind::Success => "success",
        NotificationKind::Warning => "warning",
        NotificationKind::Error => "error",
    }
}

/// The desktop host's full service set.
pub struct TauriWasmHostServices {
    clipboard: TauriClipboard,
    notifications: TauriNotifications,
    bridge: Arc<WasmRendererBridge>,
}

impl TauriWasmHostServices {
    pub fn new(app: AppHandle) -> Self {
        let bridge = WasmRendererBridge::new(Arc::new(TauriWasmBridgeTransport::new(app.clone())));
        Self {
            clipboard: TauriClipboard(app.clone()),
            notifications: TauriNotifications(app),
            bridge,
        }
    }

    /// The bridge this service set owns, so the response command can resolve
    /// into the same pending pool the host imports dispatch through.
    pub fn bridge(&self) -> Arc<WasmRendererBridge> {
        self.bridge.clone()
    }
}

impl WasmHostServices for TauriWasmHostServices {
    fn clipboard(&self) -> Option<&dyn ClipboardService> {
        Some(&self.clipboard)
    }

    fn notifications(&self) -> Option<&dyn NotificationService> {
        Some(&self.notifications)
    }

    fn renderer_bridge(&self) -> Option<Arc<WasmRendererBridge>> {
        Some(self.bridge.clone())
    }

    fn kind(&self) -> &'static str {
        "tauri"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_labels_cover_every_notification_kind() {
        assert_eq!(kind_label(NotificationKind::Info), "info");
        assert_eq!(kind_label(NotificationKind::Success), "success");
        assert_eq!(kind_label(NotificationKind::Warning), "warning");
        assert_eq!(kind_label(NotificationKind::Error), "error");
    }
}
