//! Generation-aware cancellation for request ids reused across async calls.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tokio::sync::oneshot;

struct Entry {
    generation: u64,
    sender: oneshot::Sender<()>,
}

/// A request-id registry that prevents an older request's cleanup from
/// unregistering a newer request that reused the same id.
#[derive(Default)]
pub struct RequestCancellationRegistry {
    next_generation: AtomicU64,
    entries: Mutex<HashMap<String, Entry>>,
}

impl RequestCancellationRegistry {
    /// Register `request_id`, cancelling any previous owner of that id.
    pub fn register(&self, request_id: &str) -> (u64, oneshot::Receiver<()>) {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        let previous = self.entries.lock().ok().and_then(|mut entries| {
            entries
                .insert(request_id.to_string(), Entry { generation, sender })
                .map(|entry| entry.sender)
        });
        if let Some(previous) = previous {
            let _ = previous.send(());
        }
        (generation, receiver)
    }

    /// Cancel the current owner of `request_id`.
    pub fn cancel(&self, request_id: &str) -> bool {
        self.entries
            .lock()
            .ok()
            .and_then(|mut entries| entries.remove(request_id))
            .is_some_and(|entry| entry.sender.send(()).is_ok())
    }

    /// Remove a completed registration only if it is still the current owner.
    pub fn finish(&self, request_id: &str, generation: u64) {
        if let Ok(mut entries) = self.entries.lock() {
            if entries
                .get(request_id)
                .is_some_and(|entry| entry.generation == generation)
            {
                entries.remove(request_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stale_cleanup_does_not_unregister_replacement() {
        let registry = RequestCancellationRegistry::default();
        let (first_generation, first_receiver) = registry.register("same-id");
        let (_second_generation, second_receiver) = registry.register("same-id");

        assert!(first_receiver.await.is_ok());
        registry.finish("same-id", first_generation);

        assert!(registry.cancel("same-id"));
        assert!(second_receiver.await.is_ok());
    }
}
