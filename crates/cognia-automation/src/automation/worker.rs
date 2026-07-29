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
use super::selection::TextSelectionSnapshot;
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
                let mut restart_count: u32 = 0;
                let mut window_start = Instant::now();
                // Drain the channel synchronously. We're not in async land here;
                // `blocking_recv` is exactly what we want.
                while let Some(req) = rx.blocking_recv() {
                    let result =
                        std::panic::catch_unwind(AssertUnwindSafe(|| dispatch(&*backend, req)));
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
fn dispatch(backend: &dyn AutomationBackend, req: Request) -> DispatchControl {
    match req {
        Request::Capabilities { reply } => {
            let _ = reply.send(backend.capabilities());
        }
        Request::GetFocus { reply } => {
            let _ = reply.send(backend.get_focus());
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
        Request::Shutdown => return DispatchControl::Stop,
    }
    DispatchControl::Continue
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
