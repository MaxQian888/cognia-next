//! Tauri commands for the Computer Use plugin.
//!
//! Three commands map 1:1 to the Anthropic native tools registered by the
//! plugin manifest (`computer_20251124`, `bash_20250124`, `text_editor_20250728`).
//! Every command routes through the automation subsystem's permission gate
//! with `Surface::ComputerUse`.

use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::State;
use tokio::process::Command as TokioCommand;

use crate::automation::commands::AutomationState;
use crate::automation::permission::{Call, Decision, Surface, TargetMeta};
use crate::automation::types::*;

use super::translator::{build_computer_result, translate_computer_action};
use super::types::*;

// =============================================================================
// Shell execution helper (reused by bash tool)
// =============================================================================

const DEFAULT_SHELL_TIMEOUT_MS: u64 = 60_000;

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

fn build_call_ctx(_process_name: Option<String>, _window_title: Option<String>) -> CallContext {
    CallContext {
        surface: Some(Surface::ComputerUse),
        plugin_id: Some("cognia-computer-use".into()),
        process_name: _process_name,
        window_title: _window_title,
    }
}

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
}

impl CallContext {
    fn surface(&self) -> Surface {
        self.surface.unwrap_or(Surface::Workflow)
    }
    fn target(&self) -> TargetMeta {
        TargetMeta {
            process_name: self.process_name.clone(),
            window_title: self.window_title.clone(),
        }
    }
}

/// Common skeleton: evaluate permission gate, run the action, record audit.
async fn with_gate<F, T>(
    state: &AutomationState,
    ctx: CallContext,
    command: &str,
    action: F,
) -> std::result::Result<T, String>
where
    F: std::future::Future<Output = std::result::Result<T, String>>,
{
    let target = ctx.target();
    let call = Call {
        command,
        surface: ctx.surface(),
        plugin_id: ctx.plugin_id.as_deref(),
        target: target.clone(),
    };

    match state.gate.evaluate(&call) {
        Decision::Deny(err) => Err(format!("{}", err)),
        Decision::RequireConsent { .. } => {
            // M5.4 will wire the consent dialog. For now, return a clear error.
            Err("Consent required for this action. Enable automation in Settings → Automation.".into())
        }
        Decision::Allow => action.await,
    }
}

// =============================================================================
// plugin_computer_use_execute — computer_20251124
// =============================================================================

