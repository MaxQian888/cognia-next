//! Generic "hold a set of timers, sleep until the soonest, wake early on
//! mutation" primitive.
//!
//! Both `crate::scheduler::daemon::AlarmDaemon` (externally-supplied
//! absolute fire-times, one-shot) and
//! `crate::workflow::triggers::cron_daemon::CronDaemon` (owns cron-expression
//! parsing, multi-shot/self-rearming) are structurally the same loop:
//! `Arc<Mutex<HashMap<id, entry>>>` + `Arc<Notify>`, sleeping until the
//! soonest entry's fire time and waking early via `Notify` when the map is
//! mutated. This module extracts that loop once; each daemon only supplies
//! its own entry type (via `Alarm`) and its own "what to do when due" +
//! "should this re-arm" decision (via `DueEmitter`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use tokio::sync::Notify;

/// Floor on the sleep duration so the loop doesn't spin when the cached
/// next-fire time is already overdue on a heavily loaded host.
const MIN_SLEEP_MS: u64 = 25;

/// How long to sleep when there is nothing armed — `notify` wakes the loop
/// early on any mutation, so this is just a safety net.
const IDLE_SLEEP: Duration = Duration::from_secs(60 * 60);

/// Anything the core loop can track: must expose whether it's currently
/// eligible to fire and its cached next-fire instant. A bare `DateTime<Utc>`
/// (the app scheduler's externally-computed absolute fire-time) is always
/// eligible; a cron entry is eligible only while `enabled` and reports its
/// own cached next-fire time.
pub trait Alarm: Clone + Send + 'static {
    /// `None` means "not currently eligible to fire" (e.g. disabled, or a
    /// cron schedule with no future occurrences).
    fn fire_at(&self) -> Option<DateTime<Utc>>;
}

impl Alarm for DateTime<Utc> {
    fn fire_at(&self) -> Option<DateTime<Utc>> {
        Some(*self)
    }
}

/// Reacts to an entry coming due. Returning `Some(entry)` re-arms it (the
/// cron daemon's multi-shot behavior, after recomputing its next fire);
/// returning `None` drops it (the plain alarm daemon's one-shot behavior).
pub trait DueEmitter<T: Alarm>: Send + Sync + 'static {
    fn emit(&self, id: &str, entry: T, fired_at: DateTime<Utc>) -> Option<T>;
}

/// The shared timer-firing core. Cloning is cheap and shares the same inner
/// state, matching both original daemons' `Clone` handle pattern.
///
/// Each stored entry carries a monotonic *generation* stamp that bumps on every
/// `upsert`. The firing loop captures the generation when it collects a due
/// entry and only applies its re-arm/drop decision if that generation is still
/// current — a compare-and-swap that makes the (necessarily lock-free) `emit`
/// window safe against a concurrent `upsert`/`remove`. Without it, the loop's
/// remove-then-reinsert would resurrect a trigger removed mid-fire (multi-shot
/// cron) or clobber a schedule edited mid-fire.
pub struct AlarmDaemonCore<T: Alarm, E: DueEmitter<T>> {
    inner: Arc<Mutex<HashMap<String, (u64, T)>>>,
    /// Source of generation stamps; bumped once per `upsert`.
    gen_counter: Arc<AtomicU64>,
    notify: Arc<Notify>,
    emitter: Arc<E>,
}

impl<T: Alarm, E: DueEmitter<T>> Clone for AlarmDaemonCore<T, E> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            gen_counter: Arc::clone(&self.gen_counter),
            notify: Arc::clone(&self.notify),
            emitter: Arc::clone(&self.emitter),
        }
    }
}

