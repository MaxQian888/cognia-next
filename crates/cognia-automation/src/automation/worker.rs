//! Worker thread that owns the active back-end.
//!
//! Some Request variants and AutomationHandle methods (window_op /
//! subscribe_events / unsubscribe / shutdown) are part of the M1.6 / M2
//! surface and not yet wired through Tauri commands — silenced here rather
//! than gating each one individually.
#![allow(dead_code)]
//!
//! Why a dedicated OS thread rather than `spawn_blocking` per call:
//!
//! - Windows UIA initializes COM on `UIAutomation::new()`. Holding a single
//!   thread keeps COM alive without re-init churn.
//! - UIA event callbacks fire on the COM thread; having a stable home thread
//!   lets us forward them through a channel without re-entering async land
//!   from arbitrary contexts.
//! - The trait stays `Send` without forcing back-ends to be `Sync` —
//!   internal mutability is fine because the worker is the only caller.
//!
//! The wire format is a `Request` enum sent over an mpsc channel; each
//! variant carries an inline `oneshot::Sender` so the caller can `.await`
//! the reply.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Instant;

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use super::backend::AutomationBackend;
use super::policy::{self, Decision, HardTargetFacts};
use super::selection::TextSelectionSnapshot;
use super::session::{
    ActionEvidence, ActionMethod, ActionPolicyDecision, ActionRequest, ActionResult, ActionStatus,
    ActionStrategy, AppLocator, CapturedUiState, CoordinateSpace, ElementHandle, ExpandedElements,
    GetAppStateOptions, PreparedAction, SessionError, UiAction, UiSessionManager, UiStateRevision,
    UiSurface, UiTreeNode,
};
use super::types::*;

/// Max panic restarts allowed inside `RESTART_WINDOW`. Hitting the cap
/// emits `automation:worker-dead` and exits the loop — subsequent IPCs
/// will land `AutomationError::Internal { message: "worker dead" }` via
/// channel-closed. Three matches the "fail-twice-fall-back-once" pattern
/// the rest of the subsystem uses (subscription credential watcher,
/// connector outbound runner).
pub const MAX_RESTARTS_PER_WINDOW: u32 = 3;
/// Rolling window length for the restart counter (seconds).
pub const RESTART_WINDOW_SECS: u64 = 60;

/// Single union of every backend call. Each variant carries its own reply
/// channel because Tauri commands are async — the worker can't be made async
/// (it must own a non-Send COM state on Windows), so we hop via channels.
enum Request {
    Capabilities {
        reply: oneshot::Sender<Capabilities>,
    },
    GetFocus {
        reply: oneshot::Sender<Result<ElementInfo>>,
    },
    ListApps {
        reply: oneshot::Sender<Result<Vec<super::session::ResolvedApplication>>>,
    },
    ReadTree {
        root: Option<ElementRef>,
        opts: TreeOpts,
        reply: oneshot::Sender<Result<Vec<ElementInfo>>>,
    },
    Find {
        locator: Locator,
        reply: oneshot::Sender<Result<Option<ElementRef>>>,
    },
    Screenshot {
        opts: ScreenshotOpts,
        reply: oneshot::Sender<Result<Screenshot>>,
    },
    Click {
        target: ClickTarget,
        opts: ClickOpts,
        reply: oneshot::Sender<Result<()>>,
    },
    TypeText {
        text: String,
        opts: TypeOpts,
        reply: oneshot::Sender<Result<()>>,
    },
    SendKeys {
        chord: KeyChord,
        reply: oneshot::Sender<Result<()>>,
    },
    InvokePattern {
        target: ElementRef,
        pattern: PatternKind,
        args: serde_json::Value,
        reply: oneshot::Sender<Result<serde_json::Value>>,
    },
    WindowOp {
        target: ElementRef,
        op: WindowOp,
        reply: oneshot::Sender<Result<()>>,
    },
    SubscribeEvents {
        filter: EventFilter,
        reply: oneshot::Sender<Result<SubscriptionId>>,
    },
    Unsubscribe {
        sub: SubscriptionId,
        reply: oneshot::Sender<Result<()>>,
    },
    MouseMove {
        point: Point,
        reply: oneshot::Sender<Result<()>>,
    },
    Drag {
        from: Point,
        to: Point,
        opts: DragOpts,
        reply: oneshot::Sender<Result<()>>,
    },
    Scroll {
        target: ScrollTarget,
        opts: ScrollOpts,
        reply: oneshot::Sender<Result<()>>,
    },
    HoldKey {
        chord: KeyChord,
        duration_ms: u32,
        reply: oneshot::Sender<Result<()>>,
    },
    MouseButton {
        button: MouseButton,
        transition: ButtonTransition,
        reply: oneshot::Sender<Result<()>>,
    },
    CursorPosition {
        reply: oneshot::Sender<Result<Point>>,
    },
    PickAtPoint {
        point: Point,
        reply: oneshot::Sender<Result<ElementInfo>>,
    },
    ReadTextSelection {
        reply: oneshot::Sender<Result<Option<TextSelectionSnapshot>>>,
    },
    SelectionPreflight {
        reply: oneshot::Sender<Result<crate::automation::backend::SelectionPreflight>>,
    },
    GetAppState {
        session_id: String,
        turn_binding: String,
        locator: AppLocator,
        options: GetAppStateOptions,
        reply: oneshot::Sender<Result<UiStateRevision>>,
    },
    QueryElements {
        session_id: String,
        lineage_id: String,
        revision: u64,
        locator: Locator,
        limit: usize,
        reply: oneshot::Sender<Result<Vec<UiTreeNode>>>,
    },
    ExpandElement {
        handle: ElementHandle,
        continuation_token: Option<String>,
        limit: usize,
        reply: oneshot::Sender<Result<ExpandedElements>>,
    },
    PerformAction {
        request: ActionRequest,
        turn_binding: String,
        reply: oneshot::Sender<Result<ActionResult>>,
    },
    Shutdown,
}

/// Handle the renderer-facing layer holds. Cheap to clone; the underlying
/// `Sender` is reference-counted by tokio.
#[derive(Clone)]
pub struct AutomationHandle {
    tx: tokio::sync::mpsc::Sender<Request>,
    _thread: Arc<ThreadJoiner>,
}

