//! Process-wide fan-out of desktop text-selection signals.
//!
//! Structurally a sibling of [`super::input_monitor`]'s subscriber hub, and for
//! the same reason: several independent consumers (today the selection toolbar,
//! tomorrow a workflow trigger) must be able to watch selection activity
//! without any of them installing a competing native observer.
//!
//! # This bus carries metadata, never text
//!
//! The platform callbacks that feed it fire on *every keystroke in every text
//! field on the desktop*. Putting selected text on that path would mean the
//! user's typing streamed continuously through a process-wide broadcast channel
//! with several subscribers — a privacy surface with no upside, since a
//! consumer that decides it actually wants the text still has to go and read it
//! at a moment of its own choosing.
//!
//! So a [`SelectionSignal`] says only *that* a selection changed, in which
//! process, and roughly how big it is. The body is read exactly once, later, by
//! whoever decided the signal was worth acting on — through the single gated
//! `read_text_selection` round-trip that already exists. That keeps every
//! character of user text on one auditable path.
//!
//! It is deliberately not [`super::events`]: that module is a single-sink
//! forwarder to the Tauri event bus, whereas this needs fan-out to in-process
//! Rust consumers and must never apply back-pressure to a native callback.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tokio::sync::mpsc::{self, Receiver, Sender};

/// Why a signal was published.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionSignalKind {
    /// The selected-text range changed within the focused element.
    SelectionChanged,
    /// The focused UI element changed, which implicitly abandons any selection
    /// the previous element held.
    FocusChanged,
}

/// One observation from a native accessibility observer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectionSignal {
    pub kind: SelectionSignalKind,
    /// Process that owns the element, when the platform can report it cheaply.
    pub pid: Option<u32>,
    /// Length of the selected range in characters.
    ///
    /// `0` means the selection emptied — a consumer should treat that as "the
    /// user cleared it", not "nothing happened". `-1` means *unknown*: the
    /// Windows UIA callback has no cheap length, so consumers that care about
    /// size must re-check after they read the text.
    pub selected_len: i64,
    pub at_ms: i64,
}

impl SelectionSignal {
    /// Whether this signal reports a selection that has gone away.
    pub fn is_empty_selection(&self) -> bool {
        self.selected_len == 0
    }

    /// Whether the platform could not report a length.
    pub fn has_unknown_length(&self) -> bool {
        self.selected_len < 0
    }
}

#[derive(Default)]
struct SelectionEventHub {
    subscribers: Mutex<HashMap<u64, Sender<SelectionSignal>>>,
    next_id: AtomicU64,
}

impl SelectionEventHub {
    fn subscribe(self: &Arc<Self>, capacity: usize) -> SelectionSubscription {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(capacity);
        self.subscribers.lock().insert(id, tx);
        SelectionSubscription {
            id,
            receiver: Some(rx),
            hub: Arc::downgrade(self),
        }
    }

    /// Drop-on-full, never block. The publisher is a native callback running on
    /// an accessibility run loop; making it wait on a slow subscriber would
    /// stall the observer for every application on the desktop.
    fn publish(&self, signal: SelectionSignal) {
        self.subscribers
            .lock()
            .retain(|_, sender| match sender.try_send(signal) {
                Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => true,
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            });
    }

    fn remove(&self, id: u64) {
        self.subscribers.lock().remove(&id);
    }
}

static HUB: Lazy<Arc<SelectionEventHub>> = Lazy::new(Arc::default);

/// Publish a signal to every live subscriber.
///
/// A process-wide static rather than state threaded through `AppHandle`,
/// because the callers are a CFRunLoop callback and a COM event handler —
/// neither has a Tauri handle to reach for. Same shape as [`super::events`].
pub fn publish(signal: SelectionSignal) {
    HUB.publish(signal);
}

/// Watch desktop selection activity until the returned handle is dropped.
pub fn subscribe(capacity: usize) -> SelectionSubscription {
    HUB.subscribe(capacity.max(1))
}

/// How many subscribers are currently listening. Lets a native observer decide
/// whether it is worth staying installed.
pub fn subscriber_count() -> usize {
    HUB.subscribers.lock().len()
}

pub struct SelectionSubscription {
    id: u64,
    receiver: Option<Receiver<SelectionSignal>>,
    hub: Weak<SelectionEventHub>,
}

impl SelectionSubscription {
    pub fn take_receiver(&mut self) -> Receiver<SelectionSignal> {
        self.receiver
            .take()
            .expect("selection subscription receiver already taken")
    }
}

impl Drop for SelectionSubscription {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.remove(self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(len: i64) -> SelectionSignal {
        SelectionSignal {
            kind: SelectionSignalKind::SelectionChanged,
            pid: Some(42),
            selected_len: len,
            at_ms: 7,
        }
    }

    #[tokio::test]
    async fn hub_fans_out_and_drop_unsubscribes() {
        let hub = Arc::new(SelectionEventHub::default());
        let mut first = hub.subscribe(2);
        let mut second = hub.subscribe(2);
        let mut first_rx = first.take_receiver();
        let mut second_rx = second.take_receiver();

        hub.publish(signal(5));
        assert_eq!(first_rx.recv().await, Some(signal(5)));
        assert_eq!(second_rx.recv().await, Some(signal(5)));

        let first_id = first.id;
        drop(first);
        hub.publish(signal(5));
        assert_eq!(second_rx.recv().await, Some(signal(5)));
        assert!(hub.subscribers.lock().get(&first_id).is_none());
    }

    #[tokio::test]
    async fn full_subscriber_does_not_block_other_subscribers() {
        // A native observer callback must never be held up by a consumer that
        // stopped draining; the slow one loses signals instead.
        let hub = Arc::new(SelectionEventHub::default());
        let mut slow = hub.subscribe(1);
        let mut fast = hub.subscribe(2);
        let _slow_rx = slow.take_receiver();
        let mut fast_rx = fast.take_receiver();

        hub.publish(signal(1));
        hub.publish(signal(2));

        assert_eq!(fast_rx.recv().await, Some(signal(1)));
        assert_eq!(fast_rx.recv().await, Some(signal(2)));
    }

    #[test]
    fn empty_and_unknown_lengths_are_distinguishable() {
        // `0` is "the user cleared the selection"; `-1` is "this platform
        // cannot tell us". Collapsing them would make Windows dismiss the
        // toolbar on every signal.
        assert!(signal(0).is_empty_selection());
        assert!(!signal(0).has_unknown_length());
        assert!(!signal(-1).is_empty_selection());
        assert!(signal(-1).has_unknown_length());
        assert!(!signal(12).is_empty_selection());
        assert!(!signal(12).has_unknown_length());
    }
}
