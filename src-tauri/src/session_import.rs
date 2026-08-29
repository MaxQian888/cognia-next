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

/// Read-only SQLite projection for Cursor, Cline, and Copilot CLI histories.
#[tauri::command]
pub fn external_agent_sessions_read(source: String, home: String) -> Result<Vec<Value>, String> {
    let actual_home =
        dirs::home_dir().ok_or_else(|| "user home directory unavailable".to_string())?;
    if std::path::PathBuf::from(&home) != actual_home {
        return Err("external session store root must match the current user home".into());
    }
    cognia_agent_state::session_import::read_external_agent_sessions(source, home)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command shell is the only thing left in this module, so the thing
    /// worth pinning is that it still forwards to the extracted reader
    /// (ADR-0067 Tier C) and preserves its never-error-on-missing-install
    /// contract.
    #[test]
    fn command_forwards_to_the_extracted_reader_and_tolerates_a_missing_install() {
        let out = opencode_sessions_read("/nonexistent-home-xyz".to_string())
            .expect("a missing OpenCode install must not be an error");
        assert!(out.is_empty());
    }

    #[test]
    fn external_store_command_rejects_renderer_supplied_roots() {
        let error = external_agent_sessions_read("cursor".into(), "/nonexistent-home-xyz".into())
            .unwrap_err();
        assert!(error.contains("current user home"));
    }
}
