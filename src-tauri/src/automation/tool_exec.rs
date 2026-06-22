//! Execution bodies for the non-pointer native tools (`bash_20250124`,
//! `text_editor_20250728`).
//!
//! These moved out of the computer-use plugin so the unified
//! `dispatcher::execute_action` can run them through the same gate → audit
//! pipeline as the pointer/screenshot actions. The logic is byte-for-byte the
//! behaviour the plugin shipped — one-shot shells (no persistent REPL) and a
//! process-local undo stack for the text editor — only the error type changed
//! from `String` to `AutomationError` so it threads through the dispatcher.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tokio::process::Command as TokioCommand;

use super::types::{
    AutomationError, BashAction, BashResult, Result, SandboxConfine, TextEditorAction,
    TextEditorResult,
};

/// Default wall-clock budget for a one-shot shell call.
const DEFAULT_SHELL_TIMEOUT_MS: u64 = 60_000;

/// Per-file undo snapshot for `text_editor_20250728`. We stash the previous
/// content of any file before `Create` / `StrReplace` / `Insert` mutate it so
/// `UndoEdit` can reverse the last mutating action. Process-local lifetime is
/// correct — undo stacks surviving a restart would surprise the model more
/// than discarding them.
static UNDO_STORE: Lazy<Mutex<HashMap<PathBuf, UndoEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
struct UndoEntry {
    /// `Some(prev)` when the file existed before the edit; `None` when it was
    /// absent — undo deletes the file in that case so `UndoEdit` truly
    /// reverses `Create`.
    prev_content: Option<String>,
}

fn capture_undo_snapshot(path: &PathBuf) {
    let prev = match std::fs::read_to_string(path) {
        Ok(c) => Some(c),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return, // permission / IO error — don't poison the stack
    };
    if let Ok(mut store) = UNDO_STORE.lock() {
        store.insert(path.clone(), UndoEntry { prev_content: prev });
    }
}

/// Drop any stashed undo snapshot for a single path. Used by tests so a
/// fixture starts from a clean slate without clobbering the snapshots of
/// other tests that share the process-global `UNDO_STORE` while the suite
/// runs in parallel. (A blanket `clear()` here would race: one test's
/// `Create` could be wiped by another test's setup before its `UndoEdit`
/// observed it.)
#[cfg(test)]
pub(super) fn reset_undo_entry_for_testing(path: &std::path::Path) {
    if let Ok(mut store) = UNDO_STORE.lock() {
        store.remove(path);
    }
}

/// Synthetic response for `bash` calls with `restart: true`. Cognia has no
/// persistent shell to restart, but the Anthropic API requires an answer.
pub fn build_bash_restart_result() -> BashResult {
    BashResult {
        stdout:
            "session reset — cognia uses one-shot shells per call; no persistent state to clear"
                .into(),
        stderr: String::new(),
        exit_code: 0,
        duration_ms: 0,
    }
}

fn internal(message: impl Into<String>) -> AutomationError {
    AutomationError::Internal {
        message: message.into(),
    }
}

async fn execute_shell(command: &str, timeout_ms: u64) -> Result<BashResult> {
    let start = Instant::now();
    let limit = Duration::from_millis(timeout_ms);

    let shell = if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "sh"
    };
    let arg = if cfg!(target_os = "windows") {
        "/c"
    } else {
        "-c"
    };

    let child = TokioCommand::new(shell)
        .arg(arg)
        .arg(command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| internal(format!("failed to spawn shell: {e}")))?;

    let wait = child.wait_with_output();
    match tokio::time::timeout(limit, wait).await {
        Ok(Ok(out)) => Ok(BashResult {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            exit_code: out.status.code().unwrap_or(-1),
            duration_ms: start.elapsed().as_millis() as u64,
        }),
        Ok(Err(e)) => Err(internal(format!("shell wait error: {e}"))),
        Err(_) => Ok(BashResult {
            stdout: String::new(),
            stderr: format!("timeout: execution exceeded {timeout_ms}ms"),
            exit_code: 124,
            duration_ms: timeout_ms,
        }),
    }
}

