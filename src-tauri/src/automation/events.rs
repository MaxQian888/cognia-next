//! UIA event sink — forwards backend event-subscription callbacks to the
//! renderer as `automation:uia-event` Tauri events.
//!
//! The backend watcher threads (see `platform/uia/events.rs`) run on plain
//! OS threads without an `AppHandle`, so delivery goes through a process-wide
//! sink seam: `lib.rs` wires the real Tauri emitter at setup; unit tests
//! install a capturing closure. Distinct from `automation:event` (the audit
//! ring channel) — this stream carries live UI events for the workflow
//! `trigger.desktop.event` fan-out.

use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Renderer event name the TS trigger listens on.
pub const UIA_EVENT_NAME: &str = "automation:uia-event";

/// One UI event delivered to the renderer. `kind` uses the same kebab-case
/// wire values as [`super::types::EventKind`] ("focus-changed", …).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiaEventPayload {
    pub subscription_id: u64,
    pub kind: String,
    /// Focused element's accessible name (may carry user text — the TS
    /// fan-out PII-gates it before any workflow payload).
    pub name: Option<String>,
    pub control_type: Option<String>,
    pub process_id: Option<u32>,
    /// Wall-clock millis when the watcher observed the event.
    pub at: u64,
}

type Sink = Arc<dyn Fn(UiaEventPayload) + Send + Sync>;

static EVENT_SINK: RwLock<Option<Sink>> = RwLock::new(None);

/// Install the process-wide sink (replaces any previous one).
pub fn set_uia_event_sink(sink: Sink) {
    *EVENT_SINK.write() = Some(sink);
}

/// Wire the sink to a Tauri `AppHandle` — called once from `lib.rs::setup`.
pub fn wire_uia_event_sink(app: AppHandle) {
    set_uia_event_sink(Arc::new(move |payload| {
        let _ = app.emit(UIA_EVENT_NAME, &payload);
    }));
}

/// Deliver one event through the sink. No-op (dropped) before wiring —
/// a watcher can outlive the renderer during shutdown, so this must never
/// panic or block.
// Delivery happens only from the Windows-only UIA watcher (`platform::uia`,
// gated to `target_os = "windows"`) and from tests; the sink itself is wired on
// every platform, so the emitter is legitimately unused on non-Windows,
// non-test builds.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn emit_uia_event(payload: UiaEventPayload) {
    let sink = EVENT_SINK.read().clone();
    if let Some(sink) = sink {
        sink(payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::{Mutex as StdMutex, MutexGuard, OnceLock};

    // The sink is process-global — serialize tests that touch it.
    static SINK_TEST_LOCK: OnceLock<StdMutex<()>> = OnceLock::new();

    fn sink_guard() -> MutexGuard<'static, ()> {
        SINK_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .expect("sink test lock poisoned")
    }

    fn payload(id: u64) -> UiaEventPayload {
        UiaEventPayload {
            subscription_id: id,
            kind: "focus-changed".into(),
            name: Some("OK".into()),
            control_type: Some("Button".into()),
            process_id: Some(42),
            at: 1_000,
        }
    }

    #[test]
    fn emit_before_wiring_is_a_noop() {
        let _guard = sink_guard();
        *EVENT_SINK.write() = None;
        emit_uia_event(payload(1)); // must not panic
    }

    #[test]
    fn emit_after_set_delivers_to_the_sink() {
        let _guard = sink_guard();
        let seen: Arc<Mutex<Vec<UiaEventPayload>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_clone = seen.clone();
        set_uia_event_sink(Arc::new(move |p| seen_clone.lock().push(p)));

        emit_uia_event(payload(7));

        let rows = seen.lock();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subscription_id, 7);
        assert_eq!(rows[0].kind, "focus-changed");
        *EVENT_SINK.write() = None;
    }

    #[test]
    fn payload_serializes_camel_case_for_the_renderer() {
        let json = serde_json::to_value(payload(3)).unwrap();
        assert_eq!(json["subscriptionId"], 3);
        assert_eq!(json["kind"], "focus-changed");
        assert_eq!(json["controlType"], "Button");
        assert_eq!(json["processId"], 42);
    }
}
