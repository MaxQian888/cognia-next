//! Unified automation dispatcher.
//!
//! Every entry point into the automation backend — the renderer `desktop_*`
//! commands, the computer-use plugin's native tools, and the External Bridge
//! MCP proxy — funnels through here so the permission gate, HITL consent, T5
//! per-action policy, and audit trail are applied in exactly one place.
//!
//! Two pieces:
//!
//! * [`run_gated`] — the gate → consent → policy → run → audit skeleton. This
//!   replaces the old `command_body!` macro body and the computer-use plugin's
//!   bespoke `with_gate` (which silently skipped the T5 policy step). It takes
//!   an `Option<&AppHandle>`: `Some` for renderer/plugin calls that can show
//!   the consent overlay, `None` for the headless MCP proxy where a
//!   `RequireConsent` decision can only resolve to *deny* (no overlay exists).
//!   Audit rows are always recorded in the ring; they are only *emitted* to
//!   the renderer when an `AppHandle` is present.
//!
//! * [`execute_action`] — maps the canonical [`Action`] onto the worker's
//!   `AutomationHandle` methods (and `tool_exec` for bash / text-editor). The
//!   single match site every wire format converges on.

use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::audit::{AuditEntry, AuditRing, Decision as AuditDecision};
use super::commands::{
    emit_audit, err_to_string, now_ms, record_allow, record_deny, record_policy_deny,
    AutomationState,
};
use super::consent::ConsentBroker;
use super::permission::{
    maybe_upgrade_to_consent, Call, Decision, PermissionGate, Surface, TargetMeta, Tier,
};
use super::policy::{ActionFacts, Decision as PolicyDecision, PolicyState};
use super::tool_exec;
use super::types::*;
use super::worker::AutomationHandle;

/// Everything the gate / policy / audit pipeline needs about a call, owned so
/// the future has no borrow ties to the caller's `CallContext`. Built from the
/// renderer `CallContext` (via the `command_body!` macro) or assembled by the
/// plugin / proxy entry points.
pub struct GateContext {
    pub surface: Surface,
    pub plugin_id: Option<String>,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
    pub target_url: Option<String>,
    pub click_x: Option<i32>,
    pub click_y: Option<i32>,
    pub force_tier: Option<Tier>,
}

impl GateContext {
    fn target(&self) -> TargetMeta {
        TargetMeta {
            process_name: self.process_name.clone(),
            window_title: self.window_title.clone(),
        }
    }

    fn facts(&self) -> ActionFacts<'_> {
        ActionFacts {
            process_name: self.process_name.as_deref(),
            window_title: self.window_title.as_deref(),
            target_url: self.target_url.as_deref(),
            click_x: self.click_x,
            click_y: self.click_y,
        }
    }
}

/// Owned bundle of the four enforcement components. Each is Arc-backed so a
/// clone is cheap. Lets a headless caller that can't hold the managed
/// `AutomationState` — the External Bridge MCP proxy — still run through the
/// one pipeline instead of bypassing the gate.
#[derive(Clone)]
pub struct Enforcement {
    pub gate: PermissionGate,
    pub audit: AuditRing,
    pub consent: ConsentBroker,
    pub policy: PolicyState,
}

impl Enforcement {
    pub fn from_state(state: &AutomationState) -> Self {
        Self {
            gate: state.gate.clone(),
            audit: state.audit.clone(),
            consent: state.consent.clone(),
            policy: state.policy.clone(),
        }
    }
}

/// Run `do_call` behind the full permission pipeline, drawing the enforcement
/// components from a managed `AutomationState`. Returns the typed
/// `AutomationError` (callers stringify for the Tauri boundary).
pub async fn run_gated<T, F, Fut>(
    app: Option<&AppHandle>,
    state: &AutomationState,
    gctx: GateContext,
    command: &str,
    do_call: F,
) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    run_gated_impl(
        app,
        &state.gate,
        &state.audit,
        &state.consent,
        &state.policy,
        gctx,
        command,
        do_call,
    )
    .await
}

