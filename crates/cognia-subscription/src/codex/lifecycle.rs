use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, OwnedMutexGuard};

/// Process-local coordination for Codex credential rotations and device flows.
/// No method performs I/O; commands provide the network/vault operations while
/// this state guarantees ordering and cancellation.
#[derive(Default)]
pub struct CodexLifecycleManager {
    /// Keyed per (profile, account), so it grows with accounts the user has
    /// ever touched. Swept in `lock_account`.
    account_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Keyed per profile only, so it is bounded by the number of local
    /// profiles rather than by usage. Entries are deliberately NOT removed:
    /// the counter is what makes a superseded flow answer `false`, and
    /// restarting it at 1 could collide with a generation still being polled.
    flow_generations: Mutex<HashMap<String, u64>>,
}

impl CodexLifecycleManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn lock_account(
        &self,
        local_account_id: &str,
        account_id: &str,
    ) -> OwnedMutexGuard<()> {
        let key = format!("{local_account_id}/{account_id}");
        let lock = {
            let mut locks = self.account_locks.lock().await;
            // Reap entries nobody is holding or waiting on before adding one.
            // The map is keyed per (profile, account) and this state is
            // process-global, so without a sweep a deleted account's
            // `Arc<Mutex<()>>` is retained for the life of the app. An entry
            // whose only strong reference is the map itself has no guard out
            // and no waiter, which makes dropping it indistinguishable from
            // never having created it.
            locks.retain(|entry_key, entry| entry_key == &key || Arc::strong_count(entry) > 1);
            locks
                .entry(key)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    pub async fn begin_device_flow(&self, local_account_id: &str) -> u64 {
        let mut generations = self.flow_generations.lock().await;
        let next = generations
            .get(local_account_id)
            .copied()
            .unwrap_or_default()
            .saturating_add(1);
        generations.insert(local_account_id.to_string(), next);
        next
    }

    pub async fn cancel_device_flow(&self, local_account_id: &str, generation: u64) -> bool {
        let mut generations = self.flow_generations.lock().await;
        if generations.get(local_account_id).copied() != Some(generation) {
            return false;
        }
        generations.insert(local_account_id.to_string(), generation.saturating_add(1));
        true
    }

    pub async fn is_current_device_flow(&self, local_account_id: &str, generation: u64) -> bool {
        self.flow_generations
            .lock()
            .await
            .get(local_account_id)
            .copied()
            == Some(generation)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[tokio::test]
    async fn account_lock_serializes_same_account_but_not_different_accounts() {
        let manager = Arc::new(CodexLifecycleManager::new());
        let first = manager.lock_account("local", "account-a").await;
        let entered = Arc::new(AtomicUsize::new(0));

        let same_manager = manager.clone();
        let same_entered = entered.clone();
        let same = tokio::spawn(async move {
            let _guard = same_manager.lock_account("local", "account-a").await;
            same_entered.fetch_add(1, Ordering::SeqCst);
        });
        tokio::task::yield_now().await;
        assert_eq!(entered.load(Ordering::SeqCst), 0);

        let other_manager = manager.clone();
        let other = tokio::spawn(async move {
            let _guard = other_manager.lock_account("local", "account-b").await;
        });
        other.await.unwrap();

        drop(first);
        same.await.unwrap();
        assert_eq!(entered.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn idle_account_locks_are_reaped() {
        // The map is process-global state keyed per (profile, account), so an
        // entry nobody holds must not outlive the work that created it.
        let manager = CodexLifecycleManager::new();
        drop(manager.lock_account("local", "account-a").await);
        drop(manager.lock_account("local", "account-b").await);
        let keys: Vec<String> = manager.account_locks.lock().await.keys().cloned().collect();
        assert_eq!(keys, vec!["local/account-b".to_string()]);
    }

    #[tokio::test]
    async fn a_held_account_lock_is_never_reaped() {
        let manager = Arc::new(CodexLifecycleManager::new());
        let held = manager.lock_account("local", "account-a").await;
        drop(manager.lock_account("local", "account-b").await);
        assert!(manager
            .account_locks
            .lock()
            .await
            .contains_key("local/account-a"));
        drop(held);
    }

    #[tokio::test]
    async fn cancelled_or_superseded_device_flow_is_not_current() {
        let manager = CodexLifecycleManager::new();
        let first = manager.begin_device_flow("local").await;
        assert!(manager.is_current_device_flow("local", first).await);
        assert!(manager.cancel_device_flow("local", first).await);
        assert!(!manager.is_current_device_flow("local", first).await);

        let second = manager.begin_device_flow("local").await;
        let third = manager.begin_device_flow("local").await;
        assert!(!manager.is_current_device_flow("local", second).await);
        assert!(manager.is_current_device_flow("local", third).await);
    }
}
