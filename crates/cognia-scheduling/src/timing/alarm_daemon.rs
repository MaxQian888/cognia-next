//! Generic "hold a set of timers, sleep until the soonest, wake early on
//! mutation" primitive.
//!
//! Both `crate::scheduler::daemon::AlarmDaemon` (externally-supplied
//! absolute fire-times, one-shot) and
//! `crate::workflow::triggers::cron_daemon::CronDaemon` (owns cron-expression
//! parsing, multi-shot/self-rearming) are structurally the same loop: a keyed
//! set of timers + `Arc<Notify>`, sleeping until the soonest entry's fire time
//! and waking early via `Notify` when the set is mutated. This module extracts
//! that loop once; each daemon only supplies its own entry type (via `Alarm`)
//! and its own "what to do when due" + "should this re-arm" decision (via
//! `DueEmitter`).
//!
//! The soonest entry comes off a min-heap ordered by fire time, so a wake costs
//! O(log n) per due entry instead of a scan of every armed timer. Removal and
//! replacement are lazy: the map is the source of truth, and a heap node whose
//! generation no longer matches the map is discarded when it surfaces.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
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

/// Ceiling on one sleep while something is armed.
///
/// `tokio::time::sleep` measures a monotonic clock, and on macOS that clock
/// does not advance while the machine is asleep. A single sleep computed from
/// the wall clock before a lid close would therefore still be pending after the
/// lid opens, and every alarm that came due in between would fire late by the
/// full length of the nap. Waking at least this often re-reads the wall clock,
/// bounding that lateness to this interval.
const MAX_ARMED_SLEEP: Duration = Duration::from_secs(30);

/// Rebuild the heap once stale nodes outnumber live entries by this factor, so
/// a timer re-armed many times ahead of its fire does not grow it unbounded.
const HEAP_COMPACT_FACTOR: usize = 2;
const HEAP_COMPACT_FLOOR: usize = 64;

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

/// One heap node: (fire time, generation, id). `Reverse` turns the std
/// max-heap into a min-heap on fire time; generation breaks ties stably.
type HeapNode = Reverse<(DateTime<Utc>, u64, String)>;

struct TimerSet<T> {
    /// Source of truth: the live entry per id and the generation it was armed at.
    entries: HashMap<String, (u64, T)>,
    /// Fire-time index over `entries`. May hold stale nodes (see module docs).
    heap: BinaryHeap<HeapNode>,
}

