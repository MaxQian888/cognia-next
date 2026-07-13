//! One-shot command execution for the Companion API (`terminal_exec`).
//!
//! Distinct from the streaming PTY in [`super::commands`]: the live terminal
//! stays on `/ws/v1/terminal`, while this runs a single command to completion
//! and returns the captured output as one request/response RPC. This is the
//! shape a remote client needs for "run X and show me the result" without
//! managing a long-lived session.
//!
//! The child inherits the desktop process environment (so the user's `PATH`
//! and shell tooling are available) and applies any caller-supplied `env`
//! overrides on top. Execution is bounded by `timeout_ms`; on timeout the
//! child is killed (`kill_on_drop`) and `timed_out` is set.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

/// Default wall-clock budget for a one-shot exec when the caller omits one.
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// Hard ceiling so a remote caller cannot pin a worker indefinitely.
const MAX_TIMEOUT_MS: u64 = 600_000;

/// Result of a one-shot command execution.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExecResult {
    pub stdout: String,
    pub stderr: String,
    /// Process exit code, or `None` when the process was terminated by a signal
    /// or killed on timeout.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// Wrap a full shell command line in the platform shell so `terminal_exec`
/// can run history-style lines (pipes, `&&`, redirects) that a direct exec
/// can't. `cmd.exe /C` on Windows, `/bin/sh -c` elsewhere — the lowest common
/// denominator that exists on every host, deliberately NOT the user's
/// configured default shell (a one-shot capture has no PTY/profile needs).
pub fn shell_wrap(line: &str) -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        ("cmd.exe".to_string(), vec!["/C".to_string(), line.to_string()])
    }
    #[cfg(not(target_os = "windows"))]
    {
        ("/bin/sh".to_string(), vec!["-c".to_string(), line.to_string()])
    }
}

