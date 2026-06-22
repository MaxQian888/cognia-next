//! Tauri commands for the Computer Use plugin.
//!
//! Three commands map 1:1 to the Anthropic native tools registered by the
//! plugin manifest (`computer_20251124`, `bash_20250124`,
//! `text_editor_20250728`). Each converts its Anthropic wire input into the
//! canonical `automation::types::Action` and runs it through the **shared**
//! `automation::dispatcher` — the same gate → consent → T5 policy → audit
//! pipeline the renderer's `desktop_*` commands use. (The old bespoke
//! `with_gate` skipped the T5 policy step; routing through `run_gated` closes
//! that gap.) Bash / text-editor execution bodies live in
//! `automation::tool_exec`.

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::automation::audit::{AuditEntry, Decision as AuditDecision};
use crate::automation::commands::{err_to_string, now_ms, AutomationState};
use crate::automation::dispatcher::{execute_action, run_gated, GateContext};
use crate::automation::model_view;
use crate::automation::permission::{Surface, Tier};
use crate::automation::platform::shared::screenshot as screenshot_helpers;
use crate::automation::types::{
    Action, ActionOutput, BashAction, BashResult, SandboxConfine, TextEditorAction,
    TextEditorResult,
};
use crate::automation::virtual_display::ArmOutcome;

use super::translator::{build_computer_result, build_cursor_position_result};
use super::types::{ComputerAction, ComputerResult};

// =============================================================================
// Call context — plugin-specific (carries screen-off mode); maps onto the
// dispatcher's `GateContext` per call.
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
    /// `Character.computerUseSettings.requireConsent`. Forwarded to the gate
    /// via `GateContext.force_tier`.
    #[serde(default)]
    force_tier: Option<Tier>,
    /// Screen-off mode opt-in from `Character.computerUseSettings.screenOffMode`.
    /// When set, `plugin_computer_use_execute` ensures the bundled virtual
    /// display is active + primary before driving a `computer` action so
    /// capture stays non-black with the physical monitor off. Strict: a
    /// missing driver returns a structured error result, never a black frame.
    #[serde(default)]
    screen_off_mode: bool,
    /// ADR-0020 remote-target — when set, GUI actions run against the cua
    /// sandbox with this connection id instead of the local host. Resolved
    /// per-session from `computerUseTarget` (`lib/automation/sandbox-target.ts`).
    #[serde(default)]
    sandbox_connection_id: Option<String>,
    /// ADR-0028 — when set, the native `bash` / `text_editor` tools run
    /// OS-sandboxed / path-confined instead of unconfined. Stamped by the
    /// computer-use plugin when the session has the sandbox enabled.
    #[serde(default)]
    sandbox_confine: Option<SandboxConfine>,
    /// Renderer-supplied session tag keying the per-session model-view
    /// state (coordinate scaling / screenshot dedup / failure counters in
    /// `automation::model_view`). Stamped by the computer-use plugin from
    /// the active chat session id.
    #[serde(default)]
    session_key: Option<String>,
}

impl CallContext {
    fn surface(&self) -> Surface {
        self.surface.unwrap_or(Surface::ComputerUse)
    }

