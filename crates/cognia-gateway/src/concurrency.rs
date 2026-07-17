//! In-flight concurrency caps (W1.2).
//!
//! The gateway's only pre-existing throttle is a fixed per-minute window, which
//! does nothing to stop a client firing many *simultaneous* requests at a
//! single upstream account — the fastest way to trip provider risk-control.
//! This adds a semaphore-backed in-flight cap, per gateway API key and
//! (optionally) per upstream pool key. Borrowed from sub2api's concurrency
//! slots, collapsed to a single process (`tokio::Semaphore`, no Redis).
//!
//! When the cap is reached a caller waits up to a bounded timeout for a slot
//! before being rejected (sub2api's `AccountWaitPlan`); the queue depth itself
//! is bounded so a burst can't grow waiters without limit.
//!
//! A held [`Slot`] releases its permit on `Drop`. For streaming responses the
//! slot is MOVED into the SSE pump task, so the permit is held for the whole
//! stream and released only at stream end — never dropped early at the axum
//! handler's return (which is why the permit is owned, not a borrow guard held
//! across an `.await`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Hard cap on queued waiters per key, so a burst of blocked requests can't
/// grow memory without bound. Beyond this, callers are rejected immediately.
const MAX_WAITERS_PER_KEY: usize = 256;

struct KeyGate {
    sem: Arc<Semaphore>,
    /// The permit count the gate was created with — lets a config change to
    /// the cap rebuild the gate lazily on next use.
    cap: u32,
    waiting: Arc<AtomicUsize>,
}

/// A held concurrency slot. `Unlimited` when the relevant cap is 0 (disabled);
/// otherwise it owns a semaphore permit that releases on drop.
pub enum Slot {
    Unlimited,
    Held(#[allow(dead_code)] OwnedSemaphorePermit),
}

/// Per-key in-flight limiter shared on `GatewayState`.
#[derive(Default)]
pub struct ConcurrencyLimiter {
    gates: Mutex<HashMap<String, KeyGate>>,
}

impl ConcurrencyLimiter {
    /// Acquire a slot for `key` against `cap` concurrent holders. `cap == 0`
    /// disables the cap (always `Ok(Slot::Unlimited)`). When the cap is reached
    /// the caller waits up to `wait` for a slot; on timeout — or when the
    /// per-key queue is already saturated — it returns `Err(())` so the handler
    /// can reject with 429.
    pub async fn acquire(&self, key: &str, cap: u32, wait: Duration) -> Result<Slot, ()> {
        if cap == 0 {
            return Ok(Slot::Unlimited);
        }
        let (sem, waiting) = self.gate(key, cap);
        // Fast path: a free slot right now.
        if let Ok(permit) = sem.clone().try_acquire_owned() {
            return Ok(Slot::Held(permit));
        }
        // Bound the queue before parking a waiter.
        if waiting.load(Ordering::Relaxed) >= MAX_WAITERS_PER_KEY {
            return Err(());
        }
        waiting.fetch_add(1, Ordering::Relaxed);
        let res = tokio::time::timeout(wait, sem.acquire_owned()).await;
        waiting.fetch_sub(1, Ordering::Relaxed);
        match res {
            Ok(Ok(permit)) => Ok(Slot::Held(permit)),
            _ => Err(()), // timed out (or semaphore closed — never happens here)
        }
    }

    /// Fetch (or lazily build) the gate for `key`. Rebuilds when the configured
    /// cap changed since the gate was created; in-flight permits keep the old
    /// semaphore alive via their own `Arc`, so they finish safely.
    fn gate(&self, key: &str, cap: u32) -> (Arc<Semaphore>, Arc<AtomicUsize>) {
        let mut gates = self.gates.lock();
        if let Some(g) = gates.get(key) {
            if g.cap == cap {
                return (g.sem.clone(), g.waiting.clone());
            }
        }
        let g = KeyGate {
            sem: Arc::new(Semaphore::new(cap as usize)),
            cap,
            waiting: Arc::new(AtomicUsize::new(0)),
        };
        let out = (g.sem.clone(), g.waiting.clone());
        gates.insert(key.to_string(), g);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn zero_cap_is_unlimited() {
        let limiter = ConcurrencyLimiter::default();
        let slot = limiter.acquire("k", 0, Duration::from_millis(10)).await;
        assert!(matches!(slot, Ok(Slot::Unlimited)));
    }

    #[tokio::test]
    async fn cap_blocks_third_and_frees_on_drop() {
        let limiter = ConcurrencyLimiter::default();
        let wait = Duration::from_millis(20);
        let a = limiter.acquire("k", 2, wait).await.expect("first");
        let _b = limiter.acquire("k", 2, wait).await.expect("second");
        // Third with the cap full → rejected after the wait window.
        assert!(limiter.acquire("k", 2, wait).await.is_err());
        // Release one and a fresh acquire succeeds.
        drop(a);
        assert!(limiter.acquire("k", 2, wait).await.is_ok());
    }

    #[tokio::test]
    async fn waiter_is_served_when_a_slot_frees_mid_wait() {
        let limiter = Arc::new(ConcurrencyLimiter::default());
        let held = limiter
            .acquire("k", 1, Duration::from_millis(5))
            .await
            .unwrap();
        let l2 = limiter.clone();
        // A waiter with a generous window.
        let waiter =
            tokio::spawn(
                async move { l2.acquire("k", 1, Duration::from_millis(500)).await.is_ok() },
            );
        // Free the slot shortly after; the waiter should pick it up.
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(held);
        assert!(waiter.await.unwrap());
    }

    #[tokio::test]
    async fn separate_keys_do_not_contend() {
        let limiter = ConcurrencyLimiter::default();
        let wait = Duration::from_millis(10);
        let _a = limiter.acquire("key-a", 1, wait).await.expect("a");
        // A different key has its own gate.
        assert!(limiter.acquire("key-b", 1, wait).await.is_ok());
    }

    #[tokio::test]
    async fn cap_change_rebuilds_the_gate() {
        let limiter = ConcurrencyLimiter::default();
        let wait = Duration::from_millis(10);
        let _a = limiter.acquire("k", 1, wait).await.expect("a");
        // Cap was 1 and is full; raising the cap rebuilds the gate so a new
        // acquire under the new cap succeeds immediately.
        assert!(limiter.acquire("k", 2, wait).await.is_ok());
    }
}
