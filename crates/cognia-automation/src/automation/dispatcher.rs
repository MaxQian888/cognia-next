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

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::audit::{AuditEntry, AuditRing, Decision as AuditDecision};
use super::commands::{
    emit_audit, err_to_string, now_ms, record_allow, record_deny, record_policy_deny,
    AutomationState,
};
use super::consent::{ConsentBroker, ConsentRequestEvent, ConsentThumbnail};
use super::cua_route;
use super::permission::{
    maybe_upgrade_to_consent, Call, Decision, PermissionGate, Surface, TargetMeta, Tier,
};
use super::platform::shared::{credential_window, screenshot};
use super::policy::{ActionFacts, Decision as PolicyDecision, PolicyState};
use super::tool_exec;
use super::types::*;
use super::worker::AutomationHandle;
use crate::cua_sandbox::CuaSandboxRegistry;

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
    /// Human-readable detail of the action (the shell command for `bash`, a
    /// `create <path>` summary for `text_editor`). Surfaced in the consent
    /// overlay so the operator sees what they're approving. `None` for calls
    /// whose verb already says everything (click, type, screenshot, …).
    pub command_detail: Option<String>,
    /// Chat session tag, forwarded into the consent prompt so a session
    /// grant can't cross conversations. `None` for calls with no chat
    /// context (workflow steps, the headless MCP proxy).
    pub session_key: Option<String>,
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
    /// Headless consent event sink. Desktop calls use `AppHandle::emit` and
    /// leave this unset; cognia-server publishes onto its authenticated bus.
    pub consent_event_sink:
        Option<Arc<dyn Fn(&ConsentRequestEvent) -> std::result::Result<(), String> + Send + Sync>>,
}

/// Largest base64 thumbnail payload we will attach to a consent request.
///
/// `/ws/v1/events` refuses a frame over 64 KiB
/// (`companion_api::ws::MAX_WS_FRAME_BYTES`), and a refused frame means the
/// remote approver silently never sees the prompt — the exact failure this
/// whole path exists to remove. This budget leaves room for the prompt fields
/// and the JSON framing wrapped around the image.
const MAX_THUMBNAIL_B64_BYTES: usize = 44 * 1024;

/// Boxes tried in order until the encoded thumbnail fits the budget. Detailed
/// screens (dense text, many windows) do not compress predictably, so a single
/// fixed size is not a guarantee — stepping down is.
const THUMBNAIL_BOXES: [(u32, u32); 3] = [(640, 400), (400, 250), (256, 160)];

/// Grab a downscaled screen thumbnail for a consent prompt, or `None` if
/// capture fails or nothing fits the frame budget. Dropping the image degrades
/// the consent surfaces to the text-only rendering they had before; emitting an
/// oversized frame would drop the whole prompt.
///
/// Redaction here is **forced**, not settings-driven: unlike a tool_result that
/// stays on the host, this frame leaves the desktop for a phone, so a focused
/// credential prompt is blanked even when the operator left global screenshot
/// redaction off.
///
/// This calls the backend directly rather than recursing through `run_gated`,
/// and that is deliberate — gating it would deadlock (a consent prompt whose
/// own capture needs a consent prompt) and there is nothing to gate: the image
/// is shown only to the operator being asked to authorize, never returned to
/// the model, never written to the audit ring, and never persisted.
async fn capture_consent_thumbnail(handle: &AutomationHandle) -> Option<ConsentThumbnail> {
    let shot = handle.screenshot(ScreenshotOpts::default()).await.ok()?;
    let redacted = credential_window::is_credential_window_focused();
    let shot = if redacted {
        screenshot::redact_screenshot(shot).ok()?
    } else {
        shot
    };
    for (max_w, max_h) in THUMBNAIL_BOXES {
        let scaled = screenshot::downscale_encoded(shot.clone(), max_w, max_h).ok()?;
        if scaled.bytes.len() <= MAX_THUMBNAIL_B64_BYTES {
            return Some(ConsentThumbnail {
                bytes: scaled.bytes,
                width: scaled.width,
                height: scaled.height,
                redacted,
            });
        }
    }
    None
}

