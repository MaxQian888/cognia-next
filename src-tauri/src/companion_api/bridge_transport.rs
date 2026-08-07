//! `BridgeTransport` — the one seam the three companion bridges
//! (`sync_bridge`, `desktop_messages_bridge`, `desktop_writes_bridge`) use to
//! deliver a request frame to whichever process hosts the brain (ADR-0059 W1).
//!
//! Every bridge's only WebView coupling was a single `AppHandle.emit(channel,
//! payload)`. That collapses behind this trait:
//!
//!   - [`WebViewBridgeTransport`] — desktop, delegates to `AppHandle::emit`
//!     (today's behavior, byte-identical). The desktop WebView listens for the
//!     Tauri event and resolves the matching oneshot via its response command.
//!   - a socket implementation (ADR-0059 W3, added in a later slice) — the
//!     headless Node brain over `/internal/bridge`; the frame carries the SAME
//!     channel name + payload, so the TS listener code is shared between
//!     `listen()` (desktop) and WS frames (headless).
//!
//! The pending-map / oneshot / timeout machinery in each bridge is already
//! transport-agnostic and is untouched.

use serde_json::Value;

/// Delivers a bridge request frame on a named channel. `channel` is the
/// existing Tauri event name; `payload` is the existing event payload,
/// serialized to JSON (byte-identical to what `AppHandle::emit` sent).
pub trait BridgeTransport: Send + Sync + 'static {
    fn emit(&self, channel: &str, payload: Value) -> Result<(), String>;
    /// `"webview"` | `"socket"` — for logs and error strings.
    fn kind(&self) -> &'static str;
}

/// Desktop transport: emits a Tauri event the WebView is listening for.
pub struct WebViewBridgeTransport(pub tauri::AppHandle);

impl BridgeTransport for WebViewBridgeTransport {
    fn emit(&self, channel: &str, payload: Value) -> Result<(), String> {
        use tauri::Emitter;
        self.0
            .emit(channel, payload)
            .map_err(|e| format!("failed to emit {channel}: {e}"))
    }

    fn kind(&self) -> &'static str {
        "webview"
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::Arc;

    /// A `BridgeTransport` that records every emitted frame instead of touching
    /// a WebView. Used by the bridge unit tests to assert the on-the-wire
    /// channel + payload without an `AppHandle`.
    #[derive(Default)]
    pub struct RecordingBridgeTransport {
        pub emitted: Mutex<Vec<(String, Value)>>,
        fail: bool,
    }

    impl RecordingBridgeTransport {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        /// A transport whose `emit` always fails — exercises the pending-map
        /// cleanup path.
        pub fn failing() -> Arc<Self> {
            Arc::new(Self {
                emitted: Mutex::new(Vec::new()),
                fail: true,
            })
        }

        pub fn last(&self) -> Option<(String, Value)> {
            self.emitted.lock().last().cloned()
        }
    }

    impl BridgeTransport for RecordingBridgeTransport {
        fn emit(&self, channel: &str, payload: Value) -> Result<(), String> {
            if self.fail {
                return Err(format!("recording transport: forced failure on {channel}"));
            }
            self.emitted.lock().push((channel.to_string(), payload));
            Ok(())
        }

        fn kind(&self) -> &'static str {
            "recording"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::RecordingBridgeTransport;
    use super::*;
    use serde_json::json;

    #[test]
    fn recording_transport_captures_channel_and_payload() {
        let t = RecordingBridgeTransport::new();
        t.emit("companion://x", json!({ "a": 1 })).unwrap();
        let (channel, payload) = t.last().unwrap();
        assert_eq!(channel, "companion://x");
        assert_eq!(payload, json!({ "a": 1 }));
        assert_eq!(t.kind(), "recording");
    }

    #[test]
    fn failing_transport_returns_err() {
        let t = RecordingBridgeTransport::failing();
        assert!(t.emit("companion://x", json!({})).is_err());
        assert!(t.last().is_none());
    }
}
