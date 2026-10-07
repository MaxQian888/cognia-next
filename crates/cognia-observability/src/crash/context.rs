//! Frontend-pushed context — the "what was the user doing" half of the report.
//!
//! The renderer periodically pushes a **redacted** config snapshot
//! (`crash_set_context`) and breadcrumbs (`crash_push_breadcrumb`). We keep the
//! latest in-process for panic reports, and forward it to the out-of-process
//! crash monitor (`monitor::send_meta`) so native-crash reports get the same
//! context even though the monitor is a separate process.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, OnceLock};

/// Max breadcrumbs retained — a small ring, oldest dropped first.
const MAX_BREADCRUMBS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Breadcrumb {
    pub at: String,
    pub level: String,
    pub message: String,
}

/// Serializable, redaction-safe snapshot folded into every crash report.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshot {
    /// Opaque, already-redacted config object supplied by the renderer.
    pub config: serde_json::Value,
    pub breadcrumbs: Vec<Breadcrumb>,
}

#[derive(Default)]
struct CrashContext {
    config: serde_json::Value,
    breadcrumbs: VecDeque<Breadcrumb>,
}

static CONTEXT: Lazy<Mutex<CrashContext>> = Lazy::new(|| Mutex::new(CrashContext::default()));

/// Replace the redacted config object. The renderer is responsible for
/// scrubbing secrets/PII (via `packages/redact/src/index.ts`) before calling.
pub fn set_config(config: serde_json::Value) {
    if let Ok(mut ctx) = CONTEXT.lock() {
        ctx.config = config;
    }
    forward_to_monitor();
}

/// Append a breadcrumb, evicting the oldest beyond [`MAX_BREADCRUMBS`].
pub fn push_breadcrumb(crumb: Breadcrumb) {
    if let Ok(mut ctx) = CONTEXT.lock() {
        if ctx.breadcrumbs.len() >= MAX_BREADCRUMBS {
            ctx.breadcrumbs.pop_front();
        }
        ctx.breadcrumbs.push_back(crumb);
    }
    forward_to_monitor();
}

/// Current snapshot, used by the panic hook. Tolerant of a poisoned lock —
/// returns an empty snapshot rather than panicking inside a panic.
pub fn snapshot() -> ContextSnapshot {
    match CONTEXT.lock() {
        Ok(ctx) => ContextSnapshot {
            config: ctx.config.clone(),
            breadcrumbs: ctx.breadcrumbs.iter().cloned().collect(),
        },
        Err(_) => ContextSnapshot::default(),
    }
}

/// Push the current snapshot (plus app-only extras) to the out-of-process
/// monitor as a `KIND_META` envelope so a subsequent native crash renders with
/// the same context the in-process panic path would use. Best-effort.
pub fn publish_to_monitor() {
    let meta = crate::crash::report::MonitorMeta {
        context: snapshot(),
        extra: crate::crash::report::app_extra(),
    };
    if let Ok(bytes) = serde_json::to_vec(&meta) {
        crate::crash::monitor::send_meta(&bytes);
    }
}

/// Wakes the one thread that forwards the context to the crash monitor.
///
/// Forwarding used to happen inline: every breadcrumb serialized the whole
/// context and wrote it to the monitor's socket from the async command that
/// pushed it. The renderer pushes dozens at startup and the monitor drains its
/// socket slowly (a debug build especially), so once the buffer filled every
/// async worker sat in `writev` and all IPC stalled for up to a minute. Now a
/// push only records that there is something new; one background thread sends
/// the latest context. A burst costs a few sends, and a slow monitor holds up
/// nothing but that thread.
struct ForwardSignal {
    pending: Mutex<bool>,
    wake: Condvar,
}

impl ForwardSignal {
    const fn new() -> Self {
        Self {
            pending: Mutex::new(false),
            wake: Condvar::new(),
        }
    }

