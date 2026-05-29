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
use super::consent::ConsentBroker;
use super::permission::{PermissionGate, Surface, TargetMeta, Tier};
use super::policy::{Policy, PolicyState};
use super::dispatcher;
use super::types::*;
use super::worker::AutomationHandle;
use super::virtual_display::{
    self, ArmOutcome, ReleaseReason, VirtualDisplayController, VirtualDisplayHealth,
};

/// Bundled state that every automation command pulls from `tauri::State`.
pub struct AutomationState {
    pub handle: AutomationHandle,
    pub gate: PermissionGate,
    pub audit: AuditRing,
    /// Per-call HITL consent broker — used when the active tier resolves to
    /// `PerCall` and the action is a driving call. The broker emits Tauri
    /// events that the renderer-side overlay listens to, and resolves the
    /// pending `oneshot::Receiver` via the `automation_consent_respond`
    /// command.
    pub consent: ConsentBroker,
    /// ADR-0028 / T5 — per-action policy applied AFTER the permission
    /// gate resolves Allow for a `ComputerUse` surface call. Empty policy
    /// (the default) is a fast-path no-op so installs that never edit
    /// the policy pay zero overhead.
    pub policy: PolicyState,
    /// Screen-off Computer Use — owns the bundled virtual-display lifecycle.
    /// `arm()`-ed by the plugin before a screen-off `computer` action;
    /// `force_release()`-ed by the kill switch / session close.
    pub virtual_display: VirtualDisplayController,
    /// ADR-0020 remote-target — registry of running cua desktop sandboxes.
    /// `cua_route::*` resolves a live `CuaRemoteClient` from here when a
    /// `CallContext` carries a remote sandbox connection id.
    pub cua: crate::cua_sandbox::CuaSandboxRegistry,
}

impl AutomationState {
    pub fn new(
        handle: AutomationHandle,
        gate: PermissionGate,
        audit: AuditRing,
        consent: ConsentBroker,
        policy: PolicyState,
        virtual_display: VirtualDisplayController,
        cua: crate::cua_sandbox::CuaSandboxRegistry,
    ) -> Self {
        Self {
            handle,
            gate,
            audit,
            consent,
            policy,
            virtual_display,
            cua,
        }
    }
}

/// Mirror of `AuditDecision` for the wire — uses the same SCREAMING_SNAKE_CASE
/// reason tagging as `AutomationError` so the renderer can deserialize either.
pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Convert an `AutomationError` into a String for the Tauri Result. Tauri
/// requires `Result<T, E: Serialize>`; serializing the enum directly is
/// preferable but the existing codebase returns String for compatibility.
/// We serialize as JSON so the TS side can `JSON.parse` to recover the tag.
pub(crate) fn err_to_string(err: &AutomationError) -> String {
    serde_json::to_string(err).unwrap_or_else(|_| format!("{err}"))
}

