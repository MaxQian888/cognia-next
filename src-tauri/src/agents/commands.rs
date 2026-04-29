// Tauri commands exposed to the frontend for multi-agent MCP IO.
//
//   read_agent_config(agent)            -> { path, exists, raw, parsed, parseError? }
//   write_agent_config(agent, value)    -> { path, backupPath? }

use serde::{Deserialize, Serialize};

use super::io::{read_file, write_file};
use super::paths::spec_for;

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