struct ThreadJoiner(Option<JoinHandle<()>>);

impl Drop for ThreadJoiner {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            // Best-effort join — we already sent Shutdown via the channel.
            let _ = h.join();
        }
    }
}

/// Spawns the worker thread and returns a handle.
pub struct Worker;

impl Worker {
    /// Spawn the worker thread without panic-restart wiring. Equivalent
    /// to `spawn_with_app(None, builder)` and kept for tests / callers
    /// that don't have a Tauri `AppHandle` in scope (the existing
    /// `AutomationProxy::tests` stub handle is one such case).
    ///
    /// The `builder` closure runs *on* the worker thread, so the
    /// back-end is allowed to hold `!Send` resources (Windows UIA's COM
    /// pointer is the canonical example). `Fn` (not `FnOnce`) because
    /// ADR-0020 W1 reinit-on-panic invokes it again after a panic.
    pub fn spawn<F>(builder: F) -> AutomationHandle
    where
        F: Fn() -> Box<dyn AutomationBackend> + Send + 'static,
    {
        Self::spawn_with_app(None, builder)
    }

    /// ADR-0020 W1 — same as `spawn` but with a Tauri `AppHandle` so the
    /// worker can emit `automation:worker-restart` /
    /// `automation:worker-dead` events when the backend panics.
    pub fn spawn_with_app<F>(app: Option<AppHandle>, builder: F) -> AutomationHandle
    where
        F: Fn() -> Box<dyn AutomationBackend> + Send + 'static,
    {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Request>(64);
        let thread = thread::Builder::new()
            .name("automation-worker".into())
            .spawn(move || {
                let mut backend = builder();
                let mut sessions = UiSessionManager::default();
                let mut restart_count: u32 = 0;
                let mut window_start = Instant::now();
                // Drain the channel synchronously. We're not in async land here;
                // `blocking_recv` is exactly what we want.
                while let Some(req) = rx.blocking_recv() {
                    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                        dispatch(&*backend, &mut sessions, req)
                    }));
                    match result {
                        Ok(DispatchControl::Continue) => continue,
                        Ok(DispatchControl::Stop) => break,
                        Err(panic) => {
                            let panic_message = panic_payload_to_string(&panic);
                            if window_start.elapsed().as_secs() > RESTART_WINDOW_SECS {
                                restart_count = 0;
                                window_start = Instant::now();
                            }
                            restart_count = restart_count.saturating_add(1);
                            if let Some(handle) = app.as_ref() {
                                let _ = handle.emit(
                                    "automation:worker-restart",
                                    json!({
                                        "attempt": restart_count,
                                        "panic_message": panic_message,
                                    }),
                                );
                            }
                            if restart_count > MAX_RESTARTS_PER_WINDOW {
                                if let Some(handle) = app.as_ref() {
                                    let _ = handle.emit(
                                        "automation:worker-dead",
                                        json!({
                                            "panic_message": panic_message,
                                        }),
                                    );
                                }
                                break;
                            }
                            // The panicked backend's state may be corrupt;
                            // drop + rebuild via the builder closure.
                            backend = builder();
                            sessions = UiSessionManager::default();
                        }
                    }
                }
            })
            .expect("spawn automation worker thread");

        AutomationHandle {
            tx,
            _thread: Arc::new(ThreadJoiner(Some(thread))),
        }
    }
}

/// Returned by `dispatch` to tell the worker loop whether to keep
/// draining requests. `Shutdown` requests yield `Stop`; everything else
/// yields `Continue`.
enum DispatchControl {
    Continue,
    Stop,
}

/// Coerce a `Box<dyn Any + Send>` payload (what `catch_unwind` returns) to
/// a readable string for diagnostics. Handles the two common payload
/// shapes (`&str` and `String`) and falls back to `"<non-string panic>"`
/// for everything else.
fn panic_payload_to_string(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = payload.downcast_ref::<&'static str>() {
        s.to_string()
    } else {
        "<non-string panic>".into()
    }
}

/// Dispatch one request against the active backend. Extracted out of
/// `Worker::spawn_with_app` so `catch_unwind` can target one closure
/// boundary instead of wrapping every match arm individually.
fn dispatch(
    backend: &dyn AutomationBackend,
    sessions: &mut UiSessionManager,
    req: Request,
) -> DispatchControl {
    match req {
        Request::Capabilities { reply } => {
            let _ = reply.send(backend.capabilities());
        }
        Request::GetFocus { reply } => {
            let _ = reply.send(backend.get_focus());
        }
        Request::ListApps { reply } => {
            let _ = reply.send(backend.list_applications());
        }
        Request::ReadTree { root, opts, reply } => {
            let _ = reply.send(backend.read_tree(root, opts));
        }
        Request::Find { locator, reply } => {
            let _ = reply.send(backend.find(&locator));
        }
        Request::Screenshot { opts, reply } => {
            let _ = reply.send(backend.screenshot(opts));
        }
        Request::Click {
            target,
            opts,
            reply,
        } => {
            let _ = reply.send(backend.click(target, opts));
        }
        Request::TypeText { text, opts, reply } => {
            let _ = reply.send(backend.type_text(&text, opts));
        }
        Request::SendKeys { chord, reply } => {
            let _ = reply.send(backend.send_keys(&chord));
        }
        Request::InvokePattern {
            target,
            pattern,
            args,
            reply,
        } => {
            let _ = reply.send(backend.invoke_pattern(target, pattern, args));
        }
        Request::WindowOp { target, op, reply } => {
            let _ = reply.send(backend.window_op(target, op));
        }
        Request::SubscribeEvents { filter, reply } => {
            let _ = reply.send(backend.subscribe_events(filter));
        }
        Request::Unsubscribe { sub, reply } => {
            let _ = reply.send(backend.unsubscribe(sub));
        }
        Request::MouseMove { point, reply } => {
            let _ = reply.send(backend.mouse_move(point));
        }
        Request::Drag {
            from,
            to,
            opts,
            reply,
        } => {
            let _ = reply.send(backend.drag(from, to, opts));
        }
        Request::Scroll {
            target,
            opts,
            reply,
        } => {
            let _ = reply.send(backend.scroll(target, opts));
        }
        Request::HoldKey {
            chord,
            duration_ms,
            reply,
        } => {
            let _ = reply.send(backend.hold_key(&chord, duration_ms));
        }
        Request::MouseButton {
            button,
            transition,
            reply,
        } => {
            let _ = reply.send(backend.mouse_button(button, transition));
        }
        Request::CursorPosition { reply } => {
            let _ = reply.send(backend.cursor_position());
        }
        Request::PickAtPoint { point, reply } => {
            let _ = reply.send(backend.pick_at_point(point));
        }
        Request::ReadTextSelection { reply } => {
            let _ = reply.send(backend.read_text_selection());
        }
        Request::SelectionPreflight { reply } => {
            let _ = reply.send(backend.selection_preflight());
        }
        Request::GetAppState {
            session_id,
            turn_binding,
            locator,
            options,
            reply,
        } => {
            let _ = reply.send(capture_app_state(
                backend,
                sessions,
                session_id,
                turn_binding,
                locator,
                options,
            ));
        }
        Request::QueryElements {
            session_id,
            lineage_id,
            revision,
            locator,
            limit,
            reply,
        } => {
            let result = sessions
                .query_elements(&session_id, &lineage_id, revision, &locator, limit)
                .map_err(map_session_error);
            let _ = reply.send(result);
        }
        Request::ExpandElement {
            handle,
            continuation_token,
            limit,
            reply,
        } => {
            let result = sessions
                .expand_element(&handle, continuation_token.as_deref(), limit)
                .map_err(map_session_error);
            let _ = reply.send(result);
        }
        Request::PerformAction {
            request,
            turn_binding,
            reply,
        } => {
            let _ = reply.send(perform_session_action(
                backend,
                sessions,
                request,
                &turn_binding,
            ));
        }
        Request::Shutdown => return DispatchControl::Stop,
    }
    DispatchControl::Continue
}

