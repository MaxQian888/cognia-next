//! Replay buffer for terminal sessions — Wave 2 mobile/WAN resilience.
//!
//! Every event the reader and waiter threads emit lands here BEFORE the
//! event sink fans out. The buffer assigns a monotonic `seq` per
//! session and retains the most-recent events for up to `ttl` wall-clock
//! time, capped at `capacity_bytes`. When a remote consumer reconnects
//! with `?sessionId=<id>&resumeFrom=<seq>`, the WS handler drains
//! `since(resume_from)` to replay every event the client missed.
//!
//! Concurrency: a single `Mutex<VecDeque<TimedEvent>>` guards the ring
//! plus a small running byte-cost counter; the contention is fine
//! because every push is followed by a fan-out that's orders of
//! magnitude more expensive than the lock acquisition.
//!
//! GC strategy: the only place GC runs is inside `push` (TTL + capacity).
//! `since` is read-only — no GC there — so a long-disconnected client
//! still sees the full window when it returns.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::session::TerminalEvent;

/// Per-event metadata + payload as stored in the ring.
#[derive(Debug)]
struct TimedEvent {
    seq: u64,
    at: Instant,
    event: TerminalEvent,
}

/// Approximate byte footprint of an event. Used for the capacity cap —
/// the goal is "rough back-pressure", not an exact accounting.
fn event_size(event: &TerminalEvent) -> usize {
    match event {
        TerminalEvent::Data { bytes } => bytes.len(),
        // OSC 633 events + Exit are tiny structurally — bill at 64 B.
        TerminalEvent::Integration { .. } | TerminalEvent::Exit { .. } => 64,
    }
}

/// Default capacity: 512 KiB. Tuned so a chatty session
/// (`cat /var/log/...`) still keeps ~5 s of recent output without
/// dwarfing the renderer's xterm scrollback.
pub const DEFAULT_CAPACITY_BYTES: usize = 512 * 1024;

/// Default TTL: 5 minutes — matches the renderer-side reconnect budget
/// in `lib/terminal/transport-ws.ts`.
pub const DEFAULT_TTL: Duration = Duration::from_secs(5 * 60);

pub struct ReplayBuffer {
    next_seq: AtomicU64,
    capacity_bytes: usize,
    ttl: Duration,
    inner: Mutex<Ring>,
}

struct Ring {
    events: VecDeque<TimedEvent>,
    total_bytes: usize,
}

impl ReplayBuffer {
    /// Build a buffer with the default capacity (512 KiB) and TTL (5 min).
    pub fn new() -> Self {
        Self::with_limits(DEFAULT_CAPACITY_BYTES, DEFAULT_TTL)
    }

    pub fn with_limits(capacity_bytes: usize, ttl: Duration) -> Self {
        Self {
            next_seq: AtomicU64::new(1),
            capacity_bytes,
            ttl,
            inner: Mutex::new(Ring {
                events: VecDeque::new(),
                total_bytes: 0,
            }),
        }
    }

    /// Assign the next sequence number, run GC, then push the event.
    /// Returns the assigned seq so the caller can include it in the wire
    /// envelope.
    pub fn push(&self, event: TerminalEvent) -> u64 {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let size = event_size(&event);
        let now = Instant::now();
        let mut ring = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // TTL GC — drop events whose `at + ttl < now`.
        while let Some(front) = ring.events.front() {
            if now.duration_since(front.at) > self.ttl {
                let dropped_size = event_size(&front.event);
                ring.events.pop_front();
                ring.total_bytes = ring.total_bytes.saturating_sub(dropped_size);
            } else {
                break;
            }
        }
        // Capacity GC — keep popping the oldest until we'd fit.
        while ring.total_bytes + size > self.capacity_bytes && !ring.events.is_empty() {
            if let Some(dropped) = ring.events.pop_front() {
                let dropped_size = event_size(&dropped.event);
                ring.total_bytes = ring.total_bytes.saturating_sub(dropped_size);
            }
        }
        ring.events.push_back(TimedEvent {
            seq,
            at: now,
            event,
        });
        ring.total_bytes += size;
        // Diagnostic: log when the buffer grows large (>>75% capacity).
        let retained = ring.total_bytes;
        let count = ring.events.len();
        drop(ring);
        // Divide before multiplying so the 75%-of-capacity threshold can't
        // overflow when `capacity_bytes` is near `usize::MAX` (the buffer is
        // intentionally constructed with `usize::MAX` when only TTL-based GC
        // is wanted). `capacity / 4 * 3` stays within `usize` because the
        // result is always <= `capacity`. The sub-`usize`-precision rounding
        // is irrelevant for a diagnostic log threshold.
        let warn_threshold = self.capacity_bytes / 4 * 3;
        if retained > warn_threshold {
            log::debug!(
                "replay buffer at {}/{} bytes ({} events), seq={}",
                retained,
                self.capacity_bytes,
                count,
                seq
            );
        }
        seq
    }

