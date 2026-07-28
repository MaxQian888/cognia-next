//! Process-wide passive desktop input observation.
//!
//! A single native hook fans coarse events out to independent bounded
//! subscribers. Selection-toolbar observation and skill recording therefore
//! never install competing CGEventTap / WH_* hooks.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::mpsc::{self, Receiver, Sender};

#[cfg(target_os = "macos")]
mod hook_mac;
#[cfg(target_os = "macos")]
use hook_mac::HookGuard;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod hook_stub;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
use hook_stub::HookGuard;
#[cfg(target_os = "windows")]
mod hook_win;
#[cfg(target_os = "windows")]
use hook_win::HookGuard;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputEvent {
    MouseDown {
        x: i32,
        y: i32,
        button: InputButton,
        ts_ms: i64,
    },
    MouseUp {
        x: i32,
        y: i32,
        button: InputButton,
        ts_ms: i64,
    },
    Scroll {
        x: i32,
        y: i32,
        dy: i32,
        ts_ms: i64,
    },
    KeyDown {
        vk: u32,
        ts_ms: i64,
    },
}

#[derive(Default)]
struct SubscriberHub {
    subscribers: Mutex<HashMap<u64, Sender<InputEvent>>>,
    next_id: AtomicU64,
}

impl SubscriberHub {
    fn subscribe(self: &Arc<Self>, capacity: usize) -> InputSubscription {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(capacity);
        self.subscribers.lock().insert(id, tx);
        InputSubscription {
            id,
            receiver: Some(rx),
            hub: Arc::downgrade(self),
        }
    }

    fn publish(&self, event: InputEvent) {
        self.subscribers
            .lock()
            .retain(|_, sender| match sender.try_send(event) {
                Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => true,
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            });
    }

    fn remove(&self, id: u64) {
        self.subscribers.lock().remove(&id);
    }
}

pub struct InputSubscription {
    id: u64,
    receiver: Option<Receiver<InputEvent>>,
    hub: Weak<SubscriberHub>,
}

impl InputSubscription {
    pub fn take_receiver(&mut self) -> Receiver<InputEvent> {
        self.receiver
            .take()
            .expect("input subscription receiver already taken")
    }
}

impl Drop for InputSubscription {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.remove(self.id);
        }
    }
}

struct ActiveMonitor {
    _hook: HookGuard,
    drain: tokio::task::JoinHandle<()>,
}

#[derive(Clone, Default)]
pub struct InputMonitor {
    hub: Arc<SubscriberHub>,
    active: Arc<Mutex<Option<ActiveMonitor>>>,
}

impl InputMonitor {
    pub fn subscribe(&self, capacity: usize) -> Result<InputSubscription, String> {
        let mut active = self.active.lock();
        if active.is_none() {
            let (tx, mut rx) = mpsc::channel::<InputEvent>(256);
            let hook = HookGuard::install(tx)?;
            let hub = self.hub.clone();
            let drain = tokio::spawn(async move {
                while let Some(event) = rx.recv().await {
                    hub.publish(event);
                }
            });
            *active = Some(ActiveMonitor { _hook: hook, drain });
        }
        Ok(self.hub.subscribe(capacity.max(1)))
    }

    pub fn stop_if_idle(&self) {
        let mut active_slot = self.active.lock();
        if !self.hub.subscribers.lock().is_empty() {
            return;
        }
        if let Some(active) = active_slot.take() {
            active.drain.abort();
            drop(active);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hub_fans_out_and_drop_unsubscribes() {
        let hub = Arc::new(SubscriberHub::default());
        let mut first = hub.subscribe(2);
        let mut second = hub.subscribe(2);
        let mut first_rx = first.take_receiver();
        let mut second_rx = second.take_receiver();
        let event = InputEvent::MouseUp {
            x: 4,
            y: 7,
            button: InputButton::Left,
            ts_ms: 11,
        };

        hub.publish(event);
        assert_eq!(first_rx.recv().await, Some(event));
        assert_eq!(second_rx.recv().await, Some(event));

        let first_id = first.id;
        drop(first);
        hub.publish(event);
        assert_eq!(second_rx.recv().await, Some(event));
        assert!(hub.subscribers.lock().get(&first_id).is_none());
    }

    #[tokio::test]
    async fn full_subscriber_does_not_block_other_subscribers() {
        let hub = Arc::new(SubscriberHub::default());
        let mut slow = hub.subscribe(1);
        let mut fast = hub.subscribe(2);
        let _slow_rx = slow.take_receiver();
        let mut fast_rx = fast.take_receiver();
        let first = InputEvent::KeyDown { vk: 1, ts_ms: 1 };
        let second = InputEvent::KeyDown { vk: 2, ts_ms: 2 };

        hub.publish(first);
        hub.publish(second);

        assert_eq!(fast_rx.recv().await, Some(first));
        assert_eq!(fast_rx.recv().await, Some(second));
    }
}