/// Run a `bash_20250124` action. `restart` returns the synthetic reset result
/// without spawning anything (no persistent session exists to reset).
pub async fn run_bash(action: BashAction) -> Result<BashResult> {
    if action.restart {
        return Ok(build_bash_restart_result());
    }
    let timeout = action.timeout.unwrap_or(DEFAULT_SHELL_TIMEOUT_MS);
    execute_shell(&action.command, timeout).await
}

/// Resolve the confine's writable roots, defaulting to the user's home
/// directory when the renderer supplied none (the OS sandbox re-denies
/// credential / VCS paths under it).
fn confine_writable(confine: &SandboxConfine) -> Vec<PathBuf> {
    if confine.writable.is_empty() {
        dirs::home_dir().into_iter().collect()
    } else {
        confine.writable.iter().map(PathBuf::from).collect()
    }
}

fn confine_network(confine: &SandboxConfine) -> Result<crate::sandbox::types::NetworkPolicy> {
    use crate::sandbox::types::NetworkPolicy;
    match confine.network.as_deref().unwrap_or("off") {
        "off" => Ok(NetworkPolicy::Off),
        "on" => Ok(NetworkPolicy::On),
        "allowlist" => Ok(NetworkPolicy::Allowlist {
            hosts: confine.network_hosts.clone(),
        }),
        other => Err(internal(format!(
            "sandbox confine: unknown network {other:?}"
        ))),
    }
}

/// Run a `bash_20250124` action CONFINED by the OS sandbox. Fail-closed: when
/// the backend is unavailable `run_confined` returns `SetupRequired` and the
/// error is surfaced verbatim — never a silent unsandboxed fallback.
pub async fn run_bash_confined(action: BashAction, confine: &SandboxConfine) -> Result<BashResult> {
    if action.restart {
        return Ok(build_bash_restart_result());
    }
    let timeout_ms = action.timeout.unwrap_or(DEFAULT_SHELL_TIMEOUT_MS);
    let writable = confine_writable(confine);
    let Some(cwd) = writable.first().cloned() else {
        return Err(internal(
            "sandbox confine: no writable root (home dir unavailable)",
        ));
    };
    let readable: Vec<PathBuf> = confine.readable.iter().map(PathBuf::from).collect();
    let command = crate::sandbox::types::SandboxCommand {
        argv: vec!["bash".into(), "-c".into(), action.command],
        cwd,
        env: Default::default(),
        stdin: None,
        timeout: Duration::from_millis(timeout_ms),
    };
    let policy = crate::sandbox::types::SandboxPolicy::Bash {
        writable,
        readable,
        network: confine_network(confine)?,
        max_cpu_seconds: 0,
        max_memory_mb: 0,
    };
    match crate::sandbox::run_confined(command, policy).await {
        Ok(r) => Ok(BashResult {
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
            duration_ms: r.duration.as_millis() as u64,
        }),
        Err(e) => Err(internal(format!("sandbox: {e}"))),
    }
}

/// Reject a path that escapes the confine's writable roots or targets a
/// protected (credential / VCS) path. Returns the canonicalized path on
/// success. Reads (`View`) accept the readable roots too.
fn guard_path(path: &str, confine: &SandboxConfine, for_write: bool) -> Result<PathBuf> {
    use crate::sandbox::paths::safe_canonicalize;

    let writable = confine_writable(confine);
    let canon = safe_canonicalize(std::path::Path::new(path))
        .map_err(|e| internal(format!("sandbox: invalid path {path:?}: {e}")))?;

    let mut roots = writable.clone();
    if !for_write {
        roots.extend(confine.readable.iter().map(PathBuf::from));
    }
    let under = roots.iter().any(|root| {
        let rc = safe_canonicalize(root).unwrap_or_else(|_| root.clone());
        canon.starts_with(&rc)
    });
    if !under {
        return Err(internal(format!(
            "sandbox: path outside the confined roots denied: {}",
            canon.display()
        )));
    }
    if !for_write && crate::sandbox::protected::is_secret_protected(&canon, &roots) {
        return Err(internal(format!(
            "sandbox: read from protected secret path denied: {}",
            canon.display()
        )));
    }
    if for_write && crate::sandbox::protected::is_protected(&canon, &writable) {
        return Err(internal(format!(
            "sandbox: write to protected path denied: {}",
            canon.display()
        )));
    }
    Ok(canon)
}