/// Common path: turn a `Decision::Deny` into the recorded audit + final
/// stringified error. Returns the AuditEntry for emit.
pub(crate) fn record_deny(
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

pub(crate) fn record_allow<T>(
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

pub(crate) fn emit_audit(app: &tauri::AppHandle, entry: &AuditEntry) {
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
    /// ADR-0028 / T5 — best-effort URL for browser-driving actions. The
    /// renderer supplies this when the active target is a browser tab so
    /// the per-action policy's `allowed_url_patterns` can fire.
    #[serde(default)]
    pub target_url: Option<String>,
    /// ADR-0028 / T5 — pixel x for coordinate-based actions (click /
    /// drag / mouse_move). Used to evaluate `forbidden_screen_regions`.
    #[serde(default)]
    pub click_x: Option<i32>,
    /// ADR-0028 / T5 — pixel y for coordinate-based actions.
    #[serde(default)]
    pub click_y: Option<i32>,
    /// ADR-0020 W1 — per-call tier upgrade originating from
    /// `Character.computerUseSettings.requireConsent`. When `Some(PerCall)`,
    /// the dispatcher upgrades a gate `Allow` for a driving call to
    /// `RequireConsent` so the operator is prompted on every action
    /// regardless of the persisted surface tier. Other variants are
    /// honoured by `permission::maybe_upgrade_to_consent` (today only
    /// `PerCall` actually moves the dial; `None` / others pass through).
    #[serde(default)]
    pub force_tier: Option<Tier>,
    /// ADR-0020 remote-target — when set, the action runs against the cua
    /// sandbox with this connection id instead of the local host. Empty /
    /// absent = local. Resolved per-session from `computerUseTarget`
    /// (`lib/automation/sandbox-target.ts`).
    #[serde(default)]
    pub sandbox_connection_id: Option<String>,
}

impl CallContext {
    fn surface(&self) -> Surface {
        self.surface.unwrap_or(Surface::Workflow)
    }

    /// The remote sandbox connection id, if this call targets one. `None`
    /// (incl. empty string) means the local host backend.
    pub fn remote_connection_id(&self) -> Option<&str> {
        self.sandbox_connection_id
            .as_deref()
            .filter(|s| !s.is_empty())
    }

    /// Project the renderer-supplied context into the borrow-tied
    /// [`ActionFacts`](super::policy::ActionFacts) the policy engine matches
    /// against. Mirrors `dispatcher::GateContext::facts`; production gating
    /// runs on the converted `GateContext`, so this helper is test-only.
    #[cfg(test)]
    fn facts(&self) -> super::policy::ActionFacts<'_> {
        super::policy::ActionFacts {
            process_name: self.process_name.as_deref(),
            window_title: self.window_title.as_deref(),
            target_url: self.target_url.as_deref(),
            click_x: self.click_x,
            click_y: self.click_y,
        }
    }
}


/// Record a T5 policy-deny audit row and emit it. Returns the typed
/// `AutomationError` so the caller can stringify for the Tauri Result.
pub(crate) fn record_policy_deny(
    audit: &AuditRing,
    command: &str,
    surface: Surface,
    plugin_id: Option<&str>,
    target: &TargetMeta,
    reason: &str,
    started: Instant,
) -> (AuditEntry, AutomationError) {
    let err = AutomationError::PermissionDenied {
        reason: format!("policy_deny: {reason}"),
    };
    let entry = audit.record(AuditEntry {
        id: String::new(),
        ts: now_ms(),
        surface,
        plugin_id: plugin_id.map(|s| s.to_string()),
        command: command.to_string(),
        process_name: target.process_name.clone(),
        window_title: target.window_title.clone(),
        decision: AuditDecision::Deny,
        reason: Some(format!("policy_deny: {reason}")),
        duration_ms: started.elapsed().as_millis() as u64,
        error: Some(err_to_string(&err)),
    });
    (entry, err)
}

/// Thin shim over the shared `dispatcher::run_gated` pipeline. Kept as a macro
/// so each `desktop_*` command can pass its `state.handle.METHOD(..).await`
/// expression inline (the args are `.clone()`d, so the wrapping closure borrows
/// rather than moves). The gate → consent → T5 policy → audit logic lives once
/// in `dispatcher::run_gated`; this just adapts the renderer `CallContext` into
/// a `GateContext` and stringifies the typed error for the Tauri boundary.
macro_rules! command_body {
    (
        $app:ident, $state:ident, $ctx:ident, $cmd_name:expr,
        $do_call:expr
    ) => {{
        let gctx = $crate::automation::dispatcher::GateContext {
            surface: $ctx.surface(),
            plugin_id: $ctx.plugin_id.clone(),
            process_name: $ctx.process_name.clone(),
            window_title: $ctx.window_title.clone(),
            target_url: $ctx.target_url.clone(),
            click_x: $ctx.click_x,
            click_y: $ctx.click_y,
            force_tier: $ctx.force_tier,
        };
        $crate::automation::dispatcher::run_gated(
            Some(&$app),
            $state.inner(),
            gctx,
            $cmd_name,
            || async { $do_call },
        )
        .await
        .map_err(|e| err_to_string(&e))
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
    command_body!(
        app,
        state,
        ctx,
        "get_focus",
        super::cua_route::get_focus(&state.handle, &state.cua, ctx.remote_connection_id()).await
    )
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
        super::cua_route::read_tree(&state.handle, &state.cua, ctx.remote_connection_id(), root.clone(), opts.clone()).await
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
    command_body!(
        app,
        state,
        ctx,
        "find",
        super::cua_route::find(&state.handle, &state.cua, ctx.remote_connection_id(), locator.clone()).await
    )
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
    // ADR-0020 W1 — redact when the operator opted in AND a credential
    // window is on screen. We post-process inside the same command body
    // so the audit row still records a successful screenshot (with a
    // separate `error: None`, `decision: "allow"`), but the bytes the
    // model sees are a black image of identical dimensions.
    let redact_enabled = state.gate.settings().redact_screenshots;
    command_body!(app, state, ctx, "screenshot", async {
        let shot = super::cua_route::screenshot(&state.handle, &state.cua, ctx.remote_connection_id(), opts.clone()).await?;
        if redact_enabled
            && super::platform::shared::credential_window::is_credential_window_focused()
        {
            super::platform::shared::screenshot::redact_screenshot(shot)
        } else {
            Ok(shot)
        }
    }.await)
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
        super::cua_route::click(&state.handle, &state.cua, ctx.remote_connection_id(), target.clone(), opts.clone()).await
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
        super::cua_route::type_text(&state.handle, &state.cua, ctx.remote_connection_id(), text.clone(), opts.clone()).await
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
    command_body!(
        app,
        state,
        ctx,
        "keys",
        super::cua_route::send_keys(&state.handle, &state.cua, ctx.remote_connection_id(), chord.clone()).await
    )
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
        super::cua_route::invoke_pattern(&state.handle, &state.cua, ctx.remote_connection_id(), target.clone(), pattern, pargs.clone())
            .await
    )
}

/// Canonical single-envelope entry point. Every wire format that carries a
/// serialized [`Action`] — the External Bridge MCP proxy and the renderer's
/// `desktop.*` client — routes through here so the gate / consent / policy /
/// audit pipeline and the backend dispatch live in exactly one place. The
/// granular `desktop_*` commands remain for the inspector/workflow callers
/// that build typed args; both ultimately reach `dispatcher::execute_action`.
#[tauri::command]
pub async fn automation_execute(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    action: Action,
    ctx: Option<CallContext>,
) -> std::result::Result<ActionOutput, String> {
    let ctx = ctx.unwrap_or_default();
    // Derive click coords from the action's target so the T5 policy's
    // forbidden-region check fires without the renderer passing them; fall
    // back to any explicit ctx coords for element-targeted actions.
    let point = action.point();
    let command = action.command();
    let handle = state.handle.clone();
    let cua = state.cua.clone();
    let remote = ctx.sandbox_connection_id.clone();
    let gctx = dispatcher::GateContext {
        surface: ctx.surface(),
        plugin_id: ctx.plugin_id.clone(),
        process_name: ctx.process_name.clone(),
        window_title: ctx.window_title.clone(),
        target_url: ctx.target_url.clone(),
        click_x: point.map(|p| p.x).or(ctx.click_x),
        click_y: point.map(|p| p.y).or(ctx.click_y),
        force_tier: ctx.force_tier,
    };
    dispatcher::run_gated(Some(&app), state.inner(), gctx, command, move || async move {
        let remote = remote.as_deref().filter(|s| !s.is_empty());
        dispatcher::execute_action(&handle, &cua, remote, action).await
    })
    .await
    .map_err(|e| err_to_string(&e))
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
    // Persist before mutating the in-memory gate so a configured tier survives
    // a restart (ADR-0020). Best-effort: a disk failure is logged, not fatal.
    super::persist::save_settings(&settings);
    state.gate.update(|s| *s = settings);
    Ok(())
}

#[tauri::command]
pub async fn automation_kill_switch(
    state: State<'_, AutomationState>,
) -> std::result::Result<(), String> {
    state.gate.engage_kill_switch();
    // The kill switch also clears any "Always allow this session" grants —
    // engaging the switch should drop ALL trust, not just freeze the engine.
    state.consent.clear_session_grants();
    // Drop the screen-off virtual display too (restores the prior topology) —
    // engaging the switch should hand the screen back immediately.
    state.virtual_display.force_release(ReleaseReason::KillSwitch);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen-off Computer Use — virtual display commands (ADR-0020 follow-up).
// ─────────────────────────────────────────────────────────────────────────────

/// Read-only health snapshot for the Settings → Automation → Screen-off card.
/// Overlays the live controller status (active monitor / last error) onto the
/// platform + driver-install probe. Cheap; safe to poll.
#[tauri::command]
pub async fn virtual_display_health_probe(
    state: State<'_, AutomationState>,
) -> std::result::Result<VirtualDisplayHealth, String> {
    let mut health = virtual_display::probe_health();
    let status = state.virtual_display.status();
    if let Some(monitor) = status.active_monitor {
        health.active_monitor = monitor;
    }
    if let Some(err) = status.last_error {
        if !err.is_empty() {
            health.last_error = err;
        }
    }
    Ok(health)
}

/// Trigger the UAC-elevated bundled virtual-display driver install. The setup
/// binary's manifest requests administrator, so launching it surfaces the UAC
/// prompt. Mirrors the sandbox `first_time_setup` shape.
#[tauri::command]
pub async fn virtual_display_setup() -> std::result::Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("cognia-vdd-setup.exe")))
            .unwrap_or_else(|| std::path::PathBuf::from("cognia-vdd-setup.exe"));
        // Elevate via `Start-Process -Verb RunAs` — surfaces the UAC prompt
        // (mirrors how the sandbox setup binary is elevated). We treat marker
        // presence as the source of truth for success rather than trusting the
        // PowerShell wrapper's exit code.
        let ps = format!(
            "Start-Process -FilePath '{}' -ArgumentList '--install' -Verb RunAs -Wait",
            exe.to_string_lossy().replace('\'', "''")
        );
        Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .status()
            .map_err(|e| format!("elevation launch failed: {e}"))?;
        let installed = virtual_display::marker_path()
            .map(|p| p.exists())
            .unwrap_or(false);
        if !installed {
            return Err(
                "virtual display setup did not complete — the UAC prompt may have been denied"
                    .into(),
            );
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Screen-off mode is Windows-only.".into())
    }
}

