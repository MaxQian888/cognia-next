//! Renderer-facing notification events for the Python runtime.
//!
//! Un-correlated frames on a host's stdout (`{"type":"event",...}`) and
//! stderr log lines are projected into one app-global Tauri event,
//! [`PYTHON_EVENT`], consumed by `lib/plugin/core/manager.ts`. Emission
//! goes through the [`EventSink`] indirection so protocol code stays unit
//! testable without fabricating an `AppHandle` (tests inject a collector).

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

/// Single app-global event channel for all python plugin notifications.
pub const PYTHON_EVENT: &str = "plugin:python";

/// Payload of a [`PYTHON_EVENT`] emission. `kind` mirrors the host frame's
/// `event` field: `log` | `progress` | `chunk` | `chunk_end` | `exit`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonEvent {
    pub plugin_id: String,
    pub generation: String,
    pub kind: String,
    /// Correlates `chunk`/`chunk_end` frames to an in-flight request id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<u64>,
    pub data: Value,
}

/// Where python events go. Production: [`tauri_sink`]. Tests: a collector.
pub type EventSink = Arc<dyn Fn(PythonEvent) + Send + Sync>;

/// Production sink: forward to the renderer via `app.emit` (mirrors the
/// sidecar event pattern in `claude/sidecar.rs`).
pub fn tauri_sink(app: tauri::AppHandle) -> EventSink {
    use tauri::Emitter;
    Arc::new(move |event| {
        if let Err(e) = app.emit(PYTHON_EVENT, &event) {
            log::warn!("[python.{}] event emit failed: {e}", event.plugin_id);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_serializes_camel_case_and_omits_absent_call_id() {
        let event = PythonEvent {
            plugin_id: "demo".into(),
            generation: "gen-1".into(),
            kind: "log".into(),
            call_id: None,
            data: serde_json::json!({"line": "hi"}),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["pluginId"], "demo");
        assert_eq!(json["generation"], "gen-1");
        assert_eq!(json["kind"], "log");
        assert!(json.get("callId").is_none());
        assert_eq!(json["data"]["line"], "hi");
    }

    #[test]
    fn event_serializes_call_id_when_present() {
        let event = PythonEvent {
            plugin_id: "demo".into(),
            generation: "gen-1".into(),
            kind: "chunk".into(),
            call_id: Some(7),
            data: Value::String("partial".into()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["callId"], 7);
    }
}