impl Enforcement {
    pub fn from_state(state: &AutomationState) -> Self {
        Self {
            gate: state.gate.clone(),
            audit: state.audit.clone(),
            consent: state.consent.clone(),
            policy: state.policy.clone(),
            consent_event_sink: None,
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
        Some(&state.handle),
        None,
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
        None,
        enf.consent_event_sink.as_ref(),
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
    handle: Option<&AutomationHandle>,
    consent_event_sink: Option<
        &Arc<dyn Fn(&ConsentRequestEvent) -> std::result::Result<(), String> + Send + Sync>,
    >,
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
        Decision::RequireConsent { mut prompt } => {
            // Fill the command detail the gate couldn't see (it has no access to
            // the action payload) so the overlay shows the actual command.
            if prompt.command_detail.is_none() {
                prompt.command_detail = gctx.command_detail.clone();
            }
            if prompt.session_key.is_none() {
                prompt.session_key = gctx.session_key.clone();
            }
            let allow = match app {
                Some(app) => {
                    // Capture before prompting so the approver sees the screen
                    // as it stands at decision time. Best-effort: a failed or
                    // oversized capture just means a text-only prompt, never a
                    // blocked action.
                    let thumbnail = match handle {
                        Some(h) => capture_consent_thumbnail(h).await,
                        None => None,
                    };
                    consent
                        .request_with_thumbnail(
                            app.clone(),
                            prompt.clone(),
                            gate.settings().consent_timeout_ms(),
                            thumbnail,
                        )
                        .await
                }
                None => match consent_event_sink {
                    Some(sink) => {
                        let sink = Arc::clone(sink);
                        consent
                            .request_with_emitter(
                                prompt.clone(),
                                gate.settings().consent_timeout_ms(),
                                None,
                                move |event| sink(event),
                            )
                            .await
                    }
                    None => false,
                },
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
/// pipeline has already cleared by the time this runs. Every GUI action routes
/// through [`cua_route`] so a remote `CallContext` lands in the cua sandbox
/// rather than on the local host.
pub async fn execute_action(
    handle: &AutomationHandle,
    cua: &CuaSandboxRegistry,
    remote: Option<&str>,
    confine: Option<&SandboxConfine>,
    action: Action,
) -> Result<ActionOutput> {
    let _perf = cognia_instrument::guard("automation.action");
    Ok(match action {
        Action::Screenshot { opts } => {
            ActionOutput::Screenshot(cua_route::screenshot(handle, cua, remote, opts).await?)
        }
        Action::Click { target, opts } => {
            cua_route::click(handle, cua, remote, target, opts).await?;
            ActionOutput::Void
        }
        Action::MouseMove { point } => {
            cua_route::mouse_move(handle, cua, remote, point).await?;
            ActionOutput::Void
        }
        Action::Drag { from, to, opts } => {
            cua_route::drag(handle, cua, remote, from, to, opts).await?;
            ActionOutput::Void
        }
        Action::MouseButton { button, transition } => {
            cua_route::mouse_button(handle, cua, remote, button, transition).await?;
            ActionOutput::Void
        }
        Action::Scroll { target, opts } => {
            cua_route::scroll(handle, cua, remote, target, opts).await?;
            ActionOutput::Void
        }
        Action::Type { text, opts } => {
            cua_route::type_text(handle, cua, remote, text, opts).await?;
            ActionOutput::Void
        }
        Action::Keys { chord } => {
            cua_route::send_keys(handle, cua, remote, chord).await?;
            ActionOutput::Void
        }
        Action::HoldKey { chord, duration_ms } => {
            cua_route::hold_key(handle, cua, remote, chord, duration_ms).await?;
            ActionOutput::Void
        }
        Action::Wait { duration_ms } => {
            tokio::time::sleep(Duration::from_millis(duration_ms as u64)).await;
            ActionOutput::Void
        }
        Action::CursorPosition => {
            ActionOutput::Cursor(cua_route::cursor_position(handle, cua, remote).await?)
        }
        Action::Capabilities => ActionOutput::Capabilities(handle.capabilities().await?),
        Action::GetFocus => ActionOutput::Element(cua_route::get_focus(handle, cua, remote).await?),
        Action::ReadTree { root, opts } => {
            ActionOutput::Tree(cua_route::read_tree(handle, cua, remote, root, opts).await?)
        }
        Action::Find { locator } => ActionOutput::Found {
            element_ref: cua_route::find(handle, cua, remote, locator).await?,
        },
        Action::InvokePattern {
            target,
            pattern,
            args,
        } => ActionOutput::Pattern(
            cua_route::invoke_pattern(handle, cua, remote, target, pattern, args).await?,
        ),
        Action::WindowOp { target, op } => {
            cua_route::window_op(handle, cua, remote, target, op).await?;
            ActionOutput::Void
        }
        Action::PickAtPoint { point } => {
            ActionOutput::Element(cua_route::pick_at_point(handle, cua, remote, point).await?)
        }
        // Pick-session start/cancel are audit-only markers — the gate records
        // them; there is no backend side effect.
        Action::PickSessionStart | Action::PickSessionCancel => ActionOutput::Void,
        // ADR-0028 — when the session enabled the sandbox, the renderer stamps
        // `confine` so the native bash / text-editor run OS-sandboxed / path-
        // guarded instead of unconfined. Absent confine keeps host behaviour.
        Action::Bash(b) => ActionOutput::Bash(match confine {
            Some(c) => tool_exec::run_bash_confined(b, c).await?,
            None => tool_exec::run_bash(b).await?,
        }),
        Action::TextEditor(te) => ActionOutput::TextEditor(match confine {
            Some(c) => tool_exec::run_text_editor_confined(te, c).await?,
            None => tool_exec::run_text_editor(te).await?,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::consent::ConsentRequestEvent;
    use crate::automation::permission::ConsentPrompt;

    /// Mirror of `companion_api::ws::MAX_WS_FRAME_BYTES`. A consent frame that
    /// exceeds this is dropped by the transport, which puts us straight back in
    /// the "remote approver never sees the prompt" hole this path exists to fix.
    const WS_FRAME_CAP_BYTES: usize = 64 * 1024;

    fn worst_case_event() -> ConsentRequestEvent {
        ConsentRequestEvent {
            id: "b3f1c2a4-5d6e-4f70-8a91-2b3c4d5e6f70".into(),
            prompt: ConsentPrompt {
                command: "computer_use".into(),
                surface: Surface::ComputerUse,
                plugin_id: Some("cognia-computer-use".into()),
                process_name: Some("Some Very Long Application Name.app".into()),
                window_title: Some("x".repeat(512)),
                command_detail: Some("y".repeat(2048)),
                session_key: Some("z".repeat(128)),
            },
            timeout_ms: 90_000,
            thumbnail: Some(ConsentThumbnail {
                // A thumbnail sitting exactly on the budget ceiling.
                bytes: "A".repeat(MAX_THUMBNAIL_B64_BYTES),
                width: 640,
                height: 400,
                redacted: false,
            }),
        }
    }

    #[test]
    fn consent_frame_with_max_thumbnail_fits_the_ws_cap() {
        let json = serde_json::to_string(&worst_case_event()).expect("event serializes");
        assert!(
            json.len() < WS_FRAME_CAP_BYTES,
            "consent frame is {} bytes, over the {} byte transport cap — the \
             remote prompt would be silently dropped",
            json.len(),
            WS_FRAME_CAP_BYTES
        );
    }

    /// Compile-time, not a test: the image budget must leave room for the
    /// prompt fields and JSON framing wrapped around it, and a regression here
    /// should fail the build rather than wait for someone to run the suite.
    const _: () = assert!(
        MAX_THUMBNAIL_B64_BYTES + 16 * 1024 <= WS_FRAME_CAP_BYTES,
        "thumbnail budget leaves under 16 KiB for the rest of the consent frame"
    );

    #[test]
    fn thumbnail_boxes_step_down_monotonically() {
        for pair in THUMBNAIL_BOXES.windows(2) {
            let (prev_w, prev_h) = pair[0];
            let (next_w, next_h) = pair[1];
            assert!(
                next_w < prev_w && next_h < prev_h,
                "fallback boxes must shrink, got {prev_w}x{prev_h} then {next_w}x{next_h}"
            );
        }
    }
}