/// Probe summary for the "Test screen-off capture" button.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualDisplayProbeResult {
    pub width: u32,
    pub height: u32,
    pub non_black: bool,
    pub monitor: String,
}

/// One-shot capture probe: ensure a virtual display, screenshot it,
/// heuristically check the frame isn't uniformly black, then release. Returns
/// a summary — NOT the image bytes (no 4K PNG over IPC for a health check).
#[tauri::command]
pub async fn virtual_display_probe(
    state: State<'_, AutomationState>,
) -> std::result::Result<VirtualDisplayProbeResult, String> {
    // `arm()` blocks on the controller thread (it acquires + sets primary);
    // keep it off the async runtime.
    let controller = state.virtual_display.clone();
    let outcome = tokio::task::spawn_blocking(move || controller.arm())
        .await
        .map_err(|e| format!("arm task join failed: {e}"))?;
    let monitor = match outcome {
        ArmOutcome::Acquired { monitor } => monitor,
        ArmOutcome::AlreadyActive => {
            state.virtual_display.status().active_monitor.unwrap_or_default()
        }
        ArmOutcome::Unavailable(reason) => return Err(reason),
    };
    let shot = state
        .handle
        .screenshot(super::types::ScreenshotOpts::default())
        .await
        .map_err(|e| format!("screenshot failed: {e}"));
    // Always release after the probe regardless of the capture result.
    state.virtual_display.force_release(ReleaseReason::Manual);
    let shot = shot?;
    // Lightweight non-black heuristic: a uniformly black PNG compresses to a
    // few hundred bytes; a real desktop frame is far larger. We avoid decoding
    // (the `image` crate is feature-gated off by default) — the rigorous black
    // check is the on-hardware acceptance step in the plan.
    let approx_bytes = shot.bytes.len() * 3 / 4;
    Ok(VirtualDisplayProbeResult {
        width: shot.width,
        height: shot.height,
        non_black: approx_bytes > 8_192,
        monitor,
    })
}