fn capture_app_state(
    backend: &dyn AutomationBackend,
    sessions: &mut UiSessionManager,
    session_id: String,
    turn_binding: String,
    locator: AppLocator,
    options: GetAppStateOptions,
) -> Result<UiStateRevision> {
    let (requested_bundle, requested_process) = match &locator {
        AppLocator::BundleId { bundle_id } => (Some(bundle_id.as_str()), None),
        AppLocator::Path { path } => (
            None,
            std::path::Path::new(path)
                .file_stem()
                .and_then(|name| name.to_str()),
        ),
        AppLocator::DisplayName { display_name } => (None, Some(display_name.as_str())),
    };
    if let Decision::Deny { reason } = policy::evaluate_hard_target(HardTargetFacts {
        bundle_id: requested_bundle,
        process_name: requested_process,
        window_title: None,
        target_url: None,
    }) {
        return Err(AutomationError::PermissionDenied { reason });
    }
    let app = backend.resolve_application(&locator, options.allow_launch)?;
    let roots = backend.read_application_tree(
        &app,
        TreeOpts {
            max_depth: Some(options.max_depth),
            cache_props: None,
        },
    )?;
    let window_title = roots
        .first()
        .and_then(|root| root.window_title.as_deref())
        .or_else(|| roots.first().and_then(|root| root.name.as_deref()));
    match policy::evaluate_hard_target(HardTargetFacts {
        bundle_id: app.bundle_id.as_deref(),
        process_name: Some(app.display_name.as_str()),
        window_title,
        // A URL observed from the globally focused app is not evidence about
        // this app-scoped session. Target-app URL extraction is performed by
        // the AX tree collector when it can prove ownership.
        target_url: None,
    }) {
        Decision::Allow => {}
        Decision::Deny { reason } => {
            return Err(AutomationError::PermissionDenied { reason });
        }
    }

    let application_screenshot =
        Some(backend.screenshot_application(&app, roots.first(), ScreenshotOpts::default())?);
    let screenshot = application_screenshot
        .as_ref()
        .map(|capture| capture.screenshot.clone());
    let capabilities = backend.capabilities();
    let monitor = capabilities
        .monitors
        .iter()
        .find(|candidate| {
            application_screenshot
                .as_ref()
                .and_then(|capture| capture.display_id.as_deref())
                == Some(candidate.id.as_str())
        })
        .or_else(|| {
            capabilities
                .monitors
                .iter()
                .find(|candidate| candidate.is_primary)
        })
        .or_else(|| capabilities.monitors.first());
    let scale_factor = application_screenshot
        .as_ref()
        .map(|capture| capture.scale_factor)
        .filter(|scale| *scale > 0.0)
        .or_else(|| monitor.map(|candidate| f64::from(candidate.scale_factor)))
        .filter(|scale| *scale > 0.0)
        .unwrap_or(1.0);
    let pixel_width = screenshot
        .as_ref()
        .map(|shot| shot.width)
        .or_else(|| monitor.map(|candidate| candidate.width))
        .unwrap_or_default();
    let pixel_height = screenshot
        .as_ref()
        .map(|shot| shot.height)
        .or_else(|| monitor.map(|candidate| candidate.height))
        .unwrap_or_default();
    let logical_bounds = application_screenshot
        .as_ref()
        .map(|capture| capture.logical_bounds)
        .unwrap_or_else(|| {
            monitor.map_or_else(
                || {
                    roots
                        .first()
                        .and_then(|root| root.bounding_rect)
                        .unwrap_or(Rect {
                            x: 0,
                            y: 0,
                            width: i32::try_from(pixel_width).unwrap_or(i32::MAX),
                            height: i32::try_from(pixel_height).unwrap_or(i32::MAX),
                        })
                },
                |candidate| Rect {
                    x: logical_coordinate(candidate.x, scale_factor),
                    y: logical_coordinate(candidate.y, scale_factor),
                    width: logical_dimension(candidate.width, scale_factor),
                    height: logical_dimension(candidate.height, scale_factor),
                },
            )
        });
    let captured_at = screenshot
        .as_ref()
        .map(|shot| shot.captured_at)
        .unwrap_or_else(unix_time_millis);
    let mut state = sessions
        .record_state(CapturedUiState {
            session_id,
            turn_binding,
            app,
            surface: UiSurface {
                window_id: application_screenshot
                    .as_ref()
                    .and_then(|capture| capture.window_id),
                display_id: application_screenshot
                    .as_ref()
                    .and_then(|capture| capture.display_id.clone())
                    .or_else(|| monitor.map(|candidate| candidate.id.clone())),
                logical_bounds,
                pixel_width,
                pixel_height,
                scale_factor,
                coordinate_space: CoordinateSpace::ScreenshotPixels,
            },
            screenshot,
            roots,
            captured_at,
            max_nodes: options.max_nodes,
        })
        .map_err(map_session_error)?;
    if options.disable_diff {
        state.diff = None;
    }
    Ok(state)
}

