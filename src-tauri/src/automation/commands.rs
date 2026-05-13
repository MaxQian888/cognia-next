//! Tauri commands exposed to the renderer for the automation subsystem.
//!
//! Each command follows the same skeleton:
//!
//!   1. Build a `Call` describing what's being requested.
//!   2. Run `PermissionGate::evaluate`.
//!   3. If `Deny`, record the audit row + return the error.
//!   4. If `RequireConsent`, emit a `automation:consent-request` event and
//!      block on a renderer-side reply (M2 wiring; for M1 we return
//!      `UserDeclined` so the call always lands somewhere visible).
//!   5. If `Allow`, dispatch to the worker, record audit row, return.
//!
//! The audit ring is non-authoritative; the renderer mirrors `automation:event`
//! into the Dexie `automationAuditLog` table.

use std::time::Instant;

use serde::Deserialize;
use tauri::{Emitter, State};

use super::audit::{AuditEntry, AuditRing, Decision as AuditDecision};
use super::permission::{Call, Decision, PermissionGate, Surface, TargetMeta};
use super::types::*;
use super::worker::AutomationHandle;

/// Bundled state that every automation command pulls from `tauri::State`.
pub struct AutomationState {
    pub handle: AutomationHandle,
    pub gate: PermissionGate,
    pub audit: AuditRing,
}

impl AutomationState {
    pub fn new(handle: AutomationHandle, gate: PermissionGate, audit: AuditRing) -> Self {
        Self { handle, gate, audit }
    }
}

/// Mirror of `AuditDecision` for the wire — uses the same SCREAMING_SNAKE_CASE
/// reason tagging as `AutomationError` so the renderer can deserialize either.
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Convert an `AutomationError` into a String for the Tauri Result. Tauri
/// requires `Result<T, E: Serialize>`; serializing the enum directly is
/// preferable but the existing codebase returns String for compatibility.
/// We serialize as JSON so the TS side can `JSON.parse` to recover the tag.
fn err_to_string(err: &AutomationError) -> String {
    serde_json::to_string(err).unwrap_or_else(|_| format!("{err}"))
}

/// Common path: turn a `Decision::Deny` into the recorded audit + final
/// stringified error. Returns the AuditEntry for emit.
fn record_deny(
    audit: &AuditRing,
    command: &str,
    surface: Surface,
    plugin_id: Option<&str>,
    target: &TargetMeta,
    err: &AutomationError,
    started: Instant,
) -> AuditEntry {
    audit.record(AuditEntry {
        id: String::new(),
        ts: now_ms(),
        surface,
        plugin_id: plugin_id.map(|s| s.to_string()),
        command: command.to_string(),
        process_name: target.process_name.clone(),
        window_title: target.window_title.clone(),
        decision: AuditDecision::Deny,
        reason: Some(format!("{err}")),
        duration_ms: started.elapsed().as_millis() as u64,
        error: Some(err_to_string(err)),
    })
}

fn record_allow<T>(
    audit: &AuditRing,
    command: &str,
    surface: Surface,
    plugin_id: Option<&str>,
    target: &TargetMeta,
    started: Instant,
    result: &Result<T>,
) -> AuditEntry {
    let (decision, error) = match result {
        Ok(_) => (AuditDecision::Allow, None),
        Err(e) => (AuditDecision::Allow, Some(err_to_string(e))),
    };
    audit.record(AuditEntry {
        id: String::new(),
        ts: now_ms(),
        surface,
        plugin_id: plugin_id.map(|s| s.to_string()),
        command: command.to_string(),
        process_name: target.process_name.clone(),
        window_title: target.window_title.clone(),
        decision,
        reason: None,
        duration_ms: started.elapsed().as_millis() as u64,
        error,
    })
}

fn emit_audit(app: &tauri::AppHandle, entry: &AuditEntry) {
    if let Err(err) = app.emit("automation:event", entry) {
        log::warn!("automation:event emit failed: {err}");
    }
}

/// Optional payload every command accepts to identify the calling surface.
/// The TS client wraps this around every invoke. We default to `Workflow`
/// when absent so an accidentally-untagged call doesn't elevate privileges.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallContext {
    #[serde(default)]
    pub surface: Option<Surface>,
    #[serde(default)]
    pub plugin_id: Option<String>,
    #[serde(default)]
    pub process_name: Option<String>,
    #[serde(default)]
    pub window_title: Option<String>,
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


