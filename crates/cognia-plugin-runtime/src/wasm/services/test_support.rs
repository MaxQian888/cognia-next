//! Recording doubles for the WASM host services and bridge transport.
//!
//! Mirrors `companion_api::bridge_transport::test_support::RecordingBridgeTransport`
//! so the two bridges are tested the same way. Compiled only under `cfg(test)`
//! within this crate; nothing here is reachable from a release build.

#![cfg(test)]

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;

use super::super::bridge::{WasmBridgeTransport, WasmRendererBridge};
use super::super::capabilities::notification::PendingNotification;
use super::super::errors::WasmErrorCode;
use super::{ClipboardService, HostServiceError, NotificationService, WasmHostServices};

/// Records every emitted frame instead of touching a WebView.
pub struct RecordingWasmBridgeTransport {
    frames: Mutex<Vec<(String, Value)>>,
    fail: bool,
}

impl RecordingWasmBridgeTransport {
    pub fn new() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
            fail: false,
        }
    }

    /// A transport whose `emit` always fails — the "renderer went away" case.
    pub fn failing() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
            fail: true,
        }
    }

    pub fn frames_for(&self, channel: &str) -> Vec<Value> {
        self.frames
            .lock()
            .iter()
            .filter(|(c, _)| c == channel)
            .map(|(_, v)| v.clone())
            .collect()
    }

    pub fn frame_count(&self) -> usize {
        self.frames.lock().len()
    }
}

impl Default for RecordingWasmBridgeTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmBridgeTransport for RecordingWasmBridgeTransport {
    fn emit(&self, channel: &str, payload: Value) -> Result<(), String> {
        if self.fail {
            return Err("recording transport is configured to fail".into());
        }
        self.frames.lock().push((channel.to_string(), payload));
        Ok(())
    }

    fn kind(&self) -> &'static str {
        "recording"
    }
}

#[derive(Default)]
pub struct RecordingClipboard {
    contents: Mutex<String>,
    writes: Mutex<Vec<String>>,
    fail: bool,
}

impl RecordingClipboard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_contents(text: impl Into<String>) -> Self {
        Self {
            contents: Mutex::new(text.into()),
            writes: Mutex::new(Vec::new()),
            fail: false,
        }
    }

    pub fn failing() -> Self {
        Self {
            contents: Mutex::new(String::new()),
            writes: Mutex::new(Vec::new()),
            fail: true,
        }
    }

    pub fn writes(&self) -> Vec<String> {
        self.writes.lock().clone()
    }
}

impl ClipboardService for RecordingClipboard {
    fn read_text(&self) -> Result<String, HostServiceError> {
        if self.fail {
            return Err(HostServiceError::provider("clipboard read failed"));
        }
        Ok(self.contents.lock().clone())
    }

    fn write_text(&self, value: &str) -> Result<(), HostServiceError> {
        if self.fail {
            return Err(HostServiceError::provider("clipboard write failed"));
        }
        *self.contents.lock() = value.to_string();
        self.writes.lock().push(value.to_string());
        Ok(())
    }
}

#[derive(Default)]
pub struct RecordingNotifications {
    sent: Mutex<Vec<PendingNotification>>,
    fail: bool,
}

impl RecordingNotifications {
    pub fn new() -> Self {
        Self::default()
    }

    /// The "OS refused / permission not granted" case.
    pub fn failing() -> Self {
        Self {
            sent: Mutex::new(Vec::new()),
            fail: true,
        }
    }

    pub fn sent(&self) -> Vec<PendingNotification> {
        self.sent.lock().clone()
    }
}

impl NotificationService for RecordingNotifications {
    fn notify(&self, pending: &PendingNotification) -> Result<(), HostServiceError> {
        if self.fail {
            return Err(HostServiceError::new(
                WasmErrorCode::ProviderError,
                "notification permission denied",
            ));
        }
        self.sent.lock().push(pending.clone());
        Ok(())
    }
}

/// A `WasmHostServices` whose surfaces are individually present or absent, so
/// tests can prove "one surface unavailable does not disable the others".
#[derive(Default)]
pub struct RecordingWasmHostServices {
    pub clipboard: Option<Arc<RecordingClipboard>>,
    pub notifications: Option<Arc<RecordingNotifications>>,
    pub bridge: Option<Arc<WasmRendererBridge>>,
}

impl RecordingWasmHostServices {
    /// Nothing available — the headless posture.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Every surface available.
    pub fn full() -> Self {
        Self {
            clipboard: Some(Arc::new(RecordingClipboard::new())),
            notifications: Some(Arc::new(RecordingNotifications::new())),
            bridge: Some(WasmRendererBridge::new(Arc::new(
                RecordingWasmBridgeTransport::new(),
            ))),
        }
    }

    pub fn with_clipboard(mut self, clipboard: Arc<RecordingClipboard>) -> Self {
        self.clipboard = Some(clipboard);
        self
    }

    pub fn with_notifications(mut self, notifications: Arc<RecordingNotifications>) -> Self {
        self.notifications = Some(notifications);
        self
    }

    pub fn with_bridge(mut self, bridge: Arc<WasmRendererBridge>) -> Self {
        self.bridge = Some(bridge);
        self
    }
}

impl WasmHostServices for RecordingWasmHostServices {
    fn clipboard(&self) -> Option<&dyn ClipboardService> {
        self.clipboard
            .as_ref()
            .map(|c| c.as_ref() as &dyn ClipboardService)
    }

    fn notifications(&self) -> Option<&dyn NotificationService> {
        self.notifications
            .as_ref()
            .map(|n| n.as_ref() as &dyn NotificationService)
    }

    fn renderer_bridge(&self) -> Option<Arc<WasmRendererBridge>> {
        self.bridge.clone()
    }

    fn kind(&self) -> &'static str {
        "recording"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recording_transport_captures_frames_per_channel() {
        let t = RecordingWasmBridgeTransport::new();
        t.emit("a", json!({ "n": 1 })).unwrap();
        t.emit("b", json!({ "n": 2 })).unwrap();
        t.emit("a", json!({ "n": 3 })).unwrap();

        assert_eq!(t.frame_count(), 3);
        assert_eq!(t.frames_for("a").len(), 2);
        assert_eq!(t.frames_for("b").len(), 1);
        assert_eq!(t.frames_for("missing").len(), 0);
    }

    #[test]
    fn failing_transport_records_nothing() {
        let t = RecordingWasmBridgeTransport::failing();
        assert!(t.emit("a", json!({})).is_err());
        assert_eq!(t.frame_count(), 0);
    }

    #[test]
    fn recording_clipboard_round_trips() {
        let c = RecordingClipboard::with_contents("seed");
        assert_eq!(c.read_text().unwrap(), "seed");
        c.write_text("next").unwrap();
        assert_eq!(c.read_text().unwrap(), "next");
        assert_eq!(c.writes(), vec!["next".to_string()]);
    }

    #[test]
    fn empty_services_report_every_surface_missing() {
        let s = RecordingWasmHostServices::empty();
        assert!(s.clipboard().is_none());
        assert!(s.notifications().is_none());
        assert!(s.renderer_bridge().is_none());
    }

    #[test]
    fn partial_services_leave_unrelated_surfaces_intact() {
        // The invariant the whole per-surface Option design exists to protect.
        let s = RecordingWasmHostServices::empty()
            .with_clipboard(Arc::new(RecordingClipboard::with_contents("x")));
        assert!(s.clipboard().is_some());
        assert!(s.notifications().is_none());
        assert!(s.renderer_bridge().is_none());
    }
}
