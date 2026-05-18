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

use std::sync::Arc;
use std::thread::{self, JoinHandle};
use tokio::sync::oneshot;

use super::backend::AutomationBackend;
use super::types::*;

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
    /// Spawn the worker thread. The `builder` closure runs *on* the worker
    /// thread, so the back-end is allowed to hold `!Send` resources (Windows
    /// UIA's COM pointer is the canonical example). The closure itself must
    /// be `Send + 'static` so it can cross the spawn boundary.
    pub fn spawn<F>(builder: F) -> AutomationHandle
    where
        F: FnOnce() -> Box<dyn AutomationBackend> + Send + 'static,
    {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Request>(64);
        let thread = thread::Builder::new()
            .name("automation-worker".into())
            .spawn(move || {
                let backend = builder();
                // Drain the channel synchronously. We're not in async land here;
                // `blocking_recv` is exactly what we want.
                while let Some(req) = rx.blocking_recv() {
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
                        Request::WindowOp {
                            target,
                            op,
                            reply,
                        } => {
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
                        Request::Shutdown => break,
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

/// Helper: send a request and await the reply, mapping channel errors.
async fn round_trip<R, F>(
    tx: &tokio::sync::mpsc::Sender<Request>,
    build: F,
) -> Result<R>
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
        round_trip(&self.tx, |reply| Request::WindowOp {
            target,
            op,
            reply,
        })
        .await
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
}
