//! Tauri command surface for the A2UI bridge.
//!
//! Exposes the absolute paths the renderer needs at projection time:
//!   - `sidecar_dir`: resolves the bundled `sidecar/` directory so the
//!     a2ui-bridge MCP row's `${COGNIA_SIDECAR_DIR}` placeholder can be
//!     rewritten to an absolute argv before being written into an external
//!     agent's config file.
//!   - `socket_path`: the Unix domain socket / Windows named pipe the bridge
//!     listener accepts on. Injected as `COGNIA_BRIDGE_SOCKET` env on the
//!     a2ui-bridge MCP row so the spawned `sidecar/a2ui-mcp.mjs` knows where
//!     to send dispatches back to.

use serde::Serialize;
use tauri::AppHandle;

use crate::claude::sidecar::sidecar_dir;

#[derive(Debug, Serialize)]
pub struct RuntimePaths {
    pub sidecar_dir: String,
    pub socket_path: String,
}

#[tauri::command]
pub async fn a2ui_bridge_runtime_paths(app: AppHandle) -> Result<RuntimePaths, String> {
    let dir = sidecar_dir(&app)?;
    let sock = super::socket_path(&app)
        .ok_or_else(|| "could not resolve a2ui bridge socket path".to_string())?;
    Ok(RuntimePaths {
        sidecar_dir: dir.to_string_lossy().to_string(),
        socket_path: sock.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_paths_serialize_uses_snake_case_keys() {
        // The TypeScript wrapper translates snake_case → camelCase. If the
        // serde rename ever drifts, the wrapper would silently end up with
        // `undefined` for both fields, so pin the wire shape here.
        let paths = RuntimePaths {
            sidecar_dir: "/abs/sidecar".to_string(),
            socket_path: "/abs/sock".to_string(),
        };
        let json = serde_json::to_value(&paths).expect("serializes");
        assert_eq!(json["sidecar_dir"], "/abs/sidecar");
        assert_eq!(json["socket_path"], "/abs/sock");
    }
}
