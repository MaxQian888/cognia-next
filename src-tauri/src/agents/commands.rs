// Tauri commands exposed to the frontend for multi-agent MCP IO.
//
//   read_agent_config(agent)            -> { path, exists, raw, parsed, parseError? }
//   write_agent_config(agent, value)    -> { path, backupPath? }
//   agent_vendor_roots()                -> { claudeConfigDir, codexHome, ... }

use serde::{Deserialize, Serialize};

use super::io::{read_file, write_file};
use super::paths::{spec_for, vendor_roots, VendorRoots};

#[derive(Debug, Serialize, Deserialize)]
pub struct AgentReadResult {
    /// Resolved path on this OS, or null when the agent isn't supported here.
    pub path: Option<String>,
    pub exists: bool,
    pub writable: bool,
    pub format: String,
    pub raw: String,
    /// Parsed canonical JSON tree. `null` when missing / unparseable.
    pub parsed: serde_json::Value,
    /// Filled in when the file existed but couldn't be parsed.
    #[serde(skip_serializing_if = "Option::is_none", rename = "parseError")]
    pub parse_error: Option<String>,
}

#[tauri::command]
pub fn read_agent_config(agent: String) -> Result<AgentReadResult, String> {
    let spec = spec_for(&agent).ok_or_else(|| format!("unknown agent: {}", agent))?;
    let format_str = match spec.format {
        super::paths::AgentFormat::Json => "json",
        super::paths::AgentFormat::Jsonc => "jsonc",
        super::paths::AgentFormat::Toml => "toml",
    };
    let Some(path) = spec.path.clone() else {
        return Ok(AgentReadResult {
            path: None,
            exists: false,
            writable: spec.writable,
            format: format_str.to_string(),
            raw: String::new(),
            parsed: serde_json::Value::Null,
            parse_error: None,
        });
    };
    let outcome = read_file(&path, spec.format);
    Ok(AgentReadResult {
        path: Some(path.to_string_lossy().into_owned()),
        exists: outcome.exists,
        writable: spec.writable,
        format: format_str.to_string(),
        raw: outcome.raw,
        parsed: outcome.parsed,
        parse_error: outcome.parse_error,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AgentWriteResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "backupPath")]
    pub backup_path: Option<String>,
}

#[tauri::command]
pub fn write_agent_config(
    agent: String,
    value: serde_json::Value,
) -> Result<AgentWriteResult, String> {
    let spec = spec_for(&agent).ok_or_else(|| format!("unknown agent: {}", agent))?;
    if !spec.writable {
        return Err(format!("agent is read-only: {}", agent));
    }
    let path = spec
        .path
        .clone()
        .ok_or_else(|| format!("agent has no path on this OS: {}", agent))?;

    // Read existing raw content (so toml_edit can preserve comments).
    let existing = read_file(&path, spec.format);
    let existing_raw = if existing.exists {
        Some(existing.raw.as_str())
    } else {
        None
    };

    let outcome = write_file(&path, spec.format, &value, existing_raw)?;
    Ok(AgentWriteResult {
        path: outcome.path.to_string_lossy().into_owned(),
        backup_path: outcome
            .backup_path
            .map(|p| p.to_string_lossy().into_owned()),
    })
}

/// Resolve where Claude Code / Codex / OpenCode keep their config and data
/// trees on this host, honouring `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` /
/// `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME`. Every importer takes its scan roots
/// from this one answer — see `lib/agent-roots/`.
#[tauri::command]
pub fn agent_vendor_roots() -> VendorRoots {
    vendor_roots()
}

/// Read a workspace's project-scoped MCP config — the `.mcp.json` file Claude
/// Code checks into the repo, which the standalone CLI already loads
/// (`cli/src/mcp/load-mcp-config.ts`) but the desktop could not see.
///
/// Read-only on purpose: `.mcp.json` is usually version-controlled and shared
/// with the user's teammates, so Cognia imports from it but never projects
/// back into it (unlike the user-scope agent files in [`write_agent_config`]).
#[tauri::command]
pub fn read_project_mcp_config(cwd: String) -> Result<AgentReadResult, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("a workspace directory is required".to_string());
    }
    let path = std::path::Path::new(trimmed).join(".mcp.json");
    let outcome = read_file(&path, super::paths::AgentFormat::Json);
    Ok(AgentReadResult {
        path: Some(path.to_string_lossy().into_owned()),
        exists: outcome.exists,
        writable: false,
        format: "json".to_string(),
        raw: outcome.raw,
        parsed: outcome.parsed,
        parse_error: outcome.parse_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_agent_config_rejects_unknown_agent() {
        let err = read_agent_config("not-an-agent".to_string()).expect_err("unknown agent");
        assert!(err.contains("not-an-agent"));
    }

    #[test]
    fn write_agent_config_rejects_read_only_agent() {
        // cline is declared read-only in paths.rs.
        let err = write_agent_config("cline".to_string(), serde_json::json!({}))
            .expect_err("read-only agent");
        assert!(err.contains("read-only"));
    }

    #[test]
    fn agent_vendor_roots_matches_the_pure_resolver() {
        assert_eq!(agent_vendor_roots(), vendor_roots());
    }

    #[test]
    fn read_project_mcp_config_requires_a_workspace() {
        assert!(read_project_mcp_config("   ".to_string()).is_err());
    }

    #[test]
    fn read_project_mcp_config_reports_a_missing_file_without_erroring() {
        let out = read_project_mcp_config("/nonexistent-workspace-xyz".to_string())
            .expect("missing file is not an error");
        assert!(!out.exists);
        assert!(!out.writable);
        assert_eq!(out.format, "json");
        assert!(out.path.expect("path").ends_with(".mcp.json"));
    }

    #[test]
    fn read_project_mcp_config_parses_a_real_file() {
        let dir = std::env::temp_dir().join("cognia-project-mcp-test");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join(".mcp.json"),
            r#"{"mcpServers":{"docs":{"command":"npx","args":["-y","docs"]}}}"#,
        )
        .expect("write");
        let out = read_project_mcp_config(dir.to_string_lossy().into_owned()).expect("read");
        assert!(out.exists);
        assert_eq!(out.parsed["mcpServers"]["docs"]["command"], "npx");
        std::fs::remove_dir_all(&dir).ok();
    }
}
