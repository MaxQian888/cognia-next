//! Local IPC replay admission, separate from consent or session grants.
//!
//! Tauri can resend a custom-protocol request over postMessage after a lost
//! response, including during navigation. Both deliveries retain the header.
//! Never evict an active call; retain completed identities for a day and fail
//! closed at capacity rather than admit a possible duplicate side effect.

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use uuid::Uuid;

use super::types::{AutomationError, Result};

pub const INVOCATION_HEADER: &str = "x-cognia-automation-invocation";

#[derive(Default)]
struct Entries {
    ids: HashSet<Uuid>,
    completed: VecDeque<(Uuid, Instant)>,
}

pub struct InvocationHistory {
    entries: Mutex<Entries>,
    capacity: usize,
    retention: Duration,
}

impl Default for InvocationHistory {
    fn default() -> Self {
        Self {
            entries: Mutex::new(Entries::default()),
            capacity: 65_536,
            retention: Duration::from_secs(24 * 60 * 60),
        }
    }
}

impl InvocationHistory {
    /// Missing metadata preserves older callers' existing permission checks.
    /// This identity can only refuse a replay; it never authorizes execution.
    pub fn reserve(&self, id: Option<&str>) -> Result<Option<InvocationLease<'_>>> {
        self.reserve_at(id, Instant::now())
    }

    fn reserve_at(&self, id: Option<&str>, now: Instant) -> Result<Option<InvocationLease<'_>>> {
        let Some(id) = id else { return Ok(None) };
        let id = Uuid::parse_str(id).map_err(|_| AutomationError::PermissionDenied {
            reason: "invalid automation invocation identity".into(),
        })?;
        let mut entries = self.entries.lock();
        while let Some((expired, finished)) = entries.completed.front().copied() {
            if now.saturating_duration_since(finished) < self.retention {
                break;
            }
            entries.completed.pop_front();
            entries.ids.remove(&expired);
        }
        if entries.ids.contains(&id) {
            return Err(AutomationError::PermissionDenied {
                reason: "duplicate automation invocation; inspect the original outcome".into(),
            });
        }
        if entries.ids.len() >= self.capacity {
            return Err(AutomationError::PermissionDenied {
                reason: "automation invocation history is full; restart before issuing new actions"
                    .into(),
            });
        }
        entries.ids.insert(id);
        Ok(Some(InvocationLease { history: self, id }))
    }
}

/// Owns no mutex guard across the command's await points.
pub struct InvocationLease<'a> {
    history: &'a InvocationHistory,
    id: Uuid,
}

impl Drop for InvocationLease<'_> {
    fn drop(&mut self) {
        let mut entries = self.history.entries.lock();
        entries.completed.push_back((self.id, Instant::now()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_is_refused_while_pending_and_after_completion() {
        let history = InvocationHistory::default();
        let id = Uuid::new_v4().to_string();
        let lease = history.reserve(Some(&id)).unwrap();
        assert!(matches!(
            history.reserve(Some(&id)),
            Err(AutomationError::PermissionDenied { .. })
        ));
        drop(lease);
        assert!(history.reserve(Some(&id)).is_err());
        // Identical actions with independent invocation ids remain distinct.
        assert!(history.reserve(Some(&Uuid::new_v4().to_string())).is_ok());
    }

    #[test]
    fn capacity_never_evicts_pending_or_recently_completed_calls() {
        let history = InvocationHistory {
            capacity: 1,
            retention: Duration::from_secs(1),
            ..Default::default()
        };
        let id = Uuid::new_v4().to_string();
        let lease = history.reserve(Some(&id)).unwrap();
        let later = Instant::now() + Duration::from_secs(2);
        assert!(history
            .reserve_at(Some(&Uuid::new_v4().to_string()), later)
            .is_err());
        drop(lease);
        assert!(history.reserve(Some(&Uuid::new_v4().to_string())).is_err());
        assert!(history
            .reserve_at(Some(&Uuid::new_v4().to_string()), later)
            .is_ok());
    }

    #[test]
    fn missing_identity_is_compatible_and_malformed_identity_is_refused() {
        let history = InvocationHistory::default();
        assert!(history.reserve(None).unwrap().is_none());
        assert!(history.reserve(Some("not-a-uuid")).is_err());
        assert!(history.entries.lock().ids.is_empty());
    }

    #[test]
    fn completion_order_does_not_expire_an_earlier_active_call() {
        let history = InvocationHistory {
            capacity: 2,
            retention: Duration::from_secs(1),
            ..Default::default()
        };
        let first = Uuid::new_v4().to_string();
        let active = history.reserve(Some(&first)).unwrap();
        drop(history.reserve(Some(&Uuid::new_v4().to_string())).unwrap());
        let later = Instant::now() + Duration::from_secs(2);
        assert!(history.reserve_at(Some(&first), later).is_err());
        assert!(history
            .reserve_at(Some(&Uuid::new_v4().to_string()), later)
            .is_ok());
        drop(active);
    }

    #[test]
    fn concurrent_delivery_reserves_only_once() {
        let history = InvocationHistory::default();
        let id = Uuid::new_v4().to_string();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| history.reserve(Some(&id)));
            let second = scope.spawn(|| history.reserve(Some(&id)));
            let first = first.join().unwrap();
            let second = second.join().unwrap();
            assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        });
    }
}
