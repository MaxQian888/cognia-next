// Per-agent, per-OS config file paths. Returning `None` means "this agent
// isn't expected to exist on this OS" — the UI greys the chip rather than
// erroring. Paths use `dirs::home_dir()` / `dirs::config_dir()` so they
// honour user-set HOME / APPDATA on Windows.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

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

// ---------------------------------------------------------------------------
// Vendor roots
//
// The three coding agents cognia imports from (Claude Code, Codex, OpenCode)
// each let the user relocate their whole config tree with an environment
// variable. Every importer — sessions, MCP, subagents, skills, memory,
// settings, commands — must agree on where those trees live, so the
// resolution lives here once and is handed to the frontend as one struct
// (`agent_vendor_roots`). Before this existed each adapter re-derived
// `<home>/.codex` inline and silently ignored `$CODEX_HOME`.
// ---------------------------------------------------------------------------

/// Environment overrides consulted when resolving {@link VendorRoots}.
/// Split out from the real `std::env` read so the resolution is unit-testable.
#[derive(Debug, Default, Clone)]
pub struct RootEnv {
    /// `$CLAUDE_CONFIG_DIR` — relocates Claude Code's `~/.claude`.
    pub claude_config_dir: Option<String>,
    /// `$CODEX_HOME` — relocates Codex CLI's `~/.codex`.
    pub codex_home: Option<String>,
    /// `$XDG_CONFIG_HOME` — OpenCode reads XDG on every unix, macOS included.
    pub xdg_config_home: Option<String>,
    /// `$XDG_DATA_HOME` — where OpenCode keeps its session database.
    pub xdg_data_home: Option<String>,
}

/// Absolute per-vendor root directories. An empty string means "not
/// resolvable on this host" (no home directory) — the frontend treats that
/// as "this vendor can't be scanned" rather than joining onto `""`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VendorRoots {
    /// `$CLAUDE_CONFIG_DIR` or `<home>/.claude`.
    pub claude_config_dir: String,
    /// `$CODEX_HOME` or `<home>/.codex`.
    pub codex_home: String,
    /// `$XDG_CONFIG_HOME/opencode`, `%APPDATA%/opencode`, or `<home>/.config/opencode`.
    pub opencode_config_dir: String,
    /// `$XDG_DATA_HOME/opencode`, `%APPDATA%/opencode`, or `<home>/.local/share/opencode`.
    pub opencode_data_dir: String,
    /// Platform data fallback (`dirs::data_dir()/opencode`), retained alongside XDG.
    pub opencode_platform_data_dir: String,
}

