//! Tauri commands for the Computer Use plugin.
//!
//! Three commands map 1:1 to the Anthropic native tools registered by the
//! plugin manifest (`computer_20251124`, `bash_20250124`, `text_editor_20250728`).
//! Every command routes through the automation subsystem's permission gate
//! with `Surface::ComputerUse`. PerCall consent now lands in the renderer
//! via the shared `ConsentBroker` — no more "Consent required" hard error.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command as TokioCommand;

use crate::automation::audit::{AuditEntry, Decision as AuditDecision};
use crate::automation::commands::AutomationState;
use crate::automation::permission::{
    maybe_upgrade_to_consent, Call, Decision, Surface, TargetMeta, Tier,
};
use crate::automation::types::*;

use super::translator::{build_computer_result, translate_computer_action};
use super::types::*;

/// Per-file undo snapshot for `text_editor_20250728`. Anthropic's reference
/// implementation supports `undo_edit` against the last mutating action — we
/// match that contract by stashing the previous content of any file before
/// `Create`, `StrReplace`, or `Insert` mutate it.
///
/// Process-local lifetime is correct: undo stacks across process restarts
/// would surprise the model more than discarding them does.
static UNDO_STORE: Lazy<Mutex<HashMap<PathBuf, UndoEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
struct UndoEntry {
    /// `Some(prev_content)` when the file existed before the edit, `None`
    /// when the prior state was "file absent" — undo deletes the file in
    /// that case so `UndoEdit` truly reverses `Create`.
    prev_content: Option<String>,
}

