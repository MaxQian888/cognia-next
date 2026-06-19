// Per-agent, per-OS config file paths. Returning `None` means "this agent
// isn't expected to exist on this OS" — the UI greys the chip rather than
// erroring. Paths use `dirs::home_dir()` / `dirs::config_dir()` so they
// honour user-set HOME / APPDATA on Windows.

use std::path::PathBuf;

/// File format hint mirroring `lib/claude/agents/index.ts:AgentFileFormat`.
/// IO uses this to pick the right serializer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentFormat {
    Json,
    Jsonc,
    Toml,
}

#[derive(Debug, Clone)]
pub struct AgentSpec {
    pub format: AgentFormat,
    pub writable: bool,
    pub path: Option<PathBuf>,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Pure core of [`cognia_home`] — testable without touching the real env.
/// `$COGNIA_HOME` (when set + non-empty after trim) wins; otherwise
/// `<home>/.cognia`. Mirrors `cli/src/config/load.ts:resolveHome` so the
/// desktop writes exactly where the standalone CLI reads.
fn cognia_home_from(override_val: Option<String>, home_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(v) = override_val {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    home_dir.map(|h| h.join(".cognia"))
}

/// The cognia CLI home directory: `$COGNIA_HOME` or `~/.cognia`.
pub fn cognia_home() -> Option<PathBuf> {
    cognia_home_from(std::env::var("COGNIA_HOME").ok(), home())
}

#[cfg(target_os = "macos")]
fn claude_desktop_path() -> Option<PathBuf> {
    // ~/Library/Application Support/Claude/claude_desktop_config.json
    home().map(|h| {
        h.join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json")
    })
}

#[cfg(target_os = "windows")]
fn claude_desktop_path() -> Option<PathBuf> {
    // %APPDATA%\Claude\claude_desktop_config.json
    dirs::config_dir().map(|d| d.join("Claude").join("claude_desktop_config.json"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn claude_desktop_path() -> Option<PathBuf> {
    // No officially supported Linux build of Claude Desktop.
    None
}

/// Conventional Cline globalStorage path under VS Code. **Best-effort only.**
/// Path varies by VS Code distribution (Stable, Insiders, OSS, Cursor
/// builds…). We try the Stable VS Code location; if absent, the chip stays
/// grey. We never write here.
fn cline_path() -> Option<PathBuf> {
    let home = home()?;
    let base = if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Code")
    } else if cfg!(target_os = "windows") {
        dirs::config_dir()?.join("Code")
    } else {
        home.join(".config").join("Code")
    };
    Some(
        base.join("User")
            .join("globalStorage")
            .join("saoudrizwan.claude-dev")
            .join("settings")
            .join("cline_mcp_settings.json"),
    )
}

fn roo_code_path() -> Option<PathBuf> {
    let home = home()?;
    let base = if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Code")
    } else if cfg!(target_os = "windows") {
        dirs::config_dir()?.join("Code")
    } else {
        home.join(".config").join("Code")
    };
    Some(
        base.join("User")
            .join("globalStorage")
            .join("rooveterinaryinc.roo-cline")
            .join("settings")
            .join("mcp_settings.json"),
    )
}

fn vscode_user_path() -> Option<PathBuf> {
    let home = home()?;
    let base = if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Code")
    } else if cfg!(target_os = "windows") {
        dirs::config_dir()?.join("Code")
    } else {
        home.join(".config").join("Code")
    };
    Some(base.join("User").join("mcp.json"))
}

/// Build the spec for a known agent id. Unknown ids return None.
pub fn spec_for(agent: &str) -> Option<AgentSpec> {
    let path: Option<PathBuf>;
    let format: AgentFormat;
    let writable: bool;

    match agent {
        "claude-code" => {
            // ~/.claude.json
            path = home().map(|h| h.join(".claude.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "claude-desktop" => {
            path = claude_desktop_path();
            format = AgentFormat::Json;
            writable = true;
        }
        "cursor" => {
            // ~/.cursor/mcp.json
            path = home().map(|h| h.join(".cursor").join("mcp.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "vscode" => {
            path = vscode_user_path();
            format = AgentFormat::Jsonc;
            writable = true;
        }
        "codex" => {
            // ~/.codex/config.toml
            path = home().map(|h| h.join(".codex").join("config.toml"));
            format = AgentFormat::Toml;
            writable = true;
        }
        "gemini" => {
            // ~/.gemini/settings.json
            path = home().map(|h| h.join(".gemini").join("settings.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "windsurf" => {
            // ~/.codeium/windsurf/mcp_config.json
            path = home().map(|h| h.join(".codeium").join("windsurf").join("mcp_config.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "cognia" => {
            // $COGNIA_HOME/mcp.json or ~/.cognia/mcp.json — the cognia CLI's
            // user-scope MCP file (see cli/src/mcp/load-mcp-config.ts).
            path = cognia_home().map(|h| h.join("mcp.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "cline" => {
            path = cline_path();
            format = AgentFormat::Json;
            writable = false;
        }
        "roo-code" => {
            path = roo_code_path();
            format = AgentFormat::Json;
            writable = false;
        }
        _ => return None,
    }

    Some(AgentSpec {
        format,
        writable,
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cognia_home_prefers_override() {
        let got = cognia_home_from(Some("/custom/home".to_string()), Some(PathBuf::from("/h")));
        assert_eq!(got, Some(PathBuf::from("/custom/home")));
    }

    #[test]
    fn cognia_home_trims_and_ignores_blank_override() {
        let got = cognia_home_from(Some("   ".to_string()), Some(PathBuf::from("/h")));
        assert_eq!(got, Some(PathBuf::from("/h").join(".cognia")));
    }

    #[test]
    fn cognia_home_falls_back_to_dot_cognia() {
        let got = cognia_home_from(None, Some(PathBuf::from("/h")));
        assert_eq!(got, Some(PathBuf::from("/h").join(".cognia")));
    }

    #[test]
    fn cognia_home_none_without_home() {
        assert_eq!(cognia_home_from(None, None), None);
    }

    #[test]
    fn spec_for_cognia_is_writable_json_mcp_file() {
        let spec = spec_for("cognia").expect("cognia spec");
        assert!(spec.writable);
        assert_eq!(spec.format, AgentFormat::Json);
        let path = spec.path.expect("cognia path");
        assert!(path.ends_with("mcp.json"));
        assert!(path.to_string_lossy().contains(".cognia") || std::env::var("COGNIA_HOME").is_ok());
    }

    #[test]
    fn spec_for_unknown_is_none() {
        assert!(spec_for("not-an-agent").is_none());
    }
}
