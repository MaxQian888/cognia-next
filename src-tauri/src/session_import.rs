//! ADR-0067 Tier C facade — the OpenCode history reader moved to
//! [`cognia_agent_state::session_import`]; only the Tauri command shell stays
//! here, matching the `recovery` / `proxy_config` / `keyring_secrets` pattern.
//!
//! Keeping the shell app-side is what lets `cognia-agent-state` stay tauri-free
//! for `bin/cognia-server.rs` and for the ACP session registry that Batch 4
//! will path-dep onto it.

use serde_json::Value;

/// Read every OpenCode session from the local SQLite store. Returns [] when the
/// DB is absent or unreadable (never errors on a missing install).
#[tauri::command]
pub fn opencode_sessions_read(home: String) -> Result<Vec<Value>, String> {
    cognia_agent_state::session_import::read_opencode_sessions(home)
}