fn capture_undo_snapshot(path: &PathBuf) {
    let prev = match std::fs::read_to_string(path) {
        Ok(c) => Some(c),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return, // permission or IO error — don't poison the stack
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

// =============================================================================
// Shell execution helper (reused by bash tool)
// =============================================================================

const DEFAULT_SHELL_TIMEOUT_MS: u64 = 60_000;

/// Synthetic response for `bash` calls with `restart: true`. Cognia has no
/// persistent shell to restart, but the Anthropic API requires an answer.
/// Extracted so tests can assert the exact stdout the model will see.
pub(super) fn build_bash_restart_result() -> BashResult {
    BashResult {
        stdout: "session reset — cognia uses one-shot shells per call; no persistent state to clear"
            .into(),
        stderr: String::new(),
        exit_code: 0,
        duration_ms: 0,
    }
}

async fn execute_shell(
    command: &str,
    timeout_ms: u64,
) -> std::result::Result<BashResult, String> {
    let start = Instant::now();
    let limit = Duration::from_millis(timeout_ms);

    let shell = if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "sh"
    };
    let arg = if cfg!(target_os = "windows") { "/c" } else { "-c" };

    let child = TokioCommand::new(shell)
        .arg(arg)
        .arg(command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn shell: {e}"))?;

    let wait = child.wait_with_output();
    match tokio::time::timeout(limit, wait).await {
        Ok(Ok(out)) => Ok(BashResult {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            exit_code: out.status.code().unwrap_or(-1),
            duration_ms: start.elapsed().as_millis() as u64,
        }),
        Ok(Err(e)) => Err(format!("shell wait error: {e}")),
        Err(_) => Ok(BashResult {
            stdout: String::new(),
            stderr: format!("timeout: execution exceeded {timeout_ms}ms"),
            exit_code: 124,
            duration_ms: timeout_ms,
        }),
    }
}

// =============================================================================
// Common permission + audit path
// =============================================================================

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallContext {
    #[serde(default)]
    surface: Option<Surface>,
    #[serde(default)]
    plugin_id: Option<String>,
    #[serde(default)]
    process_name: Option<String>,
    #[serde(default)]
    window_title: Option<String>,
    /// ADR-0020 W1 — per-call tier upgrade originating from
    /// `Character.computerUseSettings.requireConsent`. Forwarded from the
    /// sidecar in `ctx.forceTier`; `maybe_upgrade_to_consent` swaps a
    /// gate `Allow` into `RequireConsent` for driving calls.
    #[serde(default)]
    force_tier: Option<Tier>,
}

impl CallContext {
    fn surface(&self) -> Surface {
        self.surface.unwrap_or(Surface::ComputerUse)
    }
    fn target(&self) -> TargetMeta {
        TargetMeta {
            process_name: self.process_name.clone(),
            window_title: self.window_title.clone(),
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Common skeleton: evaluate permission gate, run the action, record audit.
/// Mirrors `automation::commands::command_body!` semantics but operates on
/// the plugin-specific `with_gate` async signature (closures-of-futures
/// don't play nice with the cross-crate macro export).
async fn with_gate<F, Fut, T>(
    app: &AppHandle,
    state: &AutomationState,
    ctx: CallContext,
    command: &str,
    action: F,
) -> std::result::Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = std::result::Result<T, String>>,
{
    let started = Instant::now();
    let target = ctx.target();
    let surface = ctx.surface();
    let plugin_id = ctx.plugin_id.clone();
    let call = Call {
        command,
        surface,
        plugin_id: plugin_id.as_deref(),
        target: target.clone(),
    };

    let initial_decision = state.gate.evaluate(&call);
    let decision = maybe_upgrade_to_consent(initial_decision, ctx.force_tier, &call);
    let allow = match decision {
        Decision::Allow => true,
        Decision::Deny(err) => {
            let entry = AuditEntry {
                id: String::new(),
                ts: now_ms(),
                surface,
                plugin_id: plugin_id.clone(),
                command: command.to_string(),
                process_name: target.process_name.clone(),
                window_title: target.window_title.clone(),
                decision: AuditDecision::Deny,
                reason: Some(format!("{err}")),
                duration_ms: started.elapsed().as_millis() as u64,
                error: Some(format!("{err}")),
            };
            let recorded = state.audit.record(entry);
            let _ = app.emit("automation:event", &recorded);
            return Err(format!("{err}"));
        }
        Decision::RequireConsent { prompt } => state.consent.request(app.clone(), prompt).await,
    };

    if !allow {
        let err = AutomationError::UserDeclined;
        let entry = AuditEntry {
            id: String::new(),
            ts: now_ms(),
            surface,
            plugin_id: plugin_id.clone(),
            command: command.to_string(),
            process_name: target.process_name.clone(),
            window_title: target.window_title.clone(),
            decision: AuditDecision::Deny,
            reason: Some("user declined or timed out".into()),
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(format!("{err}")),
        };
        let recorded = state.audit.record(entry);
        let _ = app.emit("automation:event", &recorded);
        return Err(format!("{err}"));
    }

    let result = action().await;
    let entry = AuditEntry {
        id: String::new(),
        ts: now_ms(),
        surface,
        plugin_id: plugin_id.clone(),
        command: command.to_string(),
        process_name: target.process_name.clone(),
        window_title: target.window_title.clone(),
        decision: AuditDecision::Allow,
        reason: None,
        duration_ms: started.elapsed().as_millis() as u64,
        error: result.as_ref().err().map(|e| e.to_string()),
    };
    let recorded = state.audit.record(entry);
    let _ = app.emit("automation:event", &recorded);
    result
}

// =============================================================================
// plugin_computer_use_execute — computer_20251124
// =============================================================================

#[tauri::command]
pub async fn plugin_computer_use_execute(
    app: AppHandle,
    state: State<'_, AutomationState>,
    action: ComputerAction,
    ctx: Option<CallContext>,
) -> std::result::Result<ComputerResult, String> {
    let ctx = ctx.unwrap_or_default();
    let handle = state.handle.clone();

    with_gate(&app, &state, ctx, "computer_use", || async move {
        let translated = translate_computer_action(&action)?;

        match translated {
            super::translator::TranslatedAction::Screenshot { opts } => {
                let sc = handle.screenshot(opts).await.map_err(|e| format!("{e}"))?;
                Ok(build_computer_result(Some(sc), None))
            }

            super::translator::TranslatedAction::Click { target, opts } => {
                handle.click(target, opts).await.map_err(|e| format!("{e}"))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::MouseMove { point } => {
                handle.mouse_move(point).await.map_err(|e| format!("{e}"))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::Drag { from, to, opts } => {
                handle.drag(from, to, opts).await.map_err(|e| format!("{e}"))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::MouseButton { button, transition } => {
                handle
                    .mouse_button(button, transition)
                    .await
                    .map_err(|e| format!("{e}"))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::Scroll { target, opts } => {
                handle.scroll(target, opts).await.map_err(|e| format!("{e}"))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::TypeText { text, opts } => {
                handle.type_text(text, opts).await.map_err(|e| format!("{e}"))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::SendKeys { chord } => {
                handle.send_keys(chord).await.map_err(|e| format!("{e}"))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::HoldKey {
                chord,
                duration_secs,
            } => {
                let ms = (duration_secs.max(0.0) * 1000.0) as u32;
                handle.hold_key(chord, ms).await.map_err(|e| format!("{e}"))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::Wait { duration_secs } => {
                tokio::time::sleep(Duration::from_secs_f64(duration_secs)).await;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::CursorPosition => {
                let point = handle.cursor_position().await.map_err(|e| format!("{e}"))?;
                Ok(super::translator::build_cursor_position_result(point))
            }
        }
    })
    .await
}

// =============================================================================
// plugin_computer_use_bash — bash_20250124
// =============================================================================

#[tauri::command]
pub async fn plugin_computer_use_bash(
    app: AppHandle,
    state: State<'_, AutomationState>,
    action: BashAction,
    ctx: Option<CallContext>,
) -> std::result::Result<BashResult, String> {
    let ctx = ctx.unwrap_or_default();

    // Anthropic's bash_20250124 reference implementation runs a long-lived
    // `bash -i` REPL and `restart: true` kills + respawns it. Cognia spawns a
    // fresh `cmd /c` / `sh -c` per call (no persistent session), so the
    // honest answer is "there is nothing to clear". We still route through
    // the permission gate under a distinct `bash:restart` audit command so
    // operators can see when the model asked for a reset, then return a
    // synthetic OK result without spawning anything.
    if action.restart {
        return with_gate(&app, &state, ctx, "bash:restart", || async move {
            Ok(build_bash_restart_result())
        })
        .await;
    }

    with_gate(&app, &state, ctx, "bash", || async move {
        let timeout = action.timeout.unwrap_or(DEFAULT_SHELL_TIMEOUT_MS);
        execute_shell(&action.command, timeout).await
    })
    .await
}

// =============================================================================
// plugin_computer_use_text_editor — text_editor_20250728
// =============================================================================

#[tauri::command]
pub async fn plugin_computer_use_text_editor(
    app: AppHandle,
    state: State<'_, AutomationState>,
    action: TextEditorAction,
    ctx: Option<CallContext>,
) -> std::result::Result<TextEditorResult, String> {
    let ctx = ctx.unwrap_or_default();

    with_gate(&app, &state, ctx, "text_editor", || async move {
        match action {
            TextEditorAction::View { path } => {
                let content = tokio::fs::read_to_string(&path)
                    .await
                    .map_err(|e| format!("read failed: {e}"))?;
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
                    .map_err(|e| format!("write failed: {e}"))?;
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
                    .map_err(|e| format!("read failed: {e}"))?;
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
                    .map_err(|e| format!("write failed: {e}"))?;
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
                    .map_err(|e| format!("read failed: {e}"))?;
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
                    .map_err(|e| format!("write failed: {e}"))?;
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
                        .map_err(|e| format!("undo store poisoned: {e}"))?;
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
                            .map_err(|e| format!("write failed: {e}"))?;
                    }
                    None => match tokio::fs::remove_file(&path).await {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(format!("remove failed: {e}")),
                    },
                }
                Ok(TextEditorResult {
                    ok: true,
                    content: None,
                    error: None,
                })
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fresh_path(dir: &std::path::Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        reset_undo_store_for_testing();
        p
    }

    async fn run_text_editor(
        action: TextEditorAction,
    ) -> std::result::Result<TextEditorResult, String> {
        // Drives the same body as `plugin_computer_use_text_editor` but
        // without the Tauri permission gate (which needs an AppHandle).
        // We only verify the action-handling block here; gate behaviour is
        // covered by automation::commands tests upstream.
        match action {
            TextEditorAction::View { path } => {
                let content = tokio::fs::read_to_string(&path)
                    .await
                    .map_err(|e| format!("read failed: {e}"))?;
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
                    .map_err(|e| format!("write failed: {e}"))?;
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
                    .map_err(|e| format!("read failed: {e}"))?;
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
                    .map_err(|e| format!("write failed: {e}"))?;
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
                    .map_err(|e| format!("read failed: {e}"))?;
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
                    .map_err(|e| format!("write failed: {e}"))?;
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
                        .map_err(|e| format!("undo store poisoned: {e}"))?;
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
                            .map_err(|e| format!("write failed: {e}"))?;
                    }
                    None => match tokio::fs::remove_file(&path).await {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(format!("remove failed: {e}")),
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

    #[tokio::test]
    async fn create_then_undo_removes_file() {
        let dir = tempdir().unwrap();
        let path = fresh_path(dir.path(), "a.txt");
        let path_str = path.to_string_lossy().into_owned();

        run_text_editor(TextEditorAction::Create {
            path: path_str.clone(),
            file_text: "hello".into(),
        })
        .await
        .unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "hello");

        let result = run_text_editor(TextEditorAction::UndoEdit {
            path: path_str.clone(),
        })
        .await
        .unwrap();
        assert!(result.ok);
        assert!(!path.exists(), "file should be removed after undo of create");
    }

    #[tokio::test]
    async fn str_replace_then_undo_restores_original() {
        let dir = tempdir().unwrap();
        let path = fresh_path(dir.path(), "b.txt");
        let path_str = path.to_string_lossy().into_owned();
        tokio::fs::write(&path, "original").await.unwrap();

        run_text_editor(TextEditorAction::StrReplace {
            path: path_str.clone(),
            old_str: "original".into(),
            new_str: "changed".into(),
        })
        .await
        .unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "changed");

        run_text_editor(TextEditorAction::UndoEdit {
            path: path_str.clone(),
        })
        .await
        .unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "original");
    }

    #[tokio::test]
    async fn insert_then_undo_restores_original() {
        let dir = tempdir().unwrap();
        let path = fresh_path(dir.path(), "c.txt");
        let path_str = path.to_string_lossy().into_owned();
        tokio::fs::write(&path, "line1\nline2").await.unwrap();

        run_text_editor(TextEditorAction::Insert {
            path: path_str.clone(),
            insert_line: 2,
            new_str: "INJECTED".into(),
        })
        .await
        .unwrap();
        assert!(tokio::fs::read_to_string(&path).await.unwrap().contains("INJECTED"));

        run_text_editor(TextEditorAction::UndoEdit {
            path: path_str.clone(),
        })
        .await
        .unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "line1\nline2");
    }

    #[test]
    fn bash_restart_synthetic_result_documents_session_semantics() {
        let result = build_bash_restart_result();
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.duration_ms, 0);
        assert!(result.stderr.is_empty());
        assert!(
            result.stdout.contains("one-shot shells per call"),
            "stdout must explain the divergence from Anthropic's persistent-session reference impl, got: {}",
            result.stdout
        );
    }

    #[tokio::test]
    async fn double_undo_reports_no_undoable_edit() {
        let dir = tempdir().unwrap();
        let path = fresh_path(dir.path(), "d.txt");
        let path_str = path.to_string_lossy().into_owned();
        tokio::fs::write(&path, "x").await.unwrap();

        run_text_editor(TextEditorAction::StrReplace {
            path: path_str.clone(),
            old_str: "x".into(),
            new_str: "y".into(),
        })
        .await
        .unwrap();

        let first = run_text_editor(TextEditorAction::UndoEdit {
            path: path_str.clone(),
        })
        .await
        .unwrap();
        assert!(first.ok);

        let second = run_text_editor(TextEditorAction::UndoEdit { path: path_str })
            .await
            .unwrap();
        assert!(!second.ok);
        assert_eq!(second.error.as_deref(), Some("no undoable edit"));
    }
}