macro_rules! command_body {
    (
        $app:ident, $state:ident, $ctx:ident, $cmd_name:expr,
        $do_call:expr
    ) => {{
        let started = Instant::now();
        let surface = $ctx.surface();
        let plugin_id = $ctx.plugin_id.clone();
        let target = $ctx.target();
        let call = Call {
            command: $cmd_name,
            surface,
            plugin_id: plugin_id.as_deref(),
            target: target.clone(),
        };
        match $state.gate.evaluate(&call) {
            Decision::Deny(err) => {
                let entry = record_deny(
                    &$state.audit,
                    $cmd_name,
                    surface,
                    plugin_id.as_deref(),
                    &target,
                    &err,
                    started,
                );
                emit_audit(&$app, &entry);
                Err(err_to_string(&err))
            }
            Decision::RequireConsent { prompt } => {
                // M2 lands the renderer-side HITL handshake. For M1 we emit a
                // consent-request event for visibility and treat the call as
                // declined so it always lands deterministically.
                let _ = $app.emit("automation:consent-request", &prompt);
                let err = AutomationError::UserDeclined;
                let entry = AuditEntry {
                    id: String::new(),
                    ts: now_ms(),
                    surface,
                    plugin_id: plugin_id.clone(),
                    command: $cmd_name.to_string(),
                    process_name: target.process_name.clone(),
                    window_title: target.window_title.clone(),
                    decision: AuditDecision::Consent,
                    reason: Some("M1 stub — consent UI not yet wired".into()),
                    duration_ms: started.elapsed().as_millis() as u64,
                    error: Some(err_to_string(&err)),
                };
                let recorded = $state.audit.record(entry);
                emit_audit(&$app, &recorded);
                Err(err_to_string(&err))
            }
            Decision::Allow => {
                let result = $do_call;
                let entry = record_allow(
                    &$state.audit,
                    $cmd_name,
                    surface,
                    plugin_id.as_deref(),
                    &target,
                    started,
                    &result,
                );
                emit_audit(&$app, &entry);
                result.map_err(|e| err_to_string(&e))
            }
        }
    }};
}

#[tauri::command]
pub async fn desktop_capabilities(
    state: State<'_, AutomationState>,
) -> std::result::Result<Capabilities, String> {
    // Capabilities is a probe — no permission gate needed. It just reports
    // what the back-end advertises, never touches the desktop.
    state
        .handle
        .capabilities()
        .await
        .map_err(|e| err_to_string(&e))
}

#[tauri::command]
pub async fn desktop_get_focus(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    ctx: Option<CallContext>,
) -> std::result::Result<ElementInfo, String> {
    let ctx = ctx.unwrap_or_default();
    command_body!(app, state, ctx, "get_focus", state.handle.get_focus().await)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTreeArgs {
    #[serde(default)]
    pub root: Option<ElementRef>,
    #[serde(default)]
    pub opts: TreeOpts,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_read_tree(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: ReadTreeArgs,
) -> std::result::Result<Vec<ElementInfo>, String> {
    let ctx = args.ctx;
    let root = args.root;
    let opts = args.opts;
    command_body!(
        app,
        state,
        ctx,
        "read_tree",
        state.handle.read_tree(root.clone(), opts.clone()).await
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindArgs {
    pub locator: Locator,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_find(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: FindArgs,
) -> std::result::Result<Option<ElementRef>, String> {
    let ctx = args.ctx;
    let locator = args.locator;
    command_body!(app, state, ctx, "find", state.handle.find(locator.clone()).await)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotArgs {
    #[serde(default)]
    pub opts: ScreenshotOpts,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_screenshot(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: ScreenshotArgs,
) -> std::result::Result<Screenshot, String> {
    let ctx = args.ctx;
    let opts = args.opts;
    command_body!(
        app,
        state,
        ctx,
        "screenshot",
        state.handle.screenshot(opts.clone()).await
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickArgs {
    pub target: ClickTarget,
    #[serde(default)]
    pub opts: ClickOpts,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_click(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: ClickArgs,
) -> std::result::Result<(), String> {
    let ctx = args.ctx;
    let target = args.target;
    let opts = args.opts;
    command_body!(
        app,
        state,
        ctx,
        "click",
        state.handle.click(target.clone(), opts.clone()).await
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeArgs {
    pub text: String,
    #[serde(default)]
    pub opts: TypeOpts,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_type(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: TypeArgs,
) -> std::result::Result<(), String> {
    let ctx = args.ctx;
    let text = args.text;
    let opts = args.opts;
    command_body!(
        app,
        state,
        ctx,
        "type",
        state.handle.type_text(text.clone(), opts.clone()).await
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysArgs {
    pub chord: KeyChord,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_keys(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: KeysArgs,
) -> std::result::Result<(), String> {
    let ctx = args.ctx;
    let chord = args.chord;
    command_body!(app, state, ctx, "keys", state.handle.send_keys(chord.clone()).await)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokePatternArgs {
    pub target: ElementRef,
    pub pattern: PatternKind,
    #[serde(default)]
    pub args: serde_json::Value,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_invoke_pattern(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: InvokePatternArgs,
) -> std::result::Result<serde_json::Value, String> {
    let ctx = args.ctx;
    let target = args.target;
    let pattern = args.pattern;
    let pargs = args.args;
    command_body!(
        app,
        state,
        ctx,
        "invoke_pattern",
        state
            .handle
            .invoke_pattern(target.clone(), pattern, pargs.clone())
            .await
    )
}

#[tauri::command]
pub async fn automation_audit_snapshot(
    state: State<'_, AutomationState>,
) -> std::result::Result<Vec<AuditEntry>, String> {
    Ok(state.audit.snapshot())
}

#[tauri::command]
pub async fn automation_settings_get(
    state: State<'_, AutomationState>,
) -> std::result::Result<super::permission::AutomationSettings, String> {
    Ok(state.gate.settings())
}

#[tauri::command]
pub async fn automation_settings_set(
    state: State<'_, AutomationState>,
    settings: super::permission::AutomationSettings,
) -> std::result::Result<(), String> {
    state.gate.update(|s| *s = settings);
    Ok(())
}

#[tauri::command]
pub async fn automation_kill_switch(
    state: State<'_, AutomationState>,
) -> std::result::Result<(), String> {
    state.gate.engage_kill_switch();
    Ok(())
}
