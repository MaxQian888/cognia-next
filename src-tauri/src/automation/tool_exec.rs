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

use super::types::{AutomationError, BashAction, BashResult, Result, TextEditorAction, TextEditorResult};

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

#[cfg(test)]
pub(super) fn reset_undo_store_for_testing() {
    if let Ok(mut store) = UNDO_STORE.lock() {
        store.clear();
    }
}

/// Synthetic response for `bash` calls with `restart: true`. Cognia has no
/// persistent shell to restart, but the Anthropic API requires an answer.
pub fn build_bash_restart_result() -> BashResult {
    BashResult {
        stdout: "session reset — cognia uses one-shot shells per call; no persistent state to clear"
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

    let shell = if cfg!(target_os = "windows") { "cmd" } else { "sh" };
    let arg = if cfg!(target_os = "windows") { "/c" } else { "-c" };

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
        reset_undo_store_for_testing();
        dir.join(name).to_string_lossy().into_owned()
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
}