/// Run a `text_editor_20250728` action with filesystem access confined to the
/// `SandboxConfine` roots (writes additionally barred from protected paths).
/// Reads/writes stay in-process — the confinement is the path guard, so no
/// sandbox backend is required for the editor (unlike `run_bash_confined`).
pub async fn run_text_editor_confined(
    action: TextEditorAction,
    confine: &SandboxConfine,
) -> Result<TextEditorResult> {
    match &action {
        TextEditorAction::View { path } => {
            guard_path(path, confine, false)?;
        }
        TextEditorAction::Create { path, .. }
        | TextEditorAction::StrReplace { path, .. }
        | TextEditorAction::Insert { path, .. }
        | TextEditorAction::UndoEdit { path } => {
            guard_path(path, confine, true)?;
        }
    }
    run_text_editor(action).await
}

/// Run a `text_editor_20250728` action against the local filesystem.
pub async fn run_text_editor(action: TextEditorAction) -> Result<TextEditorResult> {
    match action {
        TextEditorAction::View { path } => {
            let content = tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| internal(format!("read failed: {e}")))?;
            Ok(TextEditorResult {
                ok: true,
                content: Some(content),
                error: None,
            })
        }

        TextEditorAction::Create { path, file_text } => {
            let path_buf = PathBuf::from(&path);
            capture_undo_snapshot(&path_buf);
            tokio::fs::write(&path, file_text)
                .await
                .map_err(|e| internal(format!("write failed: {e}")))?;
            Ok(TextEditorResult {
                ok: true,
                content: None,
                error: None,
            })
        }

        TextEditorAction::StrReplace {
            path,
            old_str,
            new_str,
        } => {
            let content = tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| internal(format!("read failed: {e}")))?;
            let replaced = content.replace(&old_str, &new_str);
            if replaced == content {
                return Ok(TextEditorResult {
                    ok: false,
                    content: None,
                    error: Some("old_str not found in file".into()),
                });
            }
            let path_buf = PathBuf::from(&path);
            capture_undo_snapshot(&path_buf);
            tokio::fs::write(&path, replaced)
                .await
                .map_err(|e| internal(format!("write failed: {e}")))?;
            Ok(TextEditorResult {
                ok: true,
                content: None,
                error: None,
            })
        }

        TextEditorAction::Insert {
            path,
            insert_line,
            new_str,
        } => {
            let content = tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| internal(format!("read failed: {e}")))?;
            let lines: Vec<&str> = content.lines().collect();
            let mut new_lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
            let idx = insert_line.saturating_sub(1);
            if idx <= new_lines.len() {
                new_lines.insert(idx, new_str);
            } else {
                new_lines.push(new_str);
            }
            let output = new_lines.join("\n");
            let path_buf = PathBuf::from(&path);
            capture_undo_snapshot(&path_buf);
            tokio::fs::write(&path, output)
                .await
                .map_err(|e| internal(format!("write failed: {e}")))?;
            Ok(TextEditorResult {
                ok: true,
                content: None,
                error: None,
            })
        }

        TextEditorAction::UndoEdit { path } => {
            let path_buf = PathBuf::from(&path);
            let entry = {
                let mut store = UNDO_STORE
                    .lock()
                    .map_err(|e| internal(format!("undo store poisoned: {e}")))?;
                store.remove(&path_buf)
            };
            let Some(entry) = entry else {
                return Ok(TextEditorResult {
                    ok: false,
                    content: None,
                    error: Some("no undoable edit".into()),
                });
            };
            match entry.prev_content {
                Some(prev) => {
                    tokio::fs::write(&path, prev)
                        .await
                        .map_err(|e| internal(format!("write failed: {e}")))?;
                }
                None => match tokio::fs::remove_file(&path).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(internal(format!("remove failed: {e}"))),
                },
            }
            Ok(TextEditorResult {
                ok: true,
                content: None,
                error: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fresh_path(dir: &std::path::Path, name: &str) -> String {
        let path = dir.join(name);
        reset_undo_entry_for_testing(&path);
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn create_then_undo_removes_file() {
        let dir = tempdir().unwrap();
        let path = fresh_path(dir.path(), "a.txt");
        run_text_editor(TextEditorAction::Create {
            path: path.clone(),
            file_text: "hello".into(),
        })
        .await
        .unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "hello");

        let result = run_text_editor(TextEditorAction::UndoEdit { path: path.clone() })
            .await
            .unwrap();
        assert!(result.ok);
        assert!(!PathBuf::from(&path).exists());
    }

    #[tokio::test]
    async fn str_replace_then_undo_restores_original() {
        let dir = tempdir().unwrap();
        let path = fresh_path(dir.path(), "b.txt");
        tokio::fs::write(&path, "original").await.unwrap();

        run_text_editor(TextEditorAction::StrReplace {
            path: path.clone(),
            old_str: "original".into(),
            new_str: "changed".into(),
        })
        .await
        .unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "changed");

        run_text_editor(TextEditorAction::UndoEdit { path: path.clone() })
            .await
            .unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "original");
    }

    #[tokio::test]
    async fn insert_then_undo_restores_original() {
        let dir = tempdir().unwrap();
        let path = fresh_path(dir.path(), "c.txt");
        tokio::fs::write(&path, "line1\nline2").await.unwrap();

        run_text_editor(TextEditorAction::Insert {
            path: path.clone(),
            insert_line: 2,
            new_str: "INJECTED".into(),
        })
        .await
        .unwrap();
        assert!(tokio::fs::read_to_string(&path)
            .await
            .unwrap()
            .contains("INJECTED"));

        run_text_editor(TextEditorAction::UndoEdit { path: path.clone() })
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "line1\nline2"
        );
    }

    #[tokio::test]
    async fn double_undo_reports_no_undoable_edit() {
        let dir = tempdir().unwrap();
        let path = fresh_path(dir.path(), "d.txt");
        tokio::fs::write(&path, "x").await.unwrap();

        run_text_editor(TextEditorAction::StrReplace {
            path: path.clone(),
            old_str: "x".into(),
            new_str: "y".into(),
        })
        .await
        .unwrap();

        let first = run_text_editor(TextEditorAction::UndoEdit { path: path.clone() })
            .await
            .unwrap();
        assert!(first.ok);

        let second = run_text_editor(TextEditorAction::UndoEdit { path })
            .await
            .unwrap();
        assert!(!second.ok);
        assert_eq!(second.error.as_deref(), Some("no undoable edit"));
    }

    #[tokio::test]
    async fn bash_restart_returns_synthetic_result_without_spawning() {
        let result = run_bash(BashAction {
            command: "echo should-not-run".into(),
            timeout: None,
            restart: true,
        })
        .await
        .unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.duration_ms, 0);
        assert!(result.stdout.contains("one-shot shells per call"));
    }

    #[tokio::test]
    async fn bash_runs_one_shot_command() {
        // Portable across cmd/sh: `echo hi` prints "hi" on both.
        let result = run_bash(BashAction {
            command: "echo hi".into(),
            timeout: Some(10_000),
            restart: false,
        })
        .await
        .unwrap();
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("hi"));
    }

    fn confine_with(writable: &std::path::Path) -> SandboxConfine {
        SandboxConfine {
            writable: vec![writable.to_string_lossy().into_owned()],
            readable: vec![],
            network: None,
            network_hosts: vec![],
        }
    }

    #[tokio::test]
    async fn text_editor_confined_allows_create_and_view_under_writable() {
        let dir = tempdir().unwrap();
        let confine = confine_with(dir.path());
        let path = dir.path().join("note.txt").to_string_lossy().into_owned();
        reset_undo_entry_for_testing(std::path::Path::new(&path));
        let r = run_text_editor_confined(
            TextEditorAction::Create {
                path: path.clone(),
                file_text: "hi".into(),
            },
            &confine,
        )
        .await
        .unwrap();
        assert!(r.ok);
        let v = run_text_editor_confined(TextEditorAction::View { path }, &confine)
            .await
            .unwrap();
        assert_eq!(v.content.as_deref(), Some("hi"));
    }

    #[tokio::test]
    async fn text_editor_confined_denies_path_outside_writable() {
        let dir = tempdir().unwrap();
        let other = tempdir().unwrap();
        let confine = confine_with(dir.path());
        let path = other
            .path()
            .join("escape.txt")
            .to_string_lossy()
            .into_owned();
        let err = run_text_editor_confined(
            TextEditorAction::Create {
                path,
                file_text: "x".into(),
            },
            &confine,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AutomationError::Internal { .. }));
    }

    #[tokio::test]
    async fn text_editor_confined_denies_protected_path() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let confine = confine_with(dir.path());
        let path = dir
            .path()
            .join(".git")
            .join("config")
            .to_string_lossy()
            .into_owned();
        let err = run_text_editor_confined(
            TextEditorAction::Create {
                path,
                file_text: "x".into(),
            },
            &confine,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AutomationError::Internal { .. }));
    }

    #[tokio::test]
    async fn text_editor_confined_denies_secret_reads() {
        let dir = tempdir().unwrap();
        let ssh_dir = dir.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        let path = ssh_dir.join("id_rsa").to_string_lossy().into_owned();
        tokio::fs::write(&path, "secret").await.unwrap();
        let confine = confine_with(dir.path());

        let err = run_text_editor_confined(TextEditorAction::View { path }, &confine)
            .await
            .unwrap_err();

        assert!(matches!(err, AutomationError::Internal { .. }));
    }

    #[test]
    fn confine_network_parses_each_kind() {
        use crate::sandbox::types::NetworkPolicy;
        assert!(matches!(
            confine_network(&SandboxConfine::default()).unwrap(),
            NetworkPolicy::Off
        ));
        let on = SandboxConfine {
            network: Some("on".into()),
            ..Default::default()
        };
        assert!(matches!(confine_network(&on).unwrap(), NetworkPolicy::On));
        let al = SandboxConfine {
            network: Some("allowlist".into()),
            network_hosts: vec!["a.com".into()],
            ..Default::default()
        };
        assert!(matches!(
            confine_network(&al).unwrap(),
            NetworkPolicy::Allowlist { .. }
        ));
        let bad = SandboxConfine {
            network: Some("weird".into()),
            ..Default::default()
        };
        assert!(confine_network(&bad).is_err());
    }

    #[tokio::test]
    async fn bash_confined_fails_closed_when_backend_unavailable() {
        // On a host without a real sandbox backend, a confined bash must error
        // rather than run unsandboxed. Skip where a backend is present.
        if crate::sandbox::current_backend().is_available() {
            return;
        }
        let dir = tempdir().unwrap();
        let confine = confine_with(dir.path());
        let err = run_bash_confined(
            BashAction {
                command: "echo hi".into(),
                timeout: Some(5_000),
                restart: false,
            },
            &confine,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AutomationError::Internal { .. }));
    }

    #[tokio::test]
    async fn bash_confined_restart_returns_synthetic_without_backend() {
        let dir = tempdir().unwrap();
        let confine = confine_with(dir.path());
        let r = run_bash_confined(
            BashAction {
                command: "x".into(),
                timeout: None,
                restart: true,
            },
            &confine,
        )
        .await
        .unwrap();
        assert_eq!(r.exit_code, 0);
    }
}