/// Run `command` with `args` to completion, capturing stdout/stderr.
///
/// `cwd` sets the working directory; `env` entries are layered onto the
/// inherited environment; `timeout_ms` bounds the run (clamped to
/// [`MAX_TIMEOUT_MS`]); `stdin_data`, when set, is piped into the child's
/// stdin (then closed). Returns an `Err(String)` only when the child cannot
/// be spawned at all — a non-zero exit is a successful RPC with `exit_code`
/// set.
pub async fn terminal_exec_inner(
    cwd: Option<String>,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    stdin_data: Option<String>,
) -> Result<TerminalExecResult, String> {
    if command.trim().is_empty() {
        return Err("terminal_exec.command must not be empty".to_string());
    }

    let _perf = cognia_instrument::guard("terminal.exec");
    let budget = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(if stdin_data.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // No console flash in release builds (same flag every other spawn in the
    // codebase applies — sidecar, python host, hooks).
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Some(dir) = cwd.as_ref() {
        cmd.current_dir(dir);
    }
    if let Some(overrides) = env {
        for (k, v) in overrides {
            cmd.env(k, v);
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn '{command}': {e}"))?;

    if let Some(data) = stdin_data {
        use tokio::io::AsyncWriteExt;
        if let Some(mut stdin) = child.stdin.take() {
            // Write-then-drop closes the pipe so line-readers see EOF.
            if let Err(e) = stdin.write_all(data.as_bytes()).await {
                return Err(format!("stdin write '{command}': {e}"));
            }
        }
    }

    match tokio::time::timeout(Duration::from_millis(budget), child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(TerminalExecResult {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code(),
            timed_out: false,
        }),
        Ok(Err(e)) => Err(format!("exec '{command}': {e}")),
        Err(_) => Ok(TerminalExecResult {
            stdout: String::new(),
            stderr: format!("command timed out after {budget}ms"),
            exit_code: None,
            timed_out: true,
        }),
    }
}

/// Tauri command wrapper so the desktop shell can drive one-shot exec through
/// the same `transport.call("terminal_exec", …)` client path the mobile client
/// uses (the Companion dispatch arm calls [`terminal_exec_inner`] directly).
#[tauri::command]
pub async fn terminal_exec(
    cwd: Option<String>,
    command: String,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    shell: Option<bool>,
) -> Result<TerminalExecResult, String> {
    let args = args.unwrap_or_default();
    let (command, args) = resolve_shell_mode(command, args, shell.unwrap_or(false))?;
    terminal_exec_inner(cwd, command, args, env, timeout_ms, None).await
}

/// Apply the optional `shell` mode shared by the Tauri command and the
/// Companion RPC arm: when set, `command` is a complete shell line and `args`
/// must be empty (rejecting, rather than silently dropping or naively
/// re-quoting, whatever the caller passed).
pub fn resolve_shell_mode(
    command: String,
    args: Vec<String>,
    shell: bool,
) -> Result<(String, Vec<String>), String> {
    if !shell {
        return Ok((command, args));
    }
    if !args.is_empty() {
        return Err("terminal_exec.args must be empty when shell=true".to_string());
    }
    Ok(shell_wrap(&command))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo() -> (String, Vec<String>) {
        if cfg!(windows) {
            ("cmd".to_string(), vec!["/C".into(), "echo hello".into()])
        } else {
            ("echo".to_string(), vec!["hello".into()])
        }
    }

    #[tokio::test]
    async fn runs_a_command_and_captures_stdout() {
        let (cmd, args) = echo();
        let res = terminal_exec_inner(None, cmd, args, None, None, None)
            .await
            .expect("exec ok");
        assert!(res.stdout.contains("hello"));
        assert_eq!(res.exit_code, Some(0));
        assert!(!res.timed_out);
    }

    #[tokio::test]
    async fn empty_command_is_rejected() {
        let err = terminal_exec_inner(None, "  ".to_string(), vec![], None, None, None)
            .await
            .unwrap_err();
        assert!(err.contains("must not be empty"));
    }

    #[tokio::test]
    async fn missing_binary_surfaces_a_spawn_error() {
        let err = terminal_exec_inner(
            None,
            "definitely_not_a_real_binary_xyz".to_string(),
            vec![],
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("spawn"));
    }

    #[tokio::test]
    async fn applies_env_overrides() {
        // `env` prints the environment on unix; on windows use `cmd /C set`.
        let (cmd, args) = if cfg!(windows) {
            (
                "cmd".to_string(),
                vec!["/C".into(), "echo %COGNIA_EXEC_TEST%".into()],
            )
        } else {
            ("printenv".to_string(), vec!["COGNIA_EXEC_TEST".into()])
        };
        let mut env = HashMap::new();
        env.insert("COGNIA_EXEC_TEST".to_string(), "marker42".to_string());
        let res = terminal_exec_inner(None, cmd, args, Some(env), None, None)
            .await
            .expect("exec ok");
        assert!(res.stdout.contains("marker42"));
    }

    #[test]
    fn shell_wrap_targets_the_platform_shell() {
        let (cmd, args) = shell_wrap("echo hi && echo bye");
        if cfg!(windows) {
            assert_eq!(cmd, "cmd.exe");
            assert_eq!(args, vec!["/C".to_string(), "echo hi && echo bye".to_string()]);
        } else {
            assert_eq!(cmd, "/bin/sh");
            assert_eq!(args, vec!["-c".to_string(), "echo hi && echo bye".to_string()]);
        }
    }

    #[test]
    fn resolve_shell_mode_passes_through_and_rejects_args_with_shell() {
        let (cmd, args) =
            resolve_shell_mode("git".to_string(), vec!["status".to_string()], false).unwrap();
        assert_eq!(cmd, "git");
        assert_eq!(args, vec!["status".to_string()]);

        let err = resolve_shell_mode("git status".to_string(), vec!["-v".to_string()], true)
            .unwrap_err();
        assert!(err.contains("args must be empty"));

        let (cmd, args) = resolve_shell_mode("git status".to_string(), vec![], true).unwrap();
        assert!(args.iter().any(|a| a == "git status"));
        assert!(cmd == "cmd.exe" || cmd == "/bin/sh");
    }

    #[tokio::test]
    async fn shell_mode_runs_a_full_command_line() {
        let (cmd, args) = resolve_shell_mode("echo shell-mode-ok".to_string(), vec![], true)
            .expect("resolve");
        let res = terminal_exec_inner(None, cmd, args, None, None, None)
            .await
            .expect("exec ok");
        assert!(res.stdout.contains("shell-mode-ok"));
        assert_eq!(res.exit_code, Some(0));
    }

    #[tokio::test]
    async fn pipes_stdin_data_into_the_child() {
        // `more` (Windows) / `cat` (Unix) echo stdin to stdout.
        let (cmd, args) = if cfg!(windows) {
            ("cmd".to_string(), vec!["/C".into(), "more".into()])
        } else {
            ("cat".to_string(), vec![])
        };
        let res = terminal_exec_inner(None, cmd, args, None, None, Some("ping-pong\n".into()))
            .await
            .expect("exec ok");
        assert!(res.stdout.contains("ping-pong"));
        assert_eq!(res.exit_code, Some(0));
    }
}