/// Outcome of arming the virtual display before a screen-off action.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualDisplayArmResult {
    /// `"acquired"` | `"alreadyActive"` | `"unavailable"`.
    pub status: String,
    pub monitor: String,
    pub error: String,
}

/// ENTER hook for the live chat path (`dispatchAnthropicAction`): ensure the
/// virtual display is active + primary before a screen-off `computer` action.
/// Idempotent — re-arms the idle timer when already active. Returns
/// `status: "unavailable"` (with a reason) so the renderer fails strictly
/// rather than capturing a black frame.
#[tauri::command]
pub async fn virtual_display_arm(
    state: State<'_, AutomationState>,
) -> std::result::Result<VirtualDisplayArmResult, String> {
    let controller = state.virtual_display.clone();
    let outcome = tokio::task::spawn_blocking(move || controller.arm())
        .await
        .map_err(|e| format!("arm task join failed: {e}"))?;
    Ok(match outcome {
        ArmOutcome::Acquired { monitor } => VirtualDisplayArmResult {
            status: "acquired".into(),
            monitor,
            error: String::new(),
        },
        ArmOutcome::AlreadyActive => VirtualDisplayArmResult {
            status: "alreadyActive".into(),
            monitor: state.virtual_display.status().active_monitor.unwrap_or_default(),
            error: String::new(),
        },
        ArmOutcome::Unavailable(reason) => VirtualDisplayArmResult {
            status: "unavailable".into(),
            monitor: String::new(),
            error: reason,
        },
    })
}