    /// Key for the per-session model-view state: explicit session tag →
    /// sandbox connection id → "local".
    fn view_key(&self) -> String {
        self.session_key
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| self.sandbox_connection_id.clone().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "local".to_string())
    }

    /// Build the dispatcher gate context. `click_x` / `click_y` are derived
    /// from the canonical action's target point so the T5 policy's
    /// `forbidden_screen_regions` fires without the renderer having to pass
    /// coordinates separately.
    fn gate_context(&self, point: Option<crate::automation::types::Point>) -> GateContext {
        GateContext {
            surface: self.surface(),
            plugin_id: self.plugin_id.clone(),
            process_name: self.process_name.clone(),
            window_title: self.window_title.clone(),
            target_url: None,
            click_x: point.map(|p| p.x),
            click_y: point.map(|p| p.y),
            force_tier: self.force_tier,
            command_detail: None,
        }
    }
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

    // Screen-off mode ENTER hook: ensure the bundled virtual display is active
    // + primary before driving the action so capture stays non-black with the
    // physical monitor off. Strict — a missing/unavailable driver returns a
    // structured error result to the model rather than a black screenshot.
    // Only the `computer` tool arms (bash / text_editor don't need a display).
    if ctx.screen_off_mode {
        let surface = ctx.surface();
        let plugin_id = ctx.plugin_id.clone();
        let controller = state.virtual_display.clone();
        let outcome = tokio::task::spawn_blocking(move || controller.arm())
            .await
            .map_err(|e| format!("virtual display arm task failed: {e}"))?;
        if let ArmOutcome::Unavailable(reason) = outcome {
            let entry = AuditEntry {
                id: String::new(),
                ts: now_ms(),
                surface,
                plugin_id,
                command: "computer_use".to_string(),
                process_name: None,
                window_title: None,
                decision: AuditDecision::Deny,
                reason: Some("vdd_unavailable".into()),
                duration_ms: 0,
                error: Some(reason.clone()),
            };
            let recorded = state.audit.record(entry);
            let _ = app.emit("automation:event", &recorded);
            return Ok(build_computer_result(
                None,
                Some(format!("screen-off mode unavailable: {reason}")),
            ));
        }
    }

    let view_key = ctx.view_key();
    // Model-view translation: when screenshot scaling is active the model's
    // coordinates are in scaled space — map them back to physical pixels
    // (and clamp Wait) BEFORE gating so the policy engine sees real
    // coordinates. Out-of-bounds coordinates fail fast without dispatching;
    // a misplaced click is worse than a retried one.
    let canonical = match model_view::map_action(&view_key, Action::from(&action)) {
        Ok(a) => a,
        Err(e) => {
            let mut msg = err_to_string(&e);
            if let Some(guidance) = model_view::note_action_failure(&view_key) {
                msg.push_str(&guidance);
            }
            return Ok(build_computer_result(None, Some(msg)));
        }
    };
    let point = canonical.point();
    let handle = state.handle.clone();
    let cua = state.cua.clone();
    let remote = ctx.sandbox_connection_id.clone();
    let gctx = ctx.gate_context(point);
    let scaling = state.gate.settings().screenshot_scaling;
    let dedup_enabled = state.gate.settings().screenshot_dedup;

    // Audit/gate under the legacy "computer_use" command name so consent +
    // audit behaviour is unchanged; the canonical action drives execution.
    // `remote` carries the resolved sandbox target so a remote session lands in
    // the cua container rather than on the host.
    let output = run_gated(
        Some(&app),
        state.inner(),
        gctx,
        "computer_use",
        move || async move {
            let remote = remote.as_deref().filter(|s| !s.is_empty());
            // GUI actions carry no sandbox confine (it applies only to bash / editor).
            execute_action(&handle, &cua, remote, None, canonical).await
        },
    )
    .await;

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            // Consecutive-failure guidance: after N failed actions in a row
            // the model is told to stop and ask the user instead of looping.
            let mut msg = err_to_string(&e);
            if let Some(guidance) = model_view::note_action_failure(&view_key) {
                msg.push_str(&guidance);
            }
            return Err(msg);
        }
    };

    Ok(match output {
        ActionOutput::Screenshot(sc) => {
            // Down-scale for the model when the operator opted in (Settings →
            // Automation → Behavior); covers local AND cua-remote frames.
            let sc = if scaling.enabled {
                screenshot_helpers::downscale_encoded(sc, scaling.max_width, scaling.max_height)
                    .map_err(|e| err_to_string(&e))?
            } else {
                sc
            };
            // Dedup: identical consecutive frames return a short text note
            // instead of re-sending the full image. `record_screenshot`
            // also stores the scaled/source dims for coordinate mapping.
            let unchanged = model_view::record_screenshot(&view_key, &sc);
            if dedup_enabled && unchanged {
                build_unchanged_screen_result()
            } else {
                build_computer_result(Some(sc), None)
            }
        }
        ActionOutput::Cursor(p) => {
            model_view::note_action_success(&view_key);
            build_cursor_position_result(p)
        }
        // click / type / scroll / drag / mouse_button / hold_key / wait all
        // resolve to Void — a bare OK with no payload, matching the prior
        // `build_computer_result(None, None)`.
        _ => {
            model_view::note_action_success(&view_key);
            build_computer_result(None, None)
        }
    })
}

