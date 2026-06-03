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
use std::sync::Mutex;

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
/// scrubbing secrets/PII (via `lib/twin/ingest/redact.ts`) before calling.
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

fn forward_to_monitor() {
    publish_to_monitor();
}

#[cfg(test)]
mod tests {
    use super::*;

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