/// Release args — `session_id` is accepted for forward-compatibility with
/// per-session displays (Phase 2); the controller is process-global today.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualDisplayReleaseArgs {
    #[serde(default)]
    pub session_id: Option<String>,
}

/// Release the virtual display when a chat session closes — the EXIT signal
/// piggybacked on the renderer's session-close path.
#[tauri::command]
pub async fn virtual_display_release(
    state: State<'_, AutomationState>,
    args: VirtualDisplayReleaseArgs,
) -> std::result::Result<(), String> {
    let _ = args.session_id;
    state
        .virtual_display
        .force_release(ReleaseReason::SessionClosed);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// M5 completion: new desktop_* commands. Each goes through the same
// `command_body!` macro so permission/consent/audit are uniform.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseMoveArgs {
    pub point: Point,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_mouse_move(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: MouseMoveArgs,
) -> std::result::Result<(), String> {
    let ctx = args.ctx;
    let point = args.point;
    command_body!(
        app,
        state,
        ctx,
        "mouse_move",
        super::cua_route::mouse_move(&state.handle, &state.cua, ctx.remote_connection_id(), point).await
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragArgs {
    pub from: Point,
    pub to: Point,
    #[serde(default)]
    pub opts: DragOpts,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_drag(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: DragArgs,
) -> std::result::Result<(), String> {
    let ctx = args.ctx;
    let from = args.from;
    let to = args.to;
    let opts = args.opts;
    command_body!(
        app,
        state,
        ctx,
        "drag",
        super::cua_route::drag(&state.handle, &state.cua, ctx.remote_connection_id(), from, to, opts.clone()).await
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollArgs {
    pub target: ScrollTarget,
    #[serde(default)]
    pub opts: ScrollOpts,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_scroll(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: ScrollArgs,
) -> std::result::Result<(), String> {
    let ctx = args.ctx;
    let target = args.target;
    let opts = args.opts;
    command_body!(
        app,
        state,
        ctx,
        "scroll",
        super::cua_route::scroll(&state.handle, &state.cua, ctx.remote_connection_id(), target.clone(), opts).await
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldKeyArgs {
    pub chord: KeyChord,
    pub duration_ms: u32,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_hold_key(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: HoldKeyArgs,
) -> std::result::Result<(), String> {
    let ctx = args.ctx;
    let chord = args.chord;
    let duration_ms = args.duration_ms;
    command_body!(
        app,
        state,
        ctx,
        "hold_key",
        super::cua_route::hold_key(&state.handle, &state.cua, ctx.remote_connection_id(), chord.clone(), duration_ms).await
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseButtonArgs {
    pub button: MouseButton,
    pub transition: ButtonTransition,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_mouse_button(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: MouseButtonArgs,
) -> std::result::Result<(), String> {
    let ctx = args.ctx;
    let button = args.button;
    let transition = args.transition;
    command_body!(
        app,
        state,
        ctx,
        "mouse_button",
        super::cua_route::mouse_button(&state.handle, &state.cua, ctx.remote_connection_id(), button, transition).await
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOpArgs {
    pub target: ElementRef,
    pub op: WindowOp,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_window_op(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: WindowOpArgs,
) -> std::result::Result<(), String> {
    let ctx = args.ctx;
    let target = args.target;
    let op = args.op;
    command_body!(
        app,
        state,
        ctx,
        "window_op",
        super::cua_route::window_op(&state.handle, &state.cua, ctx.remote_connection_id(), target.clone(), op.clone()).await
    )
}

#[tauri::command]
pub async fn desktop_cursor_position(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    ctx: Option<CallContext>,
) -> std::result::Result<Point, String> {
    let ctx = ctx.unwrap_or_default();
    command_body!(
        app,
        state,
        ctx,
        "cursor_position",
        super::cua_route::cursor_position(&state.handle, &state.cua, ctx.remote_connection_id()).await
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickAtPointArgs {
    pub point: Point,
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_pick_at_point(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: PickAtPointArgs,
) -> std::result::Result<ElementInfo, String> {
    let ctx = args.ctx;
    let point = args.point;
    command_body!(
        app,
        state,
        ctx,
        "pick_at_point",
        super::cua_route::pick_at_point(&state.handle, &state.cua, ctx.remote_connection_id(), point).await
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Consent response. The renderer-side overlay invokes this when the user
// clicks Allow once / Always allow this session / Reject. `prompt` is
// optional — only used when `allow && persist` so the broker can register
// the session grant against the same tuple as the original request.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRespondArgs {
    pub id: String,
    pub allow: bool,
    #[serde(default)]
    pub persist: bool,
    #[serde(default)]
    pub prompt: Option<super::permission::ConsentPrompt>,
}

#[tauri::command]
pub async fn automation_consent_respond(
    state: State<'_, AutomationState>,
    args: ConsentRespondArgs,
) -> std::result::Result<(), String> {
    state
        .consent
        .resolve(&args.id, args.allow, args.persist, args.prompt.as_ref());
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0028 / T5 — per-action policy persistence. The renderer writes the
// policy via `automation_policy_set` whenever the user edits the editor
// card; reads via `automation_policy_get` on mount + after writes for
// round-trip confidence. The dispatcher consults `PolicyState` directly,
// so writes take effect on the very next call without a restart.
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn automation_policy_get(
    state: State<'_, AutomationState>,
) -> std::result::Result<Policy, String> {
    Ok(state.policy.get())
}

#[tauri::command]
pub async fn automation_policy_set(
    state: State<'_, AutomationState>,
    policy: Policy,
) -> std::result::Result<(), String> {
    // ADR-0020 W1 — `PolicyState::set` now compiles regex up-front; map
    // a compile failure to the same JSON-error shape used elsewhere
    // (the renderer's policy editor displays it inline so the operator
    // can correct the offending row instead of every action silently
    // failing later). Only persist once the in-memory set succeeds, so a
    // bad regex never lands on disk to brick the next boot.
    state.policy.set(policy.clone()).map_err(|e| e.to_string())?;
    super::persist::save_policy(&policy);
    Ok(())
}

/// ADR-0020 W1 — pick-session lifecycle commands.
///
/// The Inspector's "Pick" affordance used to race a 3-second countdown:
/// the user had to position the cursor on the target before T-0 expired,
/// then `pick_at_point` resolved an `ElementInfo` from the cursor's
/// position. Two issues:
///
///   1. **No audit trail.** Operators couldn't tell from the audit log
///      that a pick was attempted; only the resulting `pick_at_point`
///      call showed up, indistinguishable from a workflow-driven pick.
///   2. **Countdown race.** A 3-second wait was awkward when the user
///      was already ready, and panic-inducing when the cursor needed
///      careful placement.
///
/// W1 ships `desktop_pick_session_start` (records intent, the renderer
/// then enables an "Instant Capture" button + still runs the countdown
/// as a fallback) and `desktop_pick_session_cancel` (clears the
/// in-progress flag, records the cancel). Both go through `command_body!`
/// so audit captures the pick lifecycle. The full WH_MOUSE_LL overlay
/// rewrite (where the user clicks anywhere to capture without racing a
/// timer) is tracked separately in the Wave 3 follow-up — it requires a
/// transparent webview window with cross-process click handling that
/// outweighs W1's "state-honest" scope.
///
/// macOS / Linux land at the same audit row but the underlying
/// `pick_at_point` returns `UnsupportedPlatform` until the Wave 2
/// shell-out backend ships (osascript / xdotool).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickSessionStartArgs {
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_pick_session_start(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: PickSessionStartArgs,
) -> std::result::Result<(), String> {
    let ctx = args.ctx;
    command_body!(app, state, ctx, "pick_session_start", async {
        // No backend dispatch — this is an audit-only marker so the
        // operator can see that a pick was initiated. The actual
        // `pick_at_point` call follows once the renderer captures the
        // cursor coordinate.
        Ok::<(), AutomationError>(())
    }.await)
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PickSessionCancelArgs {
    #[serde(default)]
    pub ctx: CallContext,
}

#[tauri::command]
pub async fn desktop_pick_session_cancel(
    app: tauri::AppHandle,
    state: State<'_, AutomationState>,
    args: Option<PickSessionCancelArgs>,
) -> std::result::Result<(), String> {
    let ctx = args.unwrap_or_default().ctx;
    command_body!(app, state, ctx, "pick_session_cancel", async {
        Ok::<(), AutomationError>(())
    }.await)
}

/// ADR-0020 W1 — pull (and clear) the most recent backend init failure.
/// The Overview tab calls this once on mount so a failure that happened
/// before any renderer attached an event listener for
/// `automation:backend-init-failed` is still rendered as a destructive
/// `<Alert>`. Returns `None` when no failure is pending — the common
/// case on healthy installs.
#[tauri::command]
pub async fn automation_drain_init_failure(
) -> std::result::Result<Option<super::InitFailure>, String> {
    Ok(super::drain_init_failure())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring() -> AuditRing {
        AuditRing::new()
    }

    fn target(proc: &str) -> TargetMeta {
        TargetMeta {
            process_name: Some(proc.into()),
            window_title: Some("test window".into()),
        }
    }

    #[test]
    fn record_policy_deny_writes_policy_deny_reason() {
        let ring = ring();
        let started = Instant::now();
        let (entry, err) = record_policy_deny(
            &ring,
            "click",
            Surface::ComputerUse,
            None,
            &target("Notepad"),
            "process name not in allowlist",
            started,
        );
        assert_eq!(entry.decision, AuditDecision::Deny);
        assert_eq!(entry.surface, Surface::ComputerUse);
        assert_eq!(
            entry.reason.as_deref(),
            Some("policy_deny: process name not in allowlist")
        );
        // The error string the renderer sees is a JSON-serialized
        // PermissionDenied with the policy_deny prefix.
        let err_json = err_to_string(&err);
        assert!(
            err_json.contains("policy_deny"),
            "expected policy_deny tag in: {err_json}"
        );
        // The audit ring grew by one row.
        assert_eq!(ring.len(), 1);
    }

    #[test]
    fn record_policy_deny_emits_into_audit_ring() {
        let ring = ring();
        let started = Instant::now();
        record_policy_deny(
            &ring,
            "type",
            Surface::ComputerUse,
            Some("plugin-x"),
            &target("Chrome"),
            "url did not match allowlist",
            started,
        );
        let snap = ring.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].plugin_id.as_deref(), Some("plugin-x"));
        assert_eq!(snap[0].command, "type");
        assert!(snap[0].error.is_some());
    }

    #[test]
    fn call_context_builds_facts_from_optional_fields() {
        let ctx = CallContext {
            surface: Some(Surface::ComputerUse),
            plugin_id: None,
            process_name: Some("Chrome".into()),
            window_title: Some("Inbox".into()),
            target_url: Some("https://mail.example/".into()),
            click_x: Some(123),
            click_y: Some(456),
            force_tier: None,
        };
        let facts = ctx.facts();
        assert_eq!(facts.process_name, Some("Chrome"));
        assert_eq!(facts.window_title, Some("Inbox"));
        assert_eq!(facts.target_url, Some("https://mail.example/"));
        assert_eq!(facts.click_x, Some(123));
        assert_eq!(facts.click_y, Some(456));
    }

    #[test]
    fn call_context_force_tier_round_trips_through_deserialization() {
        // Wire-shape sanity: the sidecar forwards `forceTier` as a
        // camelCase string ("perCall"); our serde rename must accept it
        // and the typed value must thread through `maybe_upgrade_to_consent`.
        let raw = serde_json::json!({
            "surface": "computerUse",
            "forceTier": "perCall",
        });
        let ctx: CallContext = serde_json::from_value(raw).unwrap();
        assert_eq!(ctx.force_tier, Some(Tier::PerCall));
        assert_eq!(ctx.surface(), Surface::ComputerUse);
    }

    #[test]
    fn call_context_force_tier_absent_deserializes_as_none() {
        let raw = serde_json::json!({ "surface": "computerUse" });
        let ctx: CallContext = serde_json::from_value(raw).unwrap();
        assert!(ctx.force_tier.is_none());
    }


    #[test]
    fn call_context_defaults_surface_to_workflow() {
        let ctx = CallContext::default();
        assert_eq!(ctx.surface(), Surface::Workflow);
        let facts = ctx.facts();
        assert!(facts.process_name.is_none());
        assert!(facts.window_title.is_none());
        assert!(facts.target_url.is_none());
        assert!(facts.click_x.is_none());
        assert!(facts.click_y.is_none());
    }
}