impl<T: Alarm> TimerSet<T> {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            heap: BinaryHeap::new(),
        }
    }

    fn is_live(&self, fire_at: DateTime<Utc>, generation: u64, id: &str) -> bool {
        match self.entries.get(id) {
            Some((current, entry)) => *current == generation && entry.fire_at() == Some(fire_at),
            None => false,
        }
    }

    fn insert(&mut self, id: String, generation: u64, entry: T) {
        if let Some(fire_at) = entry.fire_at() {
            self.heap.push(Reverse((fire_at, generation, id.clone())));
        }
        self.entries.insert(id, (generation, entry));
        self.compact_if_bloated();
    }

    /// Drop stale nodes off the top so `peek` answers with a live entry.
    fn prune_top(&mut self) {
        while let Some(Reverse((fire_at, generation, id))) = self.heap.peek() {
            if self.is_live(*fire_at, *generation, id) {
                return;
            }
            self.heap.pop();
        }
    }

    fn next_fire_at(&mut self) -> Option<DateTime<Utc>> {
        self.prune_top();
        self.heap.peek().map(|Reverse((fire_at, _, _))| *fire_at)
    }

    /// Pop every live entry due at or before `now`, soonest first.
    fn take_due(&mut self, now: DateTime<Utc>) -> Vec<(String, u64, T)> {
        let mut due = Vec::new();
        loop {
            self.prune_top();
            let Some(Reverse((fire_at, _, _))) = self.heap.peek() else {
                break;
            };
            if *fire_at > now {
                break;
            }
            let Reverse((_, generation, id)) = self.heap.pop().expect("peeked node exists");
            if let Some((_, entry)) = self.entries.get(&id) {
                due.push((id, generation, entry.clone()));
            }
        }
        due
    }

    fn compact_if_bloated(&mut self) {
        let limit = self.entries.len() * HEAP_COMPACT_FACTOR + HEAP_COMPACT_FLOOR;
        if self.heap.len() <= limit {
            return;
        }
        self.heap = self
            .entries
            .iter()
            .filter_map(|(id, (generation, entry))| {
                entry
                    .fire_at()
                    .map(|fire_at| Reverse((fire_at, *generation, id.clone())))
            })
            .collect();
    }
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
    inner: Arc<Mutex<TimerSet<T>>>,
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
            inner: Arc::new(Mutex::new(TimerSet::new())),
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
        self.inner.lock().insert(id, generation, entry);
        self.notify.notify_one();
    }

    /// Remove an entry. No-op for unknown ids. Wakes the loop. The entry's heap
    /// node is left behind and discarded when it surfaces.
    pub fn remove(&self, id: &str) {
        self.inner.lock().entries.remove(id);
        self.notify.notify_one();
    }

    pub fn entry_count(&self) -> usize {
        self.inner.lock().entries.len()
    }

    /// Soonest fire instant among currently-eligible entries, or `None` when
    /// idle.
    pub fn next_fire_at(&self) -> Option<DateTime<Utc>> {
        self.inner.lock().next_fire_at()
    }

    /// How long the loop may sleep given the soonest armed instant.
    fn sleep_for(next: Option<DateTime<Utc>>, now: DateTime<Utc>) -> Duration {
        match next {
            Some(t) => {
                let ms = (t - now).num_milliseconds().max(0) as u64;
                Duration::from_millis(ms.max(MIN_SLEEP_MS)).min(MAX_ARMED_SLEEP)
            }
            None => IDLE_SLEEP,
        }
    }

    /// The long-running loop body. Consumes `self` — callers pass a clone
    /// (`core.clone().run_loop()`) so they retain a handle to arm/disarm.
    pub async fn run_loop(self) {
        loop {
            let now = Utc::now();
            // Pop the due entries onto a local Vec (cloning them, capturing
            // each one's generation) so the lock guard is released before we
            // re-lock per-id below — same "bind to a local first" invariant
            // both original daemons relied on to avoid self-deadlocking the
            // non-reentrant parking_lot mutex. Soonest first, so a backlog
            // after a long sleep fires in schedule order.
            let due = self.inner.lock().take_due(now);

            for (id, generation, entry) in due {
                // Skip firing if this exact armed version was removed or
                // replaced between collection and now (don't fire a cancelled
                // or superseded entry).
                {
                    let timers = self.inner.lock();
                    match timers.entries.get(&id) {
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
                let mut timers = self.inner.lock();
                let still_current = matches!(
                    timers.entries.get(&id),
                    Some((current, _)) if *current == generation
                );
                if still_current {
                    match reinsert {
                        Some(next) => timers.insert(id, generation, next),
                        None => {
                            timers.entries.remove(&id);
                        }
                    }
                }
            }

            let sleep_dur = Self::sleep_for(self.next_fire_at(), Utc::now());

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
    type RaceOnFire =
        dyn Fn(&AlarmDaemonCore<TestEntry, RaceEmitter>, &str) + Send + Sync + 'static;

    struct RaceEmitter {
        core: Mutex<Option<AlarmDaemonCore<TestEntry, RaceEmitter>>>,
        on_fire: Box<RaceOnFire>,
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
        assert_eq!(
            core.entry_count(),
            0,
            "removed-during-emit must not resurrect"
        );
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

    #[tokio::test]
    async fn backlog_fires_soonest_first() {
        let (core, recorder) = core_with_recorder(false);
        let now = Utc::now();
        core.upsert(
            "c".into(),
            TestEntry(Some(now - chrono::Duration::seconds(1))),
        );
        core.upsert(
            "a".into(),
            TestEntry(Some(now - chrono::Duration::seconds(30))),
        );
        core.upsert(
            "b".into(),
            TestEntry(Some(now - chrono::Duration::seconds(10))),
        );

        let _ = tokio::time::timeout(StdDuration::from_millis(200), core.clone().run_loop()).await;

        let order: Vec<String> = recorder
            .fired
            .lock()
            .iter()
            .map(|(id, _)| id.clone())
            .collect();
        assert_eq!(order, vec!["a", "b", "c"]);
    }

    #[tokio::test]
    async fn rearming_later_does_not_fire_at_the_superseded_time() {
        let (core, recorder) = core_with_recorder(false);
        core.upsert(
            "a".into(),
            TestEntry(Some(Utc::now() - chrono::Duration::seconds(1))),
        );
        // Re-armed into the future before the loop ever ran: the old (due) heap
        // node is stale and must be discarded, not fired.
        core.upsert(
            "a".into(),
            TestEntry(Some(Utc::now() + chrono::Duration::hours(1))),
        );

        let _ = tokio::time::timeout(StdDuration::from_millis(200), core.clone().run_loop()).await;

        assert!(recorder.fired.lock().is_empty());
        assert_eq!(core.entry_count(), 1);
    }

    #[tokio::test]
    async fn removed_entry_never_fires_even_though_its_node_is_still_queued() {
        let (core, recorder) = core_with_recorder(false);
        core.upsert(
            "a".into(),
            TestEntry(Some(Utc::now() - chrono::Duration::seconds(1))),
        );
        core.remove("a");

        let _ = tokio::time::timeout(StdDuration::from_millis(200), core.clone().run_loop()).await;

        assert!(recorder.fired.lock().is_empty());
        assert_eq!(core.next_fire_at(), None);
    }

    #[test]
    fn next_fire_at_skips_stale_nodes() {
        let (core, _) = core_with_recorder(false);
        let soon = Utc::now() + chrono::Duration::seconds(30);
        let later = Utc::now() + chrono::Duration::hours(2);
        core.upsert("a".into(), TestEntry(Some(soon)));
        core.upsert("a".into(), TestEntry(Some(later)));
        let next = core.next_fire_at().expect("armed");
        assert!((next.timestamp_millis() - later.timestamp_millis()).abs() < 1000);
    }

    #[test]
    fn repeated_rearms_keep_the_heap_bounded() {
        let (core, _) = core_with_recorder(false);
        let base = Utc::now() + chrono::Duration::hours(1);
        for step in 0..10_000 {
            core.upsert(
                "a".into(),
                TestEntry(Some(base + chrono::Duration::seconds(step))),
            );
        }
        let heap_len = core.inner.lock().heap.len();
        assert!(
            heap_len <= HEAP_COMPACT_FACTOR + HEAP_COMPACT_FLOOR + 1,
            "heap grew to {heap_len}"
        );
        assert_eq!(core.entry_count(), 1);
    }

    #[test]
    fn armed_sleep_is_capped_so_the_wall_clock_is_reread() {
        let now = Utc::now();
        let far = now + chrono::Duration::hours(3);
        assert_eq!(
            AlarmDaemonCore::<TestEntry, RecordingEmitter>::sleep_for(Some(far), now),
            MAX_ARMED_SLEEP
        );
        let soon = now + chrono::Duration::milliseconds(500);
        let slept = AlarmDaemonCore::<TestEntry, RecordingEmitter>::sleep_for(Some(soon), now);
        assert!(
            slept >= Duration::from_millis(MIN_SLEEP_MS) && slept <= Duration::from_millis(500)
        );
        assert_eq!(
            AlarmDaemonCore::<TestEntry, RecordingEmitter>::sleep_for(None, now),
            IDLE_SLEEP
        );
    }
}
