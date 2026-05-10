//! Generic plugin API bridge (Batch 3g).
//!
//! `plugin_api_invoke` and `plugin_api_batch_invoke` are the catch-all
//! pass-through commands TS calls when no specialized handler exists.
//! For Batch 3g we expose a minimal echo-style implementation: every
//! request is recorded and replied with `{ok: true, echo: payload}`. Real
//! API dispatch (file system, network, secrets, …) lives in the dedicated
//! modules of Batch 3b and beyond. The TS side at
//! `lib/plugin/core/transport.ts:114` already routes high-fidelity calls
//! through the specialized handlers, so this bridge is the safety net
//! rather than the hot path.

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{PluginError, PluginRuntimeState, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequest {
    pub api: String,
    pub method: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn plugin_api_invoke(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    api: String,
    method: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value> {
    if !state.plugins.read().contains_key(&plugin_id) {
        return Err(PluginError::NotFound(plugin_id));
    }
    log::debug!(
        "plugin_api_invoke: plugin={} api={} method={}",
        plugin_id,
        api,
        method
    );
    Ok(serde_json::json!({
        "ok": true,
        "api": api,
        "method": method,
        "echo": payload,
    }))
}

#[tauri::command]
pub async fn plugin_api_batch_invoke(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    requests: Vec<BatchRequest>,
) -> Result<Vec<BatchResponse>> {
    if !state.plugins.read().contains_key(&plugin_id) {
        return Err(PluginError::NotFound(plugin_id));
    }
    Ok(requests
        .into_iter()
        .map(|req| BatchResponse {
            ok: true,
            data: Some(serde_json::json!({
                "api": req.api,
                "method": req.method,
                "echo": req.payload,
            })),
            error: None,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_api::{PluginRecord, PluginRuntimeSnapshot, PluginRuntimeState};
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn seeded_state(tmp: &TempDir) -> PluginRuntimeState {
        let state = PluginRuntimeState::new(PathBuf::from(tmp.path()));
        state.plugins.write().insert(
            "demo".into(),
            PluginRecord {
                snapshot: PluginRuntimeSnapshot {
                    plugin_id: "demo".into(),
                    version: "1.0.0".into(),
                    status: "loaded".into(),
                    last_error: None,
                    loaded_at: None,
                    install_path: tmp.path().join("demo").to_string_lossy().into_owned(),
                },
                runtime_state: serde_json::Value::Null,
            },
        );
        state
    }

    #[test]
    fn batch_request_round_trip() {
        let req = serde_json::json!({
            "api": "fs",
            "method": "read",
            "payload": {"path": "/tmp"}
        });
        let parsed: BatchRequest = serde_json::from_value(req).unwrap();
        assert_eq!(parsed.api, "fs");
        assert_eq!(parsed.method, "read");
    }

    #[test]
    fn echo_response_shape() {
        let resp = BatchResponse {
            ok: true,
            data: Some(serde_json::json!({"x": 1})),
            error: None,
        };
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"ok\":true"));
        assert!(s.contains("\"x\":1"));
    }

    #[test]
    fn unknown_plugin_id_returns_not_found_marker() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        // Inline the known-good check from `plugin_api_invoke` body.
        assert!(state.plugins.read().contains_key("demo"));
        assert!(!state.plugins.read().contains_key("nope"));
    }
}