fn logical_coordinate(value: i32, scale_factor: f64) -> i32 {
    (f64::from(value) / scale_factor).round() as i32
}

fn logical_dimension(value: u32, scale_factor: f64) -> i32 {
    (f64::from(value) / scale_factor)
        .round()
        .clamp(0.0, f64::from(i32::MAX)) as i32
}

fn unix_time_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn map_session_error(error: SessionError) -> AutomationError {
    match error {
        SessionError::TurnTokenUnknown
        | SessionError::TurnTokenConsumed
        | SessionError::TurnTokenExpired
        | SessionError::TurnBindingMismatch => AutomationError::PermissionDenied {
            reason: error.to_string(),
        },
        SessionError::CrossSessionHandle
        | SessionError::StaleRevision
        | SessionError::StaleElementNotFound
        | SessionError::StaleElementAmbiguous
        | SessionError::InvalidHandle
        | SessionError::ContinuationTokenInvalid
        | SessionError::PixelSurfaceMismatch
        | SessionError::PixelSurfaceMissing => AutomationError::StaleElement,
    }
}

fn perform_session_action(
    backend: &dyn AutomationBackend,
    sessions: &mut UiSessionManager,
    request: ActionRequest,
    turn_binding: &str,
) -> Result<ActionResult> {
    let started = Instant::now();
    let prepared = sessions
        .prepare_action(&request, turn_binding)
        .map_err(map_session_error)?;
    let before_revision = prepared.state.revision;
    let focus = backend.get_focus()?;
    let target_url = backend
        .selection_preflight()
        .ok()
        .and_then(|preflight| preflight.source_url);
    if let Decision::Deny { reason } = policy::evaluate_hard_target(HardTargetFacts {
        bundle_id: prepared.state.app.bundle_id.as_deref(),
        process_name: Some(prepared.state.app.display_name.as_str()),
        window_title: focus.window_title.as_deref(),
        target_url: target_url.as_deref(),
    }) {
        let mut evidence = vec![ActionEvidence {
            kind: "policy".into(),
            message: reason.clone(),
            revision: Some(before_revision),
        }];
        append_refetch_evidence(&prepared, &mut evidence);
        return Ok(ActionResult {
            status: ActionStatus::Refused,
            method: None,
            before_revision,
            after_revision: None,
            evidence,
            policy_decision: ActionPolicyDecision {
                allowed: false,
                reason: Some(reason),
            },
            duration_ms: started.elapsed().as_millis() as u64,
        });
    }

    let foreground = focus.process_id == Some(prepared.state.app.process_id);
    let delivery = deliver_action(backend, &prepared, &request, foreground);
    let (method, delivery_error) = match delivery {
        Ok(method) => (Some(method), None),
        Err(error) => (None, Some(error)),
    };
    if let Some(error) = delivery_error {
        let mut evidence = vec![ActionEvidence {
            kind: "deliveryError".into(),
            message: error.to_string(),
            revision: Some(before_revision),
        }];
        append_refetch_evidence(&prepared, &mut evidence);
        return Ok(ActionResult {
            status: if matches!(error, AutomationError::PermissionDenied { .. }) {
                ActionStatus::Refused
            } else {
                ActionStatus::NotDelivered
            },
            method: None,
            before_revision,
            after_revision: None,
            evidence,
            policy_decision: ActionPolicyDecision {
                allowed: true,
                reason: None,
            },
            duration_ms: started.elapsed().as_millis() as u64,
        });
    }

    let verification = settle_application_tree(backend, &prepared.state.app);
    let (status, after_revision, mut evidence) = match verification {
        Ok((roots, observations)) => {
            let state = sessions
                .record_state(CapturedUiState {
                    session_id: prepared.state.session_id.clone(),
                    turn_binding: prepared.turn_binding.clone(),
                    app: prepared.state.app.clone(),
                    surface: prepared.state.surface.clone(),
                    screenshot: None,
                    roots,
                    captured_at: unix_time_millis(),
                    max_nodes: super::session::MODEL_TREE_MAX_NODES,
                })
                .map_err(map_session_error)?;
            let changed = state.diff.as_ref().is_some_and(|diff| {
                !diff.added.is_empty() || !diff.removed.is_empty() || !diff.updated.is_empty()
            });
            (
                if changed {
                    ActionStatus::Delivered
                } else {
                    ActionStatus::Unknown
                },
                Some(state.revision),
                vec![
                    ActionEvidence {
                        kind: "backendAccepted".into(),
                        message: "the native backend accepted the action".into(),
                        revision: Some(before_revision),
                    },
                    ActionEvidence {
                        kind: if changed {
                            "treeChanged".into()
                        } else {
                            "treeStable".into()
                        },
                        message: format!(
                            "post-action AX state settled after {observations} observations"
                        ),
                        revision: Some(state.revision),
                    },
                ],
            )
        }
        Err(error) => (
            ActionStatus::Unknown,
            None,
            vec![ActionEvidence {
                kind: "verificationError".into(),
                message: error.to_string(),
                revision: None,
            }],
        ),
    };
    evidence.push(ActionEvidence {
        kind: "strategy".into(),
        message: format!("{:?}", request.strategy).to_ascii_lowercase(),
        revision: Some(before_revision),
    });
    append_refetch_evidence(&prepared, &mut evidence);
    Ok(ActionResult {
        status,
        method,
        before_revision,
        after_revision,
        evidence,
        policy_decision: ActionPolicyDecision {
            allowed: true,
            reason: None,
        },
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn append_refetch_evidence(prepared: &PreparedAction, evidence: &mut Vec<ActionEvidence>) {
    if let Some(from_revision) = prepared.refetched_from_revision {
        evidence.push(ActionEvidence {
            kind: "staleHandleRefetched".into(),
            message: format!(
                "uniquely refetched structural fingerprint from revision {from_revision}"
            ),
            revision: Some(prepared.state.revision),
        });
    }
}

fn deliver_action(
    backend: &dyn AutomationBackend,
    prepared: &PreparedAction,
    request: &ActionRequest,
    foreground: bool,
) -> Result<ActionMethod> {
    match request.strategy {
        ActionStrategy::Semantic => deliver_semantic(backend, prepared, &request.action),
        ActionStrategy::Pixel => {
            ensure_foreground(foreground)?;
            deliver_synthetic(backend, prepared, request)
        }
        ActionStrategy::Auto => match deliver_semantic(backend, prepared, &request.action) {
            Ok(method) => Ok(method),
            Err(_) if pixel_fallback_is_fresh(prepared) => {
                ensure_foreground(foreground)?;
                deliver_synthetic(backend, prepared, request)
            }
            Err(error) => Err(error),
        },
    }
}

fn deliver_semantic(
    backend: &dyn AutomationBackend,
    prepared: &PreparedAction,
    action: &UiAction,
) -> Result<ActionMethod> {
    let element = prepared
        .element
        .as_ref()
        .ok_or_else(|| AutomationError::PermissionDenied {
            reason: "semantic actions require an element handle".into(),
        })?;
    let element_ref = element.element_ref.clone();
    match action {
        UiAction::Click { button, count } => backend.click(
            ClickTarget::Element { element_ref },
            ClickOpts {
                button: *button,
                count: *count,
                use_native: Some(true),
                ..ClickOpts::default()
            },
        )?,
        UiAction::Scroll { opts } => {
            backend.scroll(ScrollTarget::Element { element_ref }, *opts)?
        }
        UiAction::SetValue { value } => {
            backend.invoke_pattern(element_ref, PatternKind::Value, json!({ "value": value }))?;
        }
        UiAction::SelectText { start, end } => {
            if start > end {
                return Err(AutomationError::BackendError {
                    message: "selection start must not exceed end".into(),
                });
            }
            backend.invoke_pattern(
                element_ref,
                PatternKind::Text,
                json!({ "start": start, "end": end }),
            )?;
        }
        UiAction::SecondaryAction { name } => {
            let pattern =
                secondary_pattern(name).ok_or_else(|| AutomationError::PermissionDenied {
                    reason: format!("secondary action {name:?} was not exposed by the contract"),
                })?;
            backend.invoke_pattern(element_ref, pattern, serde_json::Value::Null)?;
        }
        UiAction::Drag { .. } | UiAction::PressKey { .. } | UiAction::TypeText { .. } => {
            return Err(AutomationError::UnsupportedPlatform);
        }
    }
    Ok(ActionMethod::Ax)
}

fn deliver_synthetic(
    backend: &dyn AutomationBackend,
    prepared: &PreparedAction,
    request: &ActionRequest,
) -> Result<ActionMethod> {
    let point = prepared.point.or_else(|| {
        prepared
            .element
            .as_ref()
            .and_then(|element| element.bounding_rect)
            .map(rect_center)
    });
    match &request.action {
        UiAction::Click { button, count } => {
            let point = point.ok_or(AutomationError::ElementNotFound)?;
            backend.click(
                ClickTarget::Point {
                    x: point.x,
                    y: point.y,
                },
                ClickOpts {
                    button: *button,
                    count: *count,
                    use_native: Some(false),
                    ..ClickOpts::default()
                },
            )?;
        }
        UiAction::Drag { to, opts } => {
            let to = if prepared.pixel_surface {
                super::session::pixel_to_global_point(&prepared.state.surface, *to)
                    .map_err(map_session_error)?
            } else {
                *to
            };
            backend.drag(
                point.ok_or(AutomationError::ElementNotFound)?,
                to,
                opts.clone(),
            )?;
        }
        UiAction::Scroll { opts } => {
            let point = point.ok_or(AutomationError::ElementNotFound)?;
            backend.scroll(
                ScrollTarget::Point {
                    x: point.x,
                    y: point.y,
                },
                *opts,
            )?;
        }
        UiAction::PressKey { chord } => backend.send_keys(chord)?,
        UiAction::TypeText { text } => backend.type_text(text, TypeOpts::default())?,
        UiAction::SetValue { .. }
        | UiAction::SelectText { .. }
        | UiAction::SecondaryAction { .. } => return Err(AutomationError::UnsupportedPlatform),
    }
    Ok(ActionMethod::Synthetic)
}

fn secondary_pattern(name: &str) -> Option<PatternKind> {
    match name {
        "invoke" => Some(PatternKind::Invoke),
        "toggle" => Some(PatternKind::Toggle),
        "selectionItem" => Some(PatternKind::SelectionItem),
        "expandCollapse" => Some(PatternKind::ExpandCollapse),
        "scrollItem" => Some(PatternKind::ScrollItem),
        _ => None,
    }
}

fn rect_center(rect: Rect) -> Point {
    Point {
        x: rect.x.saturating_add(rect.width / 2),
        y: rect.y.saturating_add(rect.height / 2),
    }
}

fn pixel_fallback_is_fresh(prepared: &PreparedAction) -> bool {
    prepared
        .state
        .screenshot
        .as_ref()
        .is_some_and(|screenshot| {
            screenshot.width == prepared.state.surface.pixel_width
                && screenshot.height == prepared.state.surface.pixel_height
                && unix_time_millis().saturating_sub(prepared.state.captured_at) <= 30_000
        })
}

fn ensure_foreground(foreground: bool) -> Result<()> {
    if foreground {
        Ok(())
    } else {
        Err(AutomationError::PermissionDenied {
            reason: "pixel actions require the target application to be foreground".into(),
        })
    }
}

fn settle_application_tree(
    backend: &dyn AutomationBackend,
    app: &super::session::ResolvedApplication,
) -> Result<(Vec<ElementInfo>, usize)> {
    use std::time::Duration;

    let started = Instant::now();
    let mut deadline = Duration::from_secs(1);
    let mut previous: Option<Vec<ElementInfo>> = None;
    let mut observations = 0usize;
    loop {
        let current = backend.read_application_tree(
            app,
            TreeOpts {
                max_depth: Some(64),
                cache_props: None,
            },
        )?;
        observations = observations.saturating_add(1);
        let stable = previous
            .as_ref()
            .is_some_and(|before| trees_equal(before, &current));
        if stable || started.elapsed() >= deadline {
            return Ok((current, observations));
        }
        if started.elapsed() >= Duration::from_millis(800) {
            deadline = Duration::from_secs(5);
        }
        previous = Some(current);
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn trees_equal(left: &[ElementInfo], right: &[ElementInfo]) -> bool {
    serde_json::to_value(left).ok() == serde_json::to_value(right).ok()
}

/// Helper: send a request and await the reply, mapping channel errors.
async fn round_trip<R, F>(tx: &tokio::sync::mpsc::Sender<Request>, build: F) -> Result<R>
where
    F: FnOnce(oneshot::Sender<Result<R>>) -> Request,
{
    let (reply_tx, reply_rx) = oneshot::channel();
    let req = build(reply_tx);
    tx.send(req).await.map_err(|_| AutomationError::Internal {
        message: "automation worker channel closed".into(),
    })?;
    reply_rx.await.map_err(|_| AutomationError::Internal {
        message: "automation worker dropped reply channel".into(),
    })?
}

impl AutomationHandle {
    pub async fn capabilities(&self) -> Result<Capabilities> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(Request::Capabilities { reply: reply_tx })
            .await
            .map_err(|_| AutomationError::Internal {
                message: "automation worker channel closed".into(),
            })?;
        reply_rx.await.map_err(|_| AutomationError::Internal {
            message: "automation worker dropped reply channel".into(),
        })
    }

    pub async fn get_focus(&self) -> Result<ElementInfo> {
        round_trip(&self.tx, |reply| Request::GetFocus { reply }).await
    }

    pub async fn list_apps(&self) -> Result<Vec<super::session::ResolvedApplication>> {
        round_trip(&self.tx, |reply| Request::ListApps { reply }).await
    }

    pub async fn read_tree(
        &self,
        root: Option<ElementRef>,
        opts: TreeOpts,
    ) -> Result<Vec<ElementInfo>> {
        round_trip(&self.tx, |reply| Request::ReadTree { root, opts, reply }).await
    }

    pub async fn find(&self, locator: Locator) -> Result<Option<ElementRef>> {
        round_trip(&self.tx, |reply| Request::Find { locator, reply }).await
    }

    pub async fn screenshot(&self, opts: ScreenshotOpts) -> Result<Screenshot> {
        round_trip(&self.tx, |reply| Request::Screenshot { opts, reply }).await
    }

    pub async fn click(&self, target: ClickTarget, opts: ClickOpts) -> Result<()> {
        round_trip(&self.tx, |reply| Request::Click {
            target,
            opts,
            reply,
        })
        .await
    }

    pub async fn type_text(&self, text: String, opts: TypeOpts) -> Result<()> {
        round_trip(&self.tx, |reply| Request::TypeText { text, opts, reply }).await
    }

    pub async fn send_keys(&self, chord: KeyChord) -> Result<()> {
        round_trip(&self.tx, |reply| Request::SendKeys { chord, reply }).await
    }

    pub async fn invoke_pattern(
        &self,
        target: ElementRef,
        pattern: PatternKind,
        args: serde_json::Value,
    ) -> Result<serde_json::Value> {
        round_trip(&self.tx, |reply| Request::InvokePattern {
            target,
            pattern,
            args,
            reply,
        })
        .await
    }

    pub async fn window_op(&self, target: ElementRef, op: WindowOp) -> Result<()> {
        round_trip(&self.tx, |reply| Request::WindowOp { target, op, reply }).await
    }

    pub async fn subscribe_events(&self, filter: EventFilter) -> Result<SubscriptionId> {
        round_trip(&self.tx, |reply| Request::SubscribeEvents { filter, reply }).await
    }

    pub async fn unsubscribe(&self, sub: SubscriptionId) -> Result<()> {
        round_trip(&self.tx, |reply| Request::Unsubscribe { sub, reply }).await
    }

    pub async fn mouse_move(&self, point: Point) -> Result<()> {
        round_trip(&self.tx, |reply| Request::MouseMove { point, reply }).await
    }

    pub async fn drag(&self, from: Point, to: Point, opts: DragOpts) -> Result<()> {
        round_trip(&self.tx, |reply| Request::Drag {
            from,
            to,
            opts,
            reply,
        })
        .await
    }

    pub async fn scroll(&self, target: ScrollTarget, opts: ScrollOpts) -> Result<()> {
        round_trip(&self.tx, |reply| Request::Scroll {
            target,
            opts,
            reply,
        })
        .await
    }

    pub async fn hold_key(&self, chord: KeyChord, duration_ms: u32) -> Result<()> {
        round_trip(&self.tx, |reply| Request::HoldKey {
            chord,
            duration_ms,
            reply,
        })
        .await
    }

    pub async fn mouse_button(
        &self,
        button: MouseButton,
        transition: ButtonTransition,
    ) -> Result<()> {
        round_trip(&self.tx, |reply| Request::MouseButton {
            button,
            transition,
            reply,
        })
        .await
    }

    pub async fn cursor_position(&self) -> Result<Point> {
        round_trip(&self.tx, |reply| Request::CursorPosition { reply }).await
    }

    pub async fn pick_at_point(&self, point: Point) -> Result<ElementInfo> {
        round_trip(&self.tx, |reply| Request::PickAtPoint { point, reply }).await
    }

    pub async fn read_text_selection(&self) -> Result<Option<TextSelectionSnapshot>> {
        round_trip(&self.tx, |reply| Request::ReadTextSelection { reply }).await
    }

    /// Who has focus, and may we read from it — without reading anything.
    /// Callers use this to skip a selection read entirely for blocked apps.
    pub async fn selection_preflight(
        &self,
    ) -> Result<crate::automation::backend::SelectionPreflight> {
        round_trip(&self.tx, |reply| Request::SelectionPreflight { reply }).await
    }

    pub async fn get_app_state(
        &self,
        session_id: String,
        turn_binding: String,
        locator: AppLocator,
        options: GetAppStateOptions,
    ) -> Result<UiStateRevision> {
        round_trip(&self.tx, |reply| Request::GetAppState {
            session_id,
            turn_binding,
            locator,
            options,
            reply,
        })
        .await
    }

    pub async fn query_elements(
        &self,
        session_id: String,
        lineage_id: String,
        revision: u64,
        locator: Locator,
        limit: usize,
    ) -> Result<Vec<UiTreeNode>> {
        round_trip(&self.tx, |reply| Request::QueryElements {
            session_id,
            lineage_id,
            revision,
            locator,
            limit,
            reply,
        })
        .await
    }

    pub async fn expand_element(
        &self,
        handle: ElementHandle,
        continuation_token: Option<String>,
        limit: usize,
    ) -> Result<ExpandedElements> {
        round_trip(&self.tx, |reply| Request::ExpandElement {
            handle,
            continuation_token,
            limit,
            reply,
        })
        .await
    }

    pub async fn perform_action(
        &self,
        request: ActionRequest,
        turn_binding: String,
    ) -> Result<ActionResult> {
        round_trip(&self.tx, |reply| Request::PerformAction {
            request,
            turn_binding,
            reply,
        })
        .await
    }

    /// Best-effort shutdown — the worker drains in-flight requests and then
    /// exits. The handle's Drop joins the thread.
    pub async fn shutdown(&self) {
        let _ = self.tx.send(Request::Shutdown).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::backend::StubBackend;
    use crate::automation::session::{
        ActionRequest, ActionStatus, ActionStrategy, ActionTarget, AppLocator, GetAppStateOptions,
        UiAction,
    };

    #[tokio::test]
    async fn worker_round_trip_with_stub_backend() {
        let h = Worker::spawn(|| {
            Box::new(StubBackend {
                platform: Platform::Unsupported,
            })
        });
        let caps = h.capabilities().await.unwrap();
        assert_eq!(caps.platform, Platform::Unsupported);
        // Stub returns UnsupportedPlatform for everything else.
        let err = h.get_focus().await.unwrap_err();
        assert!(matches!(err, AutomationError::UnsupportedPlatform));
        let err = h.read_text_selection().await.unwrap_err();
        assert!(matches!(err, AutomationError::UnsupportedPlatform));
        h.shutdown().await;
    }

    #[tokio::test]
    async fn worker_serializes_calls_through_one_thread() {
        let h = Worker::spawn(|| {
            Box::new(StubBackend {
                platform: Platform::Unsupported,
            })
        });
        let mut handles = vec![];
        for _ in 0..16 {
            let h2 = h.clone();
            handles.push(tokio::spawn(async move { h2.capabilities().await }));
        }
        for j in handles {
            let caps = j.await.unwrap().unwrap();
            assert_eq!(caps.platform, Platform::Unsupported);
        }
        h.shutdown().await;
    }

    /// Backend whose `get_focus` always panics. `capabilities` returns
    /// a tracked `Platform` value that lets the panic-restart test prove
    /// the *second* call lands on a fresh backend instance. Toggling via
    /// an `AtomicUsize` so the builder closure can hand out a different
    /// platform on each rebuild.
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct PanickingBackend {
        platform: Platform,
    }

    impl AutomationBackend for PanickingBackend {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                platform: self.platform,
                has_uia: false,
                has_input_sim: false,
                has_screenshot: false,
                has_events: false,
                has_a11y_tree: false,
                monitors: vec![],
            }
        }
        fn get_focus(&self) -> Result<ElementInfo> {
            panic!("intentional backend panic for restart test");
        }
        fn read_tree(&self, _r: Option<ElementRef>, _o: TreeOpts) -> Result<Vec<ElementInfo>> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn find(&self, _l: &Locator) -> Result<Option<ElementRef>> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn screenshot(&self, _o: ScreenshotOpts) -> Result<Screenshot> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn click(&self, _t: ClickTarget, _o: ClickOpts) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn type_text(&self, _text: &str, _o: TypeOpts) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn send_keys(&self, _c: &KeyChord) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn invoke_pattern(
            &self,
            _t: ElementRef,
            _p: PatternKind,
            _a: serde_json::Value,
        ) -> Result<serde_json::Value> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn window_op(&self, _t: ElementRef, _o: WindowOp) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn subscribe_events(&self, _f: EventFilter) -> Result<SubscriptionId> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn unsubscribe(&self, _s: SubscriptionId) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn mouse_move(&self, _p: Point) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn drag(&self, _f: Point, _t: Point, _o: DragOpts) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn scroll(&self, _t: ScrollTarget, _o: ScrollOpts) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn hold_key(&self, _c: &KeyChord, _d: u32) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn mouse_button(&self, _b: MouseButton, _t: ButtonTransition) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn cursor_position(&self) -> Result<Point> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn pick_at_point(&self, _p: Point) -> Result<ElementInfo> {
            Err(AutomationError::UnsupportedPlatform)
        }
    }

    struct StateFixtureBackend;

    impl AutomationBackend for StateFixtureBackend {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                platform: Platform::Macos,
                has_uia: false,
                has_input_sim: true,
                has_screenshot: true,
                has_events: true,
                has_a11y_tree: true,
                monitors: vec![MonitorInfo {
                    id: "main".into(),
                    name: "Main".into(),
                    x: 0,
                    y: 0,
                    width: 1_600,
                    height: 1_200,
                    is_primary: true,
                    scale_factor: 2.0,
                }],
            }
        }
        fn get_focus(&self) -> Result<ElementInfo> {
            Ok(ElementInfo {
                element_ref: ElementRef("notes-window".into()),
                name: Some("Notes".into()),
                automation_id: Some("main-window".into()),
                control_type: Some("window".into()),
                class_name: None,
                bounding_rect: Some(Rect {
                    x: 0,
                    y: 0,
                    width: 800,
                    height: 600,
                }),
                is_enabled: true,
                is_focused: true,
                process_id: Some(42),
                process_name: Some("Notes".into()),
                window_title: Some("Notes".into()),
                children: None,
            })
        }
        fn read_tree(&self, _r: Option<ElementRef>, _o: TreeOpts) -> Result<Vec<ElementInfo>> {
            Ok(vec![self.get_focus()?])
        }
        fn find(&self, _l: &Locator) -> Result<Option<ElementRef>> {
            Ok(None)
        }
        fn screenshot(&self, _o: ScreenshotOpts) -> Result<Screenshot> {
            Ok(Screenshot {
                bytes: "cG5n".into(),
                width: 1_600,
                height: 1_200,
                captured_at: 10,
                format: ImageFormat::Png,
                source_width: None,
                source_height: None,
            })
        }
        fn click(&self, _t: ClickTarget, _o: ClickOpts) -> Result<()> {
            Ok(())
        }
        fn type_text(&self, _text: &str, _o: TypeOpts) -> Result<()> {
            Ok(())
        }
        fn send_keys(&self, _c: &KeyChord) -> Result<()> {
            Ok(())
        }
        fn invoke_pattern(
            &self,
            _t: ElementRef,
            _p: PatternKind,
            _a: serde_json::Value,
        ) -> Result<serde_json::Value> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn window_op(&self, _t: ElementRef, _o: WindowOp) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn subscribe_events(&self, _f: EventFilter) -> Result<SubscriptionId> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn unsubscribe(&self, _s: SubscriptionId) -> Result<()> {
            Err(AutomationError::UnsupportedPlatform)
        }
        fn mouse_move(&self, _p: Point) -> Result<()> {
            Ok(())
        }
        fn drag(&self, _f: Point, _t: Point, _o: DragOpts) -> Result<()> {
            Ok(())
        }
        fn scroll(&self, _t: ScrollTarget, _o: ScrollOpts) -> Result<()> {
            Ok(())
        }
        fn hold_key(&self, _c: &KeyChord, _d: u32) -> Result<()> {
            Ok(())
        }
        fn mouse_button(&self, _b: MouseButton, _t: ButtonTransition) -> Result<()> {
            Ok(())
        }
        fn cursor_position(&self) -> Result<Point> {
            Ok(Point { x: 0, y: 0 })
        }
        fn pick_at_point(&self, _p: Point) -> Result<ElementInfo> {
            self.get_focus()
        }
    }

    #[tokio::test]
    async fn worker_get_app_state_couples_tree_screenshot_and_fresh_turn_token() {
        let h = Worker::spawn(|| Box::new(StateFixtureBackend));
        let state = h
            .get_app_state(
                "session:worker".into(),
                "turn:worker".into(),
                AppLocator::DisplayName {
                    display_name: "Notes".into(),
                },
                GetAppStateOptions::default(),
            )
            .await
            .expect("app state");

        assert_eq!(state.app.display_name, "Notes");
        assert_eq!(state.tree.nodes.len(), 1);
        assert_eq!(
            state.screenshot.as_ref().map(|shot| shot.width),
            Some(1_600)
        );
        assert_eq!(state.surface.scale_factor, 2.0);
        assert!(!state.turn_token.is_empty());
        h.shutdown().await;
    }

    #[tokio::test]
    async fn worker_action_consumes_the_revision_token_and_returns_evidence() {
        let h = Worker::spawn(|| Box::new(StateFixtureBackend));
        let state = h
            .get_app_state(
                "session:action".into(),
                "turn:action".into(),
                AppLocator::DisplayName {
                    display_name: "Notes".into(),
                },
                GetAppStateOptions::default(),
            )
            .await
            .expect("app state");
        let request = ActionRequest {
            turn_token: state.turn_token.clone(),
            target: ActionTarget::Element {
                handle: state.tree.nodes[0].handle.clone(),
            },
            action: UiAction::Click {
                button: None,
                count: None,
            },
            strategy: ActionStrategy::Semantic,
        };

        let result = h
            .perform_action(request.clone(), "turn:action".into())
            .await
            .expect("action result");
        assert_eq!(result.status, ActionStatus::Unknown);
        assert_eq!(result.before_revision, 1);
        assert_eq!(result.after_revision, Some(2));
        assert!(!result.evidence.is_empty());

        let error = h
            .perform_action(request, "turn:action".into())
            .await
            .expect_err("turn token must be single-use");
        assert!(matches!(error, AutomationError::PermissionDenied { .. }));
        h.shutdown().await;
    }

    #[tokio::test]
    async fn worker_restarts_backend_after_panic_in_a_request() {
        // Use a static counter so the builder closure can hand out a
        // distinguishable platform value on each rebuild — that is how
        // the test proves a fresh backend instance came up after the
        // panic. Atomic so the builder closure stays Fn (callable many
        // times from one thread without mutable closure state).
        static BUILDS: AtomicUsize = AtomicUsize::new(0);
        BUILDS.store(0, Ordering::SeqCst);
        let h = Worker::spawn(|| {
            let n = BUILDS.fetch_add(1, Ordering::SeqCst);
            // Map (0,1,2,3,...) to alternating Platform values so the
            // assertion below can verify each rebuild produced a new
            // backend. We use Unsupported / Macos as the toggle pair to
            // stay inside the existing enum variants.
            let platform = if n == 0 {
                Platform::Unsupported
            } else {
                Platform::Macos
            };
            Box::new(PanickingBackend { platform }) as Box<dyn AutomationBackend>
        });
        // Verify the *first* backend is the Unsupported variant.
        let caps_before = h.capabilities().await.unwrap();
        assert_eq!(caps_before.platform, Platform::Unsupported);
        // Trigger the panic — the receiver should reset the backend
        // (rebuild #2) so the next call lands on a fresh one.
        let err = h.get_focus().await.unwrap_err();
        // The panicked request returns channel-dropped, mapped to Internal.
        assert!(matches!(err, AutomationError::Internal { .. }));
        // After the panic the worker rebuilds; second capabilities call
        // now sees the toggled `Macos` value — proof of the restart.
        let caps_after = h.capabilities().await.unwrap();
        assert_eq!(caps_after.platform, Platform::Macos);
        assert!(
            BUILDS.load(Ordering::SeqCst) >= 2,
            "builder must have rebuilt the backend"
        );
        h.shutdown().await;
    }
}