impl<T: Alarm, E: DueEmitter<T>> AlarmDaemonCore<T, E> {
    pub fn new(emitter: Arc<E>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            gen_counter: Arc::new(AtomicU64::new(0)),
            notify: Arc::new(Notify::new()),
            emitter,
        }
    }

    /// Insert or replace an entry, then wake the loop so it recomputes the
    /// soonest fire including this entry. Stamps the entry with a fresh
    /// generation so a fire in flight for the previous version won't overwrite
    /// this one.
    pub fn upsert(&self, id: String, entry: T) {
        let generation = self.gen_counter.fetch_add(1, Ordering::Relaxed);
        self.inner.lock().insert(id, (generation, entry));
        self.notify.notify_one();
    }

    /// Remove an entry. No-op for unknown ids. Wakes the loop.
    pub fn remove(&self, id: &str) {
        self.inner.lock().remove(id);
        self.notify.notify_one();
    }

    pub fn entry_count(&self) -> usize {
        self.inner.lock().len()
    }

    /// Soonest fire instant among currently-eligible entries, or `None` when
    /// idle.
    pub fn next_fire_at(&self) -> Option<DateTime<Utc>> {
        self.inner
            .lock()
            .values()
            .filter_map(|(_, e)| e.fire_at())
            .min()
    }

    /// The long-running loop body. Consumes `self` — callers pass a clone
    /// (`core.clone().run_loop()`) so they retain a handle to arm/disarm.
    pub async fn run_loop(self) {
        loop {
            let now = Utc::now();
            // Collect due entries onto a local Vec (cloning them, capturing
            // each one's generation) so the lock guard is released before we
            // re-lock per-id below — same "bind to a local first" invariant
            // both original daemons relied on to avoid self-deadlocking the
            // non-reentrant parking_lot mutex.
            let due: Vec<(String, u64, T)> = {
                let map = self.inner.lock();
                map.iter()
                    .filter(|(_, (_, e))| e.fire_at().map(|t| t <= now).unwrap_or(false))
                    .map(|(id, (generation, e))| (id.clone(), *generation, e.clone()))
                    .collect()
            };

            for (id, generation, entry) in due {
                // Skip firing if this exact armed version was removed or
                // replaced between collection and now (don't fire a cancelled
                // or superseded entry).
                {
                    let map = self.inner.lock();
                    match map.get(&id) {
                        Some((current, _)) if *current == generation => {}
                        _ => continue,
                    }
                }
                // Fire outside the lock — emit posts an IPC event and must not
                // hold the map lock. A concurrent upsert()/remove() may land
                // during this window.
                let reinsert = self.emitter.emit(&id, entry, now);
                // Apply the re-arm (multi-shot) or drop (one-shot) ONLY if no
                // concurrent mutation landed during emit: a concurrent upsert
                // bumped the generation and a remove dropped the id, so in
                // either case we leave the newer state untouched — never
                // resurrecting a removed entry or clobbering an edited one.
                let mut map = self.inner.lock();
                match map.get(&id) {
                    Some((current, _)) if *current == generation => match reinsert {
                        Some(next) => {
                            map.insert(id, (generation, next));
                        }
                        None => {
                            map.remove(&id);
                        }
                    },
                    _ => {}
                }
            }

            let next = self.next_fire_at();
            let sleep_dur = match next {
                Some(t) => {
                    let ms = (t - Utc::now()).num_milliseconds().max(0) as u64;
                    Duration::from_millis(ms.max(MIN_SLEEP_MS))
                }
                None => IDLE_SLEEP,
            };

            tokio::select! {
                _ = tokio::time::sleep(sleep_dur) => {}
                _ = self.notify.notified() => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration as StdDuration;

    #[derive(Clone)]
    struct TestEntry(Option<DateTime<Utc>>);

    impl Alarm for TestEntry {
        fn fire_at(&self) -> Option<DateTime<Utc>> {
            self.0
        }
    }

    #[derive(Default)]
    struct RecordingEmitter {
        fired: Mutex<Vec<(String, DateTime<Utc>)>>,
        reinsert: bool,
    }

    impl DueEmitter<TestEntry> for RecordingEmitter {
        fn emit(&self, id: &str, entry: TestEntry, fired_at: DateTime<Utc>) -> Option<TestEntry> {
            self.fired.lock().push((id.to_string(), fired_at));
            if self.reinsert {
                Some(entry)
            } else {
                None
            }
        }
    }

    fn core_with_recorder(
        reinsert: bool,
    ) -> (
        AlarmDaemonCore<TestEntry, RecordingEmitter>,
        Arc<RecordingEmitter>,
    ) {
        let recorder = Arc::new(RecordingEmitter {
            fired: Mutex::new(Vec::new()),
            reinsert,
        });
        (AlarmDaemonCore::new(Arc::clone(&recorder)), recorder)
    }

    #[test]
    fn upsert_inserts_and_replaces() {
        let (core, _) = core_with_recorder(false);
        let future = Utc::now() + chrono::Duration::hours(1);
        core.upsert("a".into(), TestEntry(Some(future)));
        core.upsert(
            "a".into(),
            TestEntry(Some(future + chrono::Duration::seconds(1))),
        );
        assert_eq!(core.entry_count(), 1);
    }

    #[test]
    fn remove_drops_an_entry() {
        let (core, _) = core_with_recorder(false);
        let future = Utc::now() + chrono::Duration::hours(1);
        core.upsert("a".into(), TestEntry(Some(future)));
        core.remove("a");
        assert_eq!(core.entry_count(), 0);
        core.remove("nope"); // no-op
    }

    #[test]
    fn next_fire_at_returns_soonest_and_skips_ineligible_entries() {
        let (core, _) = core_with_recorder(false);
        let soon = Utc::now() + chrono::Duration::seconds(30);
        let later = Utc::now() + chrono::Duration::hours(2);
        core.upsert("later".into(), TestEntry(Some(later)));
        core.upsert("soon".into(), TestEntry(Some(soon)));
        core.upsert("disabled".into(), TestEntry(None));
        let next = core.next_fire_at().expect("expected a future fire");
        assert!((next.timestamp_millis() - soon.timestamp_millis()).abs() < 1000);
    }

    #[tokio::test]
    async fn run_loop_fires_due_entry_and_removes_when_emitter_returns_none() {
        let (core, recorder) = core_with_recorder(false);
        let past = Utc::now() - chrono::Duration::seconds(1);
        core.upsert("a".into(), TestEntry(Some(past)));

        // `timeout` drops the run_loop future when it elapses, so there is
        // no detached task left running to block runtime shutdown.
        let _ = tokio::time::timeout(StdDuration::from_millis(200), core.clone().run_loop()).await;

        let fired = recorder.fired.lock().clone();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].0, "a");
        assert_eq!(core.entry_count(), 0);
    }

    #[tokio::test]
    async fn run_loop_reinserts_when_emitter_returns_some() {
        let (core, recorder) = core_with_recorder(true);
        let past = Utc::now() - chrono::Duration::seconds(1);
        core.upsert("a".into(), TestEntry(Some(past)));

        let _ = tokio::time::timeout(StdDuration::from_millis(200), core.clone().run_loop()).await;

        assert!(!recorder.fired.lock().is_empty());
        // Re-armed, not dropped.
        assert_eq!(core.entry_count(), 1);
    }

    #[tokio::test]
    async fn run_loop_does_not_fire_future_entries() {
        let (core, recorder) = core_with_recorder(false);
        let future = Utc::now() + chrono::Duration::hours(1);
        core.upsert("a".into(), TestEntry(Some(future)));

        let _ = tokio::time::timeout(StdDuration::from_millis(200), core.clone().run_loop()).await;

        assert!(recorder.fired.lock().is_empty());
        assert_eq!(core.entry_count(), 1);
    }

    /// Emitter that mutates the very core the loop is driving *during* `emit`,
    /// simulating a concurrent `upsert`/`remove` landing in the lock-free fire
    /// window. `core` is filled in after construction (the core owns the
    /// emitter, so the reference is set once both exist).
    struct RaceEmitter {
        core: Mutex<Option<AlarmDaemonCore<TestEntry, RaceEmitter>>>,
        on_fire: Box<dyn Fn(&AlarmDaemonCore<TestEntry, RaceEmitter>, &str) + Send + Sync>,
        fired: Mutex<usize>,
        reinsert: bool,
    }

    impl DueEmitter<TestEntry> for RaceEmitter {
        fn emit(&self, id: &str, entry: TestEntry, _fired_at: DateTime<Utc>) -> Option<TestEntry> {
            *self.fired.lock() += 1;
            if let Some(core) = self.core.lock().clone() {
                (self.on_fire)(&core, id);
            }
            if self.reinsert {
                Some(entry)
            } else {
                None
            }
        }
    }

    fn racing_core(
        reinsert: bool,
        on_fire: impl Fn(&AlarmDaemonCore<TestEntry, RaceEmitter>, &str) + Send + Sync + 'static,
    ) -> (AlarmDaemonCore<TestEntry, RaceEmitter>, Arc<RaceEmitter>) {
        let emitter = Arc::new(RaceEmitter {
            core: Mutex::new(None),
            on_fire: Box::new(on_fire),
            fired: Mutex::new(0),
            reinsert,
        });
        let core = AlarmDaemonCore::new(Arc::clone(&emitter));
        *emitter.core.lock() = Some(core.clone());
        (core, emitter)
    }

    #[tokio::test]
    async fn rearm_does_not_resurrect_an_entry_removed_during_emit() {
        // Multi-shot (reinsert=true) entry that is remove()d mid-fire. The old
        // remove-then-reinsert loop would have re-armed the stale clone; the
        // generation CAS must leave it dropped.
        let (core, emitter) = racing_core(true, |core, id| core.remove(id));
        let past = Utc::now() - chrono::Duration::seconds(1);
        core.upsert("a".into(), TestEntry(Some(past)));

        let _ = tokio::time::timeout(StdDuration::from_millis(200), core.clone().run_loop()).await;

        assert!(*emitter.fired.lock() >= 1);
        assert_eq!(core.entry_count(), 0, "removed-during-emit must not resurrect");
    }

    #[tokio::test]
    async fn rearm_does_not_clobber_an_upsert_during_emit() {
        // A schedule edit (upsert to a far-future time) lands mid-fire. The
        // stale re-arm must not overwrite the user's newer entry.
        let far = Utc::now() + chrono::Duration::hours(5);
        let (core, _emitter) = racing_core(true, move |core, id| {
            core.upsert(id.to_string(), TestEntry(Some(far)));
        });
        let past = Utc::now() - chrono::Duration::seconds(1);
        core.upsert("a".into(), TestEntry(Some(past)));

        let _ = tokio::time::timeout(StdDuration::from_millis(200), core.clone().run_loop()).await;

        assert_eq!(core.entry_count(), 1);
        let next = core.next_fire_at().expect("entry should still be armed");
        assert!(
            (next.timestamp_millis() - far.timestamp_millis()).abs() < 2000,
            "concurrent upsert must survive the stale re-arm",
        );
    }
}