    /// Note that the context changed. Never waits on a send.
    fn raise(&self) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *pending = true;
        self.wake.notify_one();
    }

    /// Block until the context changed, and claim that change. Every raise
    /// made after this returns is answered by a later send.
    fn wait(&self) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !*pending {
            pending = self
                .wake
                .wait(pending)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *pending = false;
    }
}

static FORWARD: ForwardSignal = ForwardSignal::new();

fn forward_to_monitor() {
    FORWARD.raise();
    static FORWARDER: OnceLock<()> = OnceLock::new();
    FORWARDER.get_or_init(|| {
        let spawned = std::thread::Builder::new()
            .name("crash-context-forward".into())
            .spawn(|| loop {
                FORWARD.wait();
                publish_to_monitor();
            });
        if let Err(error) = spawned {
            // Native-crash reports then carry the context from the last
            // explicit `publish_to_monitor` only; panics are unaffected.
            log::warn!("crash: context forwarder thread failed to start: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn forwarder(signal: &'static ForwardSignal, send_time: Duration) -> Arc<AtomicUsize> {
        let sends = Arc::new(AtomicUsize::new(0));
        let counted = sends.clone();
        std::thread::spawn(move || loop {
            signal.wait();
            counted.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(send_time);
        });
        sends
    }

    fn settle(sends: &AtomicUsize) -> usize {
        let mut last = sends.load(Ordering::SeqCst);
        loop {
            std::thread::sleep(Duration::from_millis(150));
            let now = sends.load(Ordering::SeqCst);
            if now == last {
                return now;
            }
            last = now;
        }
    }

    #[test]
    fn a_burst_of_pushes_never_waits_and_coalesces_into_a_few_sends() {
        let signal: &'static ForwardSignal = Box::leak(Box::new(ForwardSignal::new()));
        let sends = forwarder(signal, Duration::from_millis(50));
        let started = Instant::now();
        for _ in 0..1_000 {
            signal.raise();
        }
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "raising waited on a send"
        );
        let total = settle(&sends);
        assert!((1..=3).contains(&total), "{total} sends for one burst");
    }

    #[test]
    fn a_change_made_during_a_send_is_sent_afterwards() {
        let signal: &'static ForwardSignal = Box::leak(Box::new(ForwardSignal::new()));
        let sends = forwarder(signal, Duration::from_millis(100));
        signal.raise();
        while sends.load(Ordering::SeqCst) == 0 {
            std::thread::sleep(Duration::from_millis(5));
        }
        // The first send is in progress; this change must not be lost.
        signal.raise();
        assert_eq!(settle(&sends), 2);
    }

    fn crumb(msg: &str) -> Breadcrumb {
        Breadcrumb {
            at: "2026-05-25T00:00:00Z".to_string(),
            level: "info".to_string(),
            message: msg.to_string(),
        }
    }

    /// Both tests mutate the process-global `CONTEXT`; serialize them so one
    /// test's reset cannot interleave with the other's set→snapshot window
    /// (they raced under the parallel test harness).
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn set_config_then_snapshot_roundtrips() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_config(serde_json::json!({ "theme": "dark" }));
        let snap = snapshot();
        assert_eq!(snap.config["theme"], "dark");
    }

    #[test]
    fn breadcrumbs_are_capped_to_ring_size() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Reset to a known state first.
        set_config(serde_json::Value::Null);
        if let Ok(mut ctx) = CONTEXT.lock() {
            ctx.breadcrumbs.clear();
        }
        for i in 0..(MAX_BREADCRUMBS + 10) {
            push_breadcrumb(crumb(&format!("event-{i}")));
        }
        let snap = snapshot();
        assert_eq!(snap.breadcrumbs.len(), MAX_BREADCRUMBS);
        // Oldest evicted — the first retained is event-10.
        assert_eq!(snap.breadcrumbs.first().unwrap().message, "event-10");
        assert_eq!(
            snap.breadcrumbs.last().unwrap().message,
            format!("event-{}", MAX_BREADCRUMBS + 9)
        );
    }
}