/// Same pipeline, driven by an owned [`Enforcement`] bundle — used by the
/// headless MCP proxy which holds Arc-clones rather than the managed state.
pub async fn run_gated_enf<T, F, Fut>(
    app: Option<&AppHandle>,
    enf: &Enforcement,
    gctx: GateContext,
    command: &str,
    do_call: F,
) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    run_gated_impl(
        app,
        &enf.gate,
        &enf.audit,
        &enf.consent,
        &enf.policy,
        gctx,
        command,
        do_call,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_gated_impl<T, F, Fut>(
    app: Option<&AppHandle>,
    gate: &PermissionGate,
    audit: &AuditRing,
    consent: &ConsentBroker,
    policy: &PolicyState,
    gctx: GateContext,
    command: &str,
    do_call: F,
) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let started = Instant::now();
    let surface = gctx.surface;
    let plugin_id = gctx.plugin_id.clone();
    let target = gctx.target();
    let call = Call {
        command,
        surface,
        plugin_id: plugin_id.as_deref(),
        target: target.clone(),
    };

    // T5 per-action policy — runs only for the ComputerUse surface and only
    // when a non-empty policy is configured (fast-path no-op otherwise).
    let policy_check = || -> Option<String> {
        if surface != Surface::ComputerUse || policy.is_empty() {
            return None;
        }
        match policy.evaluate(&gctx.facts()) {
            PolicyDecision::Allow => None,
            PolicyDecision::Deny { reason } => Some(reason),
        }
    };

    let initial = gate.evaluate(&call);
    let decision = maybe_upgrade_to_consent(initial, gctx.force_tier, &call);

    match decision {
        Decision::Deny(err) => {
            let entry = record_deny(
                audit,
                command,
                surface,
                plugin_id.as_deref(),
                &target,
                &err,
                started,
            );
            if let Some(app) = app {
                emit_audit(app, &entry);
            }
            Err(err)
        }
        Decision::RequireConsent { prompt } => {
            // Headless (no AppHandle) can't render the overlay → decline. This
            // is the path the External Bridge MCP proxy takes; a PerCall tier
            // there means "deny" rather than "silently allow".
            let allow = match app {
                Some(app) => consent.request(app.clone(), prompt.clone()).await,
                None => false,
            };
            if allow {
                // Explicit consent does not bypass the per-action allowlist.
                if let Some(reason) = policy_check() {
                    let (entry, typed) = record_policy_deny(
                        audit,
                        command,
                        surface,
                        plugin_id.as_deref(),
                        &target,
                        &reason,
                        started,
                    );
                    if let Some(app) = app {
                        emit_audit(app, &entry);
                    }
                    return Err(typed);
                }
                let result = do_call().await;
                let entry = AuditEntry {
                    id: String::new(),
                    ts: now_ms(),
                    surface,
                    plugin_id: plugin_id.clone(),
                    command: command.to_string(),
                    process_name: target.process_name.clone(),
                    window_title: target.window_title.clone(),
                    decision: AuditDecision::Consent,
                    reason: Some("user consented".into()),
                    duration_ms: started.elapsed().as_millis() as u64,
                    error: result.as_ref().err().map(err_to_string),
                };
                let recorded = audit.record(entry);
                if let Some(app) = app {
                    emit_audit(app, &recorded);
                }
                result
            } else {
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
                    error: Some(err_to_string(&err)),
                };
                let recorded = audit.record(entry);
                if let Some(app) = app {
                    emit_audit(app, &recorded);
                }
                Err(err)
            }
        }
        Decision::Allow => {
            if let Some(reason) = policy_check() {
                let (entry, typed) = record_policy_deny(
                    audit,
                    command,
                    surface,
                    plugin_id.as_deref(),
                    &target,
                    &reason,
                    started,
                );
                if let Some(app) = app {
                    emit_audit(app, &entry);
                }
                return Err(typed);
            }
            let result = do_call().await;
            let entry = record_allow(
                audit,
                command,
                surface,
                plugin_id.as_deref(),
                &target,
                started,
                &result,
            );
            if let Some(app) = app {
                emit_audit(app, &entry);
            }
            result
        }
    }
}

/// Map a canonical [`Action`] onto the worker handle (and `tool_exec` for the
/// bash / text-editor tools). The single backend-dispatch site; the permission
/// pipeline has already cleared by the time this runs.
pub async fn execute_action(handle: &AutomationHandle, action: Action) -> Result<ActionOutput> {
    Ok(match action {
        Action::Screenshot { opts } => ActionOutput::Screenshot(handle.screenshot(opts).await?),
        Action::Click { target, opts } => {
            handle.click(target, opts).await?;
            ActionOutput::Void
        }
        Action::MouseMove { point } => {
            handle.mouse_move(point).await?;
            ActionOutput::Void
        }
        Action::Drag { from, to, opts } => {
            handle.drag(from, to, opts).await?;
            ActionOutput::Void
        }
        Action::MouseButton { button, transition } => {
            handle.mouse_button(button, transition).await?;
            ActionOutput::Void
        }
        Action::Scroll { target, opts } => {
            handle.scroll(target, opts).await?;
            ActionOutput::Void
        }
        Action::Type { text, opts } => {
            handle.type_text(text, opts).await?;
            ActionOutput::Void
        }
        Action::Keys { chord } => {
            handle.send_keys(chord).await?;
            ActionOutput::Void
        }
        Action::HoldKey { chord, duration_ms } => {
            handle.hold_key(chord, duration_ms).await?;
            ActionOutput::Void
        }
        Action::Wait { duration_ms } => {
            tokio::time::sleep(Duration::from_millis(duration_ms as u64)).await;
            ActionOutput::Void
        }
        Action::CursorPosition => ActionOutput::Cursor(handle.cursor_position().await?),
        Action::Capabilities => ActionOutput::Capabilities(handle.capabilities().await?),
        Action::GetFocus => ActionOutput::Element(handle.get_focus().await?),
        Action::ReadTree { root, opts } => ActionOutput::Tree(handle.read_tree(root, opts).await?),
        Action::Find { locator } => ActionOutput::Found {
            element_ref: handle.find(locator).await?,
        },
        Action::InvokePattern {
            target,
            pattern,
            args,
        } => ActionOutput::Pattern(handle.invoke_pattern(target, pattern, args).await?),
        Action::WindowOp { target, op } => {
            handle.window_op(target, op).await?;
            ActionOutput::Void
        }
        Action::PickAtPoint { point } => ActionOutput::Element(handle.pick_at_point(point).await?),
        // Pick-session start/cancel are audit-only markers — the gate records
        // them; there is no backend side effect.
        Action::PickSessionStart | Action::PickSessionCancel => ActionOutput::Void,
        Action::Bash(b) => ActionOutput::Bash(tool_exec::run_bash(b).await?),
        Action::TextEditor(te) => ActionOutput::TextEditor(tool_exec::run_text_editor(te).await?),
    })
}