    /// Replay every event with `seq > after_seq`. Used when a remote
    /// client reconnects with `?resumeFrom=<seq>`. Returns events in
    /// seq order, paired with their assigned seq numbers.
    pub fn since(&self, after_seq: u64) -> Vec<(u64, TerminalEvent)> {
        let ring = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        ring.events
            .iter()
            .filter(|e| e.seq > after_seq)
            .map(|e| (e.seq, e.event.clone()))
            .collect()
    }

    /// Most-recently-assigned seq. `0` when no events have been pushed
    /// yet. Used by WS resume to validate `resume_from` bounds.
    pub fn last_seq(&self) -> u64 {
        self.next_seq.load(Ordering::Relaxed).saturating_sub(1)
    }

    /// Inspect retained event count — diagnostics + tests.
    pub fn len(&self) -> usize {
        match self.inner.lock() {
            Ok(g) => g.events.len(),
            Err(p) => p.into_inner().events.len(),
        }
    }

    /// True when no events are retained.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Total retained bytes (approximate). Used by push() diagnostic log
    /// and tests.
    pub fn retained_bytes(&self) -> usize {
        match self.inner.lock() {
            Ok(g) => g.total_bytes,
            Err(p) => p.into_inner().total_bytes,
        }
    }
}

impl Default for ReplayBuffer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::osc633::IntegrationEvent;

    fn data(n: usize) -> TerminalEvent {
        TerminalEvent::Data {
            bytes: vec![0u8; n],
        }
    }

    fn integration() -> TerminalEvent {
        TerminalEvent::Integration {
            event: IntegrationEvent::PromptStart,
        }
    }

    #[test]
    fn push_assigns_monotonic_seq_starting_at_1() {
        let buf = ReplayBuffer::new();
        let a = buf.push(integration());
        let b = buf.push(integration());
        let c = buf.push(integration());
        assert_eq!((a, b, c), (1, 2, 3));
        assert_eq!(buf.last_seq(), 3);
    }

    #[test]
    fn since_returns_events_strictly_after_resume_from() {
        let buf = ReplayBuffer::new();
        buf.push(integration());
        buf.push(integration());
        buf.push(integration());
        let after = buf.since(1);
        assert_eq!(
            after.iter().map(|(s, _)| *s).collect::<Vec<_>>(),
            vec![2, 3]
        );
        let none = buf.since(99);
        assert!(none.is_empty());
        let all = buf.since(0);
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn capacity_cap_drops_oldest_events_first() {
        let buf = ReplayBuffer::with_limits(2048, Duration::from_secs(60));
        // Push 4 × 1 KiB Data events — cap is 2 KiB, so only the last
        // two survive after the fourth push.
        for _ in 0..4 {
            buf.push(data(1024));
        }
        assert!(buf.retained_bytes() <= 2048);
        // The earliest surviving seq should be 3 (1 and 2 were evicted).
        let surviving: Vec<u64> = buf.since(0).into_iter().map(|(s, _)| s).collect();
        assert_eq!(surviving, vec![3, 4]);
    }

    #[test]
    fn ttl_drops_old_events_on_next_push() {
        let buf = ReplayBuffer::with_limits(usize::MAX, Duration::from_millis(50));
        buf.push(integration()); // seq 1
        std::thread::sleep(Duration::from_millis(80));
        buf.push(integration()); // seq 2 — triggers GC, drops seq 1
        let remaining: Vec<u64> = buf.since(0).into_iter().map(|(s, _)| s).collect();
        assert_eq!(remaining, vec![2]);
    }

    #[test]
    fn empty_buffer_reports_zero_state() {
        let buf = ReplayBuffer::new();
        assert!(buf.is_empty());
        assert_eq!(buf.len(), 0);
        assert_eq!(buf.last_seq(), 0);
        assert_eq!(buf.retained_bytes(), 0);
        assert!(buf.since(0).is_empty());
    }

    #[test]
    fn since_includes_the_full_buffer_when_resume_from_is_zero() {
        let buf = ReplayBuffer::new();
        for _ in 0..5 {
            buf.push(integration());
        }
        let all = buf.since(0);
        assert_eq!(all.len(), 5);
        assert_eq!(all.first().map(|(s, _)| *s), Some(1));
        assert_eq!(all.last().map(|(s, _)| *s), Some(5));
    }

    #[test]
    fn integration_events_have_a_small_constant_footprint() {
        let buf = ReplayBuffer::new();
        buf.push(integration());
        assert!(buf.retained_bytes() < 256); // 64 B per integration event
    }

    #[test]
    fn data_events_account_their_byte_payload() {
        let buf = ReplayBuffer::new();
        buf.push(data(4096));
        assert_eq!(buf.retained_bytes(), 4096);
    }
}
