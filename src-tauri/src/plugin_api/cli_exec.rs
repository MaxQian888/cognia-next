//! `plugin_cli_exec` — one-shot execution backend for declarative CLI
//! wrapper tools (`manifest.cliTools`).
//!
//! The renderer is the policy authority (permission consent, binary trust,
//! argv template substitution, cwd policy); this command is defense in
//! depth plus the actual spawn, delegating to
//! [`crate::terminal::exec::terminal_exec_inner`] (no shell, kill_on_drop,
//! CREATE_NO_WINDOW, 600s hard ceiling). Backstops here:
//!
//!   * `program` must be a plain executable path — no shell metacharacters
//!     and no option-looking values, so a compromised renderer payload
//!     cannot smuggle `sh -c`-style indirection
//!   * stdout/stderr are truncated to `max_output_bytes` (`truncated` flag)
//!     so a chatty binary cannot blow up the IPC channel

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::terminal::exec::terminal_exec_inner;

/// Default per-stream output cap (1 MB).
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1_000_000;

/// Characters that have meaning to shells — none belongs in a program path.
const PROGRAM_FORBIDDEN: &[char] = &[';', '|', '&', '<', '>', '$', '`', '"', '\'', '\n', '\r'];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCliExecRequest {
    pub plugin_id: String,
    pub tool_name: String,
    /// Absolute program path resolved renderer-side (detect_binary or
    /// plugin-dir policy). Never a template.
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub stdin: Option<String>,
    pub timeout_ms: Option<u64>,
    pub max_output_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCliExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// True when either stream exceeded `max_output_bytes` and was cut.
    pub truncated: bool,
}

#[tauri::command]
pub async fn plugin_cli_exec(request: PluginCliExecRequest) -> Result<PluginCliExecResult, String> {
    cli_exec_inner(request).await
}

async fn cli_exec_inner(request: PluginCliExecRequest) -> Result<PluginCliExecResult, String> {
    validate_program(&request.program)?;

    log::info!(
        "[plugin-cli.{}] exec {} ({} args)",
        request.plugin_id,
        request.tool_name,
        request.args.len()
    );

    let result = terminal_exec_inner(
        request.cwd,
        request.program,
        request.args,
        if request.env.is_empty() {
            None
        } else {
            Some(request.env)
        },
        request.timeout_ms,
        request.stdin,
    )
    .await?;

    let cap = request.max_output_bytes.unwrap_or(DEFAULT_MAX_OUTPUT_BYTES).max(1);
    let (stdout, stdout_cut) = truncate_utf8(result.stdout, cap);
    let (stderr, stderr_cut) = truncate_utf8(result.stderr, cap);

    Ok(PluginCliExecResult {
        stdout,
        stderr,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        truncated: stdout_cut || stderr_cut,
    })
}

/// Backstop sanity on the program path (the renderer already resolved it).
fn validate_program(program: &str) -> Result<(), String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Err("plugin_cli_exec.program must not be empty".into());
    }
    if trimmed.starts_with('-') {
        return Err("plugin_cli_exec.program must not look like an option".into());
    }
    if let Some(bad) = trimmed.chars().find(|c| PROGRAM_FORBIDDEN.contains(c)) {
        return Err(format!(
            "plugin_cli_exec.program contains a forbidden character: {bad:?}"
        ));
    }
    Ok(())
}

/// Cut a string at `cap` bytes on a char boundary; returns (text, was_cut).
fn truncate_utf8(text: String, cap: usize) -> (String, bool) {
    if text.len() <= cap {
        return (text, false);
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(program: &str, args: Vec<String>) -> PluginCliExecRequest {
        PluginCliExecRequest {
            plugin_id: "demo".into(),
            tool_name: "t".into(),
            program: program.into(),
            args,
            cwd: None,
            env: HashMap::new(),
            stdin: None,
            timeout_ms: None,
            max_output_bytes: None,
        }
    }

    fn echo(text: &str) -> PluginCliExecRequest {
        if cfg!(windows) {
            request("cmd", vec!["/C".into(), format!("echo {text}")])
        } else {
            request("echo", vec![text.into()])
        }
    }

    #[test]
    fn program_backstop_rejects_metacharacters_and_options() {
        assert!(validate_program("").is_err());
        assert!(validate_program("  ").is_err());
        assert!(validate_program("-rf").is_err());
        for bad in ["sh;reboot", "a|b", "a&b", "a>b", "a<b", "a$b", "a`b", "a\"b", "a'b"] {
            assert!(validate_program(bad).is_err(), "{bad} must be rejected");
        }
        // Spaces are legitimate (C:\Program Files\…), as are plain paths.
        assert!(validate_program(r"C:\Program Files\ripgrep\rg.exe").is_ok());
        assert!(validate_program("/usr/local/bin/rg").is_ok());
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        let (text, cut) = truncate_utf8("héllo wörld".to_string(), 6);
        assert!(cut);
        assert!(text.len() <= 6);
        assert!(text.is_char_boundary(text.len()));
        let (text, cut) = truncate_utf8("short".to_string(), 100);
        assert_eq!(text, "short");
        assert!(!cut);
    }

    #[tokio::test]
    async fn exec_success_and_nonzero_exit() {
        let result = cli_exec_inner(echo("hello-cli")).await.expect("exec ok");
        assert!(result.stdout.contains("hello-cli"));
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(!result.truncated);

        let exit3 = if cfg!(windows) {
            request("cmd", vec!["/C".into(), "exit 3".into()])
        } else {
            request("sh", vec!["-c".into(), "exit 3".into()])
        };
        let result = cli_exec_inner(exit3).await.expect("exec ok");
        assert_eq!(result.exit_code, Some(3));
    }

    #[tokio::test]
    async fn exec_truncates_long_output() {
        let mut req = echo("0123456789-0123456789-0123456789");
        req.max_output_bytes = Some(10);
        let result = cli_exec_inner(req).await.expect("exec ok");
        assert!(result.truncated);
        assert!(result.stdout.len() <= 10);
    }

    #[tokio::test]
    async fn exec_rejects_bad_program_without_spawning() {
        let err = cli_exec_inner(request("rg; rm -rf /", vec![])).await.unwrap_err();
        assert!(err.contains("forbidden character"));
    }
}
