//! UIA event subscriptions — v1 focus-changed watcher.
//!
//! v1 deliberately uses a poll watcher (500 ms `get_focused_element` +
//! runtime-id diff on a dedicated thread) instead of UIA's COM event
//! handlers: `uiautomation` 0.25's `UIFocusChangedEventHandler` registration
//! must happen on an STA thread with a message pump, which the MTA worker
//! thread deliberately is not (see `worker.rs`). The poll watcher delivers
//! REAL focus-change events with sub-second latency, is trivially portable
//! to the other backends, and needs no COM re-plumbing. `structure-changed`
//! / `property-changed` return an explicit `BackendError` until a real
//! event-handler wiring lands.
//!
//! Each subscription owns one watcher thread with a stop flag; the thread
//! creates its OWN `UIAutomation` (COM is per-thread) and forwards events
//! through the process-wide sink (`automation::events::emit_uia_event`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use crate::automation::events::{emit_uia_event, UiaEventPayload};
use crate::automation::types::{AutomationError, EventFilter, EventKind, Result, SubscriptionId};

const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Validate a v1 filter: only `focus-changed` has a firing path. `kinds:
/// None` means "everything available", which in v1 is focus-changed.
pub fn validate_filter(filter: &EventFilter) -> Result<()> {
    if let Some(kinds) = &filter.kinds {
        if kinds.is_empty() {
            return Err(AutomationError::BackendError {
                message: "subscribe_events: kinds must not be empty".into(),
            });
        }
        if !kinds.contains(&EventKind::FocusChanged) {
            return Err(AutomationError::BackendError {
                message:
                    "subscribe_events: only focus-changed is supported in v1 (structure-changed / property-changed pending)"
                        .into(),
            });
        }
    }
    Ok(())
}

/// Bookkeeping for live watcher threads. Owned by `UiaBackend`; dropping it
/// stops every watcher (best-effort, via the shared stop flags).
pub struct EventSubscriptions {
    next: AtomicU64,
    stops: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl EventSubscriptions {
    pub fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            stops: Mutex::new(HashMap::new()),
        }
    }

    /// Register a subscription and hand the (id, stop flag) pair to
    /// `spawn_watcher`. Split from [`subscribe`](Self::subscribe) so unit
    /// tests can inject a no-op watcher instead of standing up real UIA.
    pub fn subscribe_with(
        &self,
        filter: &EventFilter,
        spawn_watcher: impl FnOnce(u64, Arc<AtomicBool>),
    ) -> Result<SubscriptionId> {
        validate_filter(filter)?;
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let stop = Arc::new(AtomicBool::new(false));
        self.stops.lock().insert(id, stop.clone());
        spawn_watcher(id, stop);
        Ok(SubscriptionId(id))
    }

    /// Register a focus-changed poll watcher on a fresh OS thread.
    pub fn subscribe(&self, filter: &EventFilter) -> Result<SubscriptionId> {
        self.subscribe_with(filter, |id, stop| {
            std::thread::Builder::new()
                .name(format!("uia-focus-watch-{id}"))
                .spawn(move || run_focus_watcher(id, stop))
                .map(|_| ())
                .unwrap_or_else(|err| {
                    log::warn!("uia focus watcher {id} failed to spawn: {err}");
                });
        })
    }

    /// Stop a watcher. Unknown ids error so a caller-side leak is visible.
    pub fn unsubscribe(&self, sub: &SubscriptionId) -> Result<()> {
        match self.stops.lock().remove(&sub.0) {
            Some(stop) => {
                stop.store(true, Ordering::Relaxed);
                Ok(())
            }
            None => Err(AutomationError::BackendError {
                message: format!("unsubscribe: unknown subscription id {}", sub.0),
            }),
        }
    }

    /// Live watcher count — test-only observability.
    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.stops.lock().len()
    }
}

impl Drop for EventSubscriptions {
    fn drop(&mut self) {
        for (_, stop) in self.stops.lock().drain() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

/// The watcher loop: poll the focused element and emit on runtime-id change.
/// Runs on its own thread — `UIAutomation::new()` initializes COM there.
fn run_focus_watcher(id: u64, stop: Arc<AtomicBool>) {
    let automation = match uiautomation::UIAutomation::new() {
        Ok(a) => a,
        Err(err) => {
            log::warn!("uia focus watcher {id}: UIAutomation::new failed: {err}");
            return;
        }
    };
    let mut last_runtime_id: Option<Vec<i32>> = None;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(POLL_INTERVAL);
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let Ok(elt) = automation.get_focused_element() else {
            continue; // e.g. secure desktop / UAC prompt — keep watching
        };
        let runtime_id = elt.get_runtime_id().ok();
        if runtime_id.is_none() || runtime_id == last_runtime_id {
            continue;
        }
        let first = last_runtime_id.is_none();
        last_runtime_id = runtime_id;
        // The first observation is the baseline, not a change.
        if first {
            continue;
        }
        emit_uia_event(UiaEventPayload {
            subscription_id: id,
            kind: "focus-changed".into(),
            name: elt.get_name().ok().filter(|s| !s.is_empty()),
            control_type: elt.get_control_type().ok().map(|ct| format!("{ct:?}")),
            process_id: elt.get_process_id().ok(),
            at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(kinds: Option<Vec<EventKind>>) -> EventFilter {
        EventFilter { kinds, scope: None }
    }

    #[test]
    fn validate_accepts_focus_changed_and_unscoped_filters() {
        assert!(validate_filter(&filter(None)).is_ok());
        assert!(validate_filter(&filter(Some(vec![EventKind::FocusChanged]))).is_ok());
        assert!(validate_filter(&filter(Some(vec![
            EventKind::FocusChanged,
            EventKind::StructureChanged,
        ])))
        .is_ok());
    }

    #[test]
    fn validate_rejects_filters_without_a_v1_kind() {
        assert!(validate_filter(&filter(Some(vec![EventKind::StructureChanged]))).is_err());
        assert!(validate_filter(&filter(Some(vec![EventKind::PropertyChanged]))).is_err());
        assert!(validate_filter(&filter(Some(vec![]))).is_err());
    }

    #[test]
    fn subscribe_with_registers_and_unsubscribe_flags_the_watcher() {
        let subs = EventSubscriptions::new();
        let mut captured: Option<(u64, Arc<AtomicBool>)> = None;
        let id = subs
            .subscribe_with(&filter(None), |id, stop| captured = Some((id, stop)))
            .unwrap();
        let (watch_id, stop) = captured.expect("watcher spawned");
        assert_eq!(watch_id, id.0);
        assert_eq!(subs.active_count(), 1);
        assert!(!stop.load(Ordering::Relaxed));

        subs.unsubscribe(&id).unwrap();
        assert!(stop.load(Ordering::Relaxed));
        assert_eq!(subs.active_count(), 0);
    }

    #[test]
    fn unsubscribe_unknown_id_errors() {
        let subs = EventSubscriptions::new();
        assert!(subs.unsubscribe(&SubscriptionId(99)).is_err());
    }

    #[test]
    fn drop_stops_every_live_watcher() {
        let subs = EventSubscriptions::new();
        let mut stops: Vec<Arc<AtomicBool>> = Vec::new();
        for _ in 0..3 {
            subs.subscribe_with(&filter(None), |_, stop| stops.push(stop))
                .unwrap();
        }
        drop(subs);
        assert!(stops.iter().all(|s| s.load(Ordering::Relaxed)));
    }
}