/// A non-blank env override as a path.
fn env_path(value: Option<String>) -> Option<PathBuf> {
    let v = value?;
    let trimmed = v.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn to_string(path: Option<PathBuf>) -> String {
    path.map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Pure core of [`vendor_roots`]. `config_dir` / `data_dir` are the
/// `dirs::` values (only consulted on Windows, where there is no XDG default
/// and `%APPDATA%` is the convention both OpenCode and this repo already use
/// — see `src-tauri/src/fleet/opencode.rs`).
pub fn vendor_roots_from(
    env: RootEnv,
    home_dir: Option<PathBuf>,
    config_dir: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    windows: bool,
) -> VendorRoots {
    let claude =
        env_path(env.claude_config_dir).or_else(|| home_dir.as_ref().map(|h| h.join(".claude")));
    let codex = env_path(env.codex_home).or_else(|| home_dir.as_ref().map(|h| h.join(".codex")));

    let opencode_config = env_path(env.xdg_config_home)
        .map(|x| x.join("opencode"))
        .or_else(|| {
            if windows {
                config_dir.map(|c| c.join("opencode"))
            } else {
                home_dir
                    .as_ref()
                    .map(|h| h.join(".config").join("opencode"))
            }
        });
    let opencode_platform_data = data_dir.as_ref().map(|dir| dir.join("opencode"));
    let opencode_data = env_path(env.xdg_data_home)
        .map(|x| x.join("opencode"))
        .or_else(|| {
            if windows {
                data_dir.map(|d| d.join("opencode"))
            } else {
                home_dir
                    .as_ref()
                    .map(|h| h.join(".local").join("share").join("opencode"))
            }
        });

    VendorRoots {
        claude_config_dir: to_string(claude),
        codex_home: to_string(codex),
        opencode_config_dir: to_string(opencode_config),
        opencode_data_dir: to_string(opencode_data),
        opencode_platform_data_dir: to_string(opencode_platform_data),
    }
}

fn env_var(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// Resolve the vendor roots against the real environment.
pub fn vendor_roots() -> VendorRoots {
    vendor_roots_from(
        RootEnv {
            claude_config_dir: env_var("CLAUDE_CONFIG_DIR"),
            codex_home: env_var("CODEX_HOME"),
            xdg_config_home: env_var("XDG_CONFIG_HOME"),
            xdg_data_home: env_var("XDG_DATA_HOME"),
        },
        home(),
        dirs::config_dir(),
        dirs::data_dir(),
        cfg!(target_os = "windows"),
    )
}

/// `$CODEX_HOME` or `~/.codex`, as a path.
fn codex_home() -> Option<PathBuf> {
    let roots = vendor_roots();
    if roots.codex_home.is_empty() {
        None
    } else {
        Some(PathBuf::from(roots.codex_home))
    }
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

/// Zed's settings.json. Mirrors `paths::config_dir()` in zed-industries/zed
/// (crates/paths/src/paths.rs): Windows uses the roaming config dir under the
/// capitalised `Zed`, Linux/FreeBSD use XDG, and macOS deliberately uses
/// `~/.config/zed` rather than `~/Library/Application Support` — so
/// `dirs::config_dir()` must NOT be used on macOS here.
fn zed_settings_path() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        dirs::config_dir()?.join("Zed")
    } else if cfg!(any(target_os = "linux", target_os = "freebsd")) {
        dirs::config_dir()?.join("zed")
    } else {
        home()?.join(".config").join("zed")
    };
    Some(base.join("settings.json"))
}

/// opencode's global config. `~/.config/opencode/opencode.json` on unix,
/// `%APPDATA%\opencode\opencode.json` on Windows, `$XDG_CONFIG_HOME` first.
fn opencode_path() -> Option<PathBuf> {
    let roots = vendor_roots();
    if roots.opencode_config_dir.is_empty() {
        return None;
    }
    Some(PathBuf::from(roots.opencode_config_dir).join("opencode.json"))
}

/// Claude Code's user-scope config blob. Normally `~/.claude.json`; when
/// `$CLAUDE_CONFIG_DIR` relocates the config tree, the blob moves inside it.
fn claude_code_json_path() -> Option<PathBuf> {
    match env_path(env_var("CLAUDE_CONFIG_DIR")) {
        Some(dir) => Some(dir.join(".claude.json")),
        None => home().map(|h| h.join(".claude.json")),
    }
}

/// Build the spec for a known agent id. Unknown ids return None.
pub fn spec_for(agent: &str) -> Option<AgentSpec> {
    let path: Option<PathBuf>;
    let format: AgentFormat;
    let writable: bool;

    match agent {
        "claude-code" => {
            // ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json
            path = claude_code_json_path();
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
            // $CODEX_HOME/config.toml, else ~/.codex/config.toml
            path = codex_home().map(|h| h.join("config.toml"));
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
        "zed" => {
            // settings.json is JSONC — comments don't survive a write.
            path = zed_settings_path();
            format = AgentFormat::Jsonc;
            writable = true;
        }
        "kiro" => {
            // ~/.kiro/settings/mcp.json (user scope; workspace file wins in Kiro
            // but isn't ours to touch).
            path = home().map(|h| h.join(".kiro").join("settings").join("mcp.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "opencode" => {
            path = opencode_path();
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

    fn unix_roots(env: RootEnv) -> VendorRoots {
        vendor_roots_from(env, Some(PathBuf::from("/h")), None, None, false)
    }

    #[test]
    fn vendor_roots_default_to_unix_conventions() {
        let got = unix_roots(RootEnv::default());
        assert_eq!(got.claude_config_dir, "/h/.claude");
        assert_eq!(got.codex_home, "/h/.codex");
        assert_eq!(got.opencode_config_dir, "/h/.config/opencode");
        assert_eq!(got.opencode_data_dir, "/h/.local/share/opencode");
    }

    #[test]
    fn vendor_roots_honour_claude_and_codex_overrides() {
        let got = unix_roots(RootEnv {
            claude_config_dir: Some("/custom/claude".to_string()),
            codex_home: Some("/custom/codex".to_string()),
            ..RootEnv::default()
        });
        assert_eq!(got.claude_config_dir, "/custom/claude");
        assert_eq!(got.codex_home, "/custom/codex");
        // Unset vars still fall back.
        assert_eq!(got.opencode_config_dir, "/h/.config/opencode");
    }

    #[test]
    fn vendor_roots_honour_xdg_overrides() {
        let got = unix_roots(RootEnv {
            xdg_config_home: Some("/xdg/config".to_string()),
            xdg_data_home: Some("/xdg/data".to_string()),
            ..RootEnv::default()
        });
        assert_eq!(got.opencode_config_dir, "/xdg/config/opencode");
        assert_eq!(got.opencode_data_dir, "/xdg/data/opencode");
    }

    #[test]
    fn vendor_roots_ignore_blank_overrides() {
        let got = unix_roots(RootEnv {
            claude_config_dir: Some("   ".to_string()),
            codex_home: Some(String::new()),
            xdg_config_home: Some("  ".to_string()),
            xdg_data_home: Some("\t".to_string()),
        });
        assert_eq!(got.claude_config_dir, "/h/.claude");
        assert_eq!(got.codex_home, "/h/.codex");
        assert_eq!(got.opencode_config_dir, "/h/.config/opencode");
        assert_eq!(got.opencode_data_dir, "/h/.local/share/opencode");
    }

    #[test]
    fn vendor_roots_use_appdata_on_windows() {
        let got = vendor_roots_from(
            RootEnv::default(),
            Some(PathBuf::from("C:\\Users\\u")),
            Some(PathBuf::from("C:\\Users\\u\\AppData\\Roaming")),
            Some(PathBuf::from("C:\\Users\\u\\AppData\\Roaming")),
            true,
        );
        assert!(got.opencode_config_dir.ends_with("opencode"));
        assert!(got.opencode_config_dir.contains("AppData"));
        assert!(got.opencode_data_dir.contains("AppData"));
        assert!(got.opencode_platform_data_dir.contains("AppData"));
        // Claude / Codex stay home-relative on every OS.
        assert!(got.claude_config_dir.ends_with(".claude"));
    }

    #[test]
    fn vendor_roots_keep_appdata_fallback_with_windows_xdg_override() {
        let got = vendor_roots_from(
            RootEnv {
                xdg_data_home: Some("D:\\XDG".to_string()),
                ..RootEnv::default()
            },
            Some(PathBuf::from("C:\\Users\\u")),
            None,
            Some(PathBuf::from("E:\\Profiles\\u\\Roaming")),
            true,
        );
        assert!(got.opencode_data_dir.starts_with("D:\\XDG"));
        assert!(got
            .opencode_platform_data_dir
            .starts_with("E:\\Profiles\\u\\Roaming"));
    }

    #[test]
    fn vendor_roots_are_blank_without_a_home() {
        let got = vendor_roots_from(RootEnv::default(), None, None, None, false);
        assert_eq!(got.claude_config_dir, "");
        assert_eq!(got.codex_home, "");
        assert_eq!(got.opencode_config_dir, "");
        assert_eq!(got.opencode_data_dir, "");
    }

    #[test]
    fn vendor_roots_serialize_camel_case() {
        let json = serde_json::to_value(unix_roots(RootEnv::default())).expect("serialize");
        assert!(json.get("claudeConfigDir").is_some());
        assert!(json.get("opencodeDataDir").is_some());
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

    #[test]
    fn spec_for_zed_is_writable_jsonc_settings_file() {
        let spec = spec_for("zed").expect("zed spec");
        assert!(spec.writable);
        // settings.json allows comments, so it must round-trip as JSONC.
        assert_eq!(spec.format, AgentFormat::Jsonc);
        let path = spec.path.expect("zed path");
        assert!(path.ends_with("settings.json"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn zed_uses_dot_config_on_macos_not_application_support() {
        // Zed deliberately reads ~/.config/zed on macOS; resolving it via
        // dirs::config_dir() would wrongly land in Application Support.
        let path = spec_for("zed").expect("zed spec").path.expect("zed path");
        let shown = path.to_string_lossy();
        assert!(
            shown.contains(".config/zed"),
            "unexpected zed path: {shown}"
        );
        assert!(!shown.contains("Application Support"));
    }

    #[test]
    fn spec_for_kiro_is_writable_json_under_settings() {
        let spec = spec_for("kiro").expect("kiro spec");
        assert!(spec.writable);
        assert_eq!(spec.format, AgentFormat::Json);
        let path = spec.path.expect("kiro path");
        assert!(path.ends_with("mcp.json"));
        assert!(path.to_string_lossy().contains(".kiro"));
    }

    #[test]
    fn spec_for_opencode_is_writable_json() {
        let spec = spec_for("opencode").expect("opencode spec");
        assert!(spec.writable);
        assert_eq!(spec.format, AgentFormat::Json);
        let path = spec.path.expect("opencode path");
        assert!(path.ends_with("opencode.json"));
        assert!(path.to_string_lossy().contains("opencode"));
    }
}