#[tauri::command]
pub async fn plugin_computer_use_execute(
    state: State<'_, AutomationState>,
    action: ComputerAction,
    ctx: Option<CallContext>,
) -> std::result::Result<ComputerResult, String> {
    let ctx = ctx.unwrap_or_default();

    with_gate(&state, ctx, "computer_use", async {
        let translated = translate_computer_action(&action)?;

        match translated {
            super::translator::TranslatedAction::Screenshot { opts } => {
                let sc = state.handle.screenshot(opts).await.map_err(|e| format!("{}", e))?;
                Ok(build_computer_result(Some(sc), None))
            }

            super::translator::TranslatedAction::Click { target, opts } => {
                state.handle.click(target, opts).await.map_err(|e| format!("{}", e))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::MouseMove { x, y } => {
                // TODO(M5.1): Extend AutomationBackend with mouse_move.
                // For now, emulate as a click with no button (just move).
                state.handle.click(
                    ClickTarget::Point { x, y },
                    ClickOpts {
                        button: None,
                        double: Some(false),
                        modifier: None,
                    },
                ).await.map_err(|e| format!("{}", e))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::Drag { start, end } => {
                // TODO(M5.1): Extend AutomationBackend with drag.
                // For now, perform mouse down + move + up manually.
                state.handle.click(
                    ClickTarget::Point { x: start.x, y: start.y },
                    ClickOpts {
                        button: Some(MouseButton::Left),
                        double: Some(false),
                        modifier: None,
                    },
                ).await.map_err(|e| format!("{}", e))?;
                state.handle.click(
                    ClickTarget::Point { x: end.x, y: end.y },
                    ClickOpts {
                        button: None,
                        double: Some(false),
                        modifier: None,
                    },
                ).await.map_err(|e| format!("{}", e))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::MouseButtonDown { .. } => {
                // TODO(M5.1): Extend AutomationBackend.
                Ok(build_computer_result(None, Some("MouseButtonDown not yet implemented".into())))
            }

            super::translator::TranslatedAction::MouseButtonUp { .. } => {
                // TODO(M5.1): Extend AutomationBackend.
                Ok(build_computer_result(None, Some("MouseButtonUp not yet implemented".into())))
            }

            super::translator::TranslatedAction::Scroll { .. } => {
                // TODO(M5.1): Extend AutomationBackend with scroll.
                Ok(build_computer_result(None, Some("Scroll not yet implemented".into())))
            }

            super::translator::TranslatedAction::TypeText { text, opts } => {
                state.handle.type_text(text, opts).await.map_err(|e| format!("{}", e))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::SendKeys { chord } => {
                state.handle.send_keys(chord).await.map_err(|e| format!("{}", e))?;
                Ok(build_computer_result(None, None))
            }

            super::translator::TranslatedAction::HoldKey { .. } => {
                // TODO(M5.1): Extend AutomationBackend.
                Ok(build_computer_result(None, Some("HoldKey not yet implemented".into())))
            }

            super::translator::TranslatedAction::Wait { duration_secs } => {
                tokio::time::sleep(Duration::from_secs_f64(duration_secs)).await;
                Ok(build_computer_result(None, None))
            }
        }
    }).await
}

// =============================================================================
// plugin_computer_use_bash — bash_20250124
// =============================================================================

#[tauri::command]
pub async fn plugin_computer_use_bash(
    state: State<'_, AutomationState>,
    action: BashAction,
    ctx: Option<CallContext>,
) -> std::result::Result<BashResult, String> {
    let ctx = ctx.unwrap_or_default();

    with_gate(&state, ctx, "bash", async {
        let timeout = action.timeout.unwrap_or(DEFAULT_SHELL_TIMEOUT_MS);
        execute_shell(&action.command, timeout).await
    }).await
}

// =============================================================================
// plugin_computer_use_text_editor — text_editor_20250728
// =============================================================================

#[tauri::command]
pub async fn plugin_computer_use_text_editor(
    state: State<'_, AutomationState>,
    action: TextEditorAction,
    ctx: Option<CallContext>,
) -> std::result::Result<TextEditorResult, String> {
    let ctx = ctx.unwrap_or_default();

    with_gate(&state, ctx, "text_editor", async {
        match action {
            TextEditorAction::View { path } => {
                let content = tokio::fs::read_to_string(&path).await
                    .map_err(|e| format!("read failed: {e}"))?;
                Ok(TextEditorResult {
                    ok: true,
                    content: Some(content),
                    error: None,
                })
            }

            TextEditorAction::Create { path, file_text } => {
                tokio::fs::write(&path, file_text).await
                    .map_err(|e| format!("write failed: {e}"))?;
                Ok(TextEditorResult {
                    ok: true,
                    content: None,
                    error: None,
                })
            }

            TextEditorAction::StrReplace { path, old_str, new_str } => {
                let content = tokio::fs::read_to_string(&path).await
                    .map_err(|e| format!("read failed: {e}"))?;
                let replaced = content.replace(&old_str, &new_str);
                if replaced == content {
                    return Ok(TextEditorResult {
                        ok: false,
                        content: None,
                        error: Some("old_str not found in file".into()),
                    });
                }
                tokio::fs::write(&path, replaced).await
                    .map_err(|e| format!("write failed: {e}"))?;
                Ok(TextEditorResult {
                    ok: true,
                    content: None,
                    error: None,
                })
            }

            TextEditorAction::Insert { path, insert_line, new_str } => {
                let content = tokio::fs::read_to_string(&path).await
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
                tokio::fs::write(&path, output).await
                    .map_err(|e| format!("write failed: {e}"))?;
                Ok(TextEditorResult {
                    ok: true,
                    content: None,
                    error: None,
                })
            }
        }
    }).await
}