/// Text-only OK result for a deduped (unchanged) screen — no image bytes,
/// no display dims, so the model treats it as a tool note rather than a
/// fresh frame.
fn build_unchanged_screen_result() -> ComputerResult {
    ComputerResult {
        ok: true,
        output: Some("screen unchanged since previous screenshot — no new image attached".into()),
        error: None,
        display_width_px: None,
        display_height_px: None,
        cursor: None,
    }
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
    // Distinct audit command for restart requests so operators can see when
    // the model asked for a (no-op) session reset.
    let command = if action.restart {
        "bash:restart"
    } else {
        "bash"
    };
    let handle = state.handle.clone();
    let cua = state.cua.clone();
    let confine = ctx.sandbox_confine.clone();
    let canonical = Action::Bash(action);
    let mut gctx = ctx.gate_context(None);
    // Surface the actual shell command in the consent overlay.
    gctx.command_detail = canonical.consent_detail();

    // Bash stays local (the cua remote arg is inert for this arm). When the
    // session enabled the sandbox, `confine` routes it through the OS sandbox.
    let output =
        run_gated(
            Some(&app),
            state.inner(),
            gctx,
            command,
            move || async move {
                execute_action(&handle, &cua, None, confine.as_ref(), canonical).await
            },
        )
        .await
        .map_err(|e| err_to_string(&e))?;

    match output {
        ActionOutput::Bash(result) => Ok(result),
        _ => Ok(BashResult {
            stdout: String::new(),
            stderr: "internal: unexpected dispatcher output for bash".into(),
            exit_code: -1,
            duration_ms: 0,
        }),
    }
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
    let handle = state.handle.clone();
    let cua = state.cua.clone();
    let confine = ctx.sandbox_confine.clone();
    let canonical = Action::TextEditor(action);
    let mut gctx = ctx.gate_context(None);
    gctx.command_detail = canonical.consent_detail();

    // text_editor stays local (ADR-0028 axis); remote arg is inert for this arm.
    // When the session enabled the sandbox, `confine` path-guards the edit.
    let output =
        run_gated(
            Some(&app),
            state.inner(),
            gctx,
            "text_editor",
            move || async move {
                execute_action(&handle, &cua, None, confine.as_ref(), canonical).await
            },
        )
        .await
        .map_err(|e| err_to_string(&e))?;

    match output {
        ActionOutput::TextEditor(result) => Ok(result),
        _ => Ok(TextEditorResult {
            ok: false,
            content: None,
            error: Some("internal: unexpected dispatcher output for text_editor".into()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_context_screen_off_mode_deserializes_camel_case() {
        let raw = serde_json::json!({ "surface": "computerUse", "screenOffMode": true });
        let ctx: CallContext = serde_json::from_value(raw).unwrap();
        assert!(ctx.screen_off_mode);
        assert_eq!(ctx.surface(), Surface::ComputerUse);
    }

    #[test]
    fn call_context_screen_off_mode_defaults_false() {
        let raw = serde_json::json!({ "surface": "computerUse" });
        let ctx: CallContext = serde_json::from_value(raw).unwrap();
        assert!(!ctx.screen_off_mode);
    }

    #[test]
    fn gate_context_carries_click_coords_from_point() {
        let ctx = CallContext::default();
        let gctx = ctx.gate_context(Some(crate::automation::types::Point { x: 12, y: 34 }));
        assert_eq!(gctx.click_x, Some(12));
        assert_eq!(gctx.click_y, Some(34));
        // Default surface for the plugin is ComputerUse.
        assert_eq!(gctx.surface, Surface::ComputerUse);
    }
}
