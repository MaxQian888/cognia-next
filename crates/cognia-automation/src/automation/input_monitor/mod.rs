//! Process-wide passive desktop input observation.
//!
//! A single native hook fans coarse events out to independent bounded
//! subscribers. Selection-toolbar observation and skill recording therefore
//! never install competing CGEventTap / WH_* hooks.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::mpsc::{self, Receiver, Sender, UnboundedReceiver, UnboundedSender};

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
    MouseMoved {
        x: i32,
        y: i32,
        ts_ms: i64,
    },
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
        /// Layout-decoded character, resolved inside the hook while the OS
        /// keyboard state still matches the press.
        ///
        /// A virtual-key code alone is layout-blind: `vk` says the same thing
        /// for a US `;` and a German `ö`. The recorder needs the actual
        /// character to transcribe typed text, and only the hook can produce it
        /// — by the time a consumer sees the event, dead-key and modifier state
        /// have moved on. `None` means the decode was unavailable, which
        /// downstream reads as "describe this key structurally", never as a
        /// guess.
        text: Option<char>,
        ts_ms: i64,
    },
}

#[derive(Default)]
struct SubscriberHub {
    subscribers: Mutex<HashMap<u64, Sender<InputEvent>>>,
    safety_subscribers: Mutex<HashMap<u64, UnboundedSender<InputEvent>>>,
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

    fn subscribe_safety(self: &Arc<Self>) -> SafetyInputSubscription {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        self.safety_subscribers.lock().insert(id, tx);
        SafetyInputSubscription {
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
        self.safety_subscribers
            .lock()
            .retain(|_, sender| sender.send(event).is_ok());
    }

    fn remove(&self, id: u64) {
        self.subscribers.lock().remove(&id);
        self.safety_subscribers.lock().remove(&id);
    }
}

pub struct SafetyInputSubscription {
    id: u64,
    receiver: Option<UnboundedReceiver<InputEvent>>,
    hub: Weak<SubscriberHub>,
}

impl SafetyInputSubscription {
    pub fn take_receiver(&mut self) -> UnboundedReceiver<InputEvent> {
        self.receiver
            .take()
            .expect("safety input subscription receiver already taken")
    }
}

impl Drop for SafetyInputSubscription {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.remove(self.id);
        }
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
    fn ensure_active(&self) -> Result<(), String> {
        let mut active = self.active.lock();
        if active.is_none() {
            let (tx, mut rx) = mpsc::unbounded_channel::<InputEvent>();
            let hook = HookGuard::install(tx)?;
            let hub = self.hub.clone();
            let drain = tokio::spawn(async move {
                while let Some(event) = rx.recv().await {
                    hub.publish(event);
                }
            });
            *active = Some(ActiveMonitor { _hook: hook, drain });
        }
        Ok(())
    }

    pub fn subscribe(&self, capacity: usize) -> Result<InputSubscription, String> {
        self.ensure_active()?;
        Ok(self.hub.subscribe(capacity.max(1)))
    }

    pub fn subscribe_safety(&self) -> Result<SafetyInputSubscription, String> {
        self.ensure_active()?;
        Ok(self.hub.subscribe_safety())
    }

    pub fn stop_if_idle(&self) {
        let mut active_slot = self.active.lock();
        if !self.hub.subscribers.lock().is_empty() || !self.hub.safety_subscribers.lock().is_empty()
        {
            return;
        }
        if let Some(active) = active_slot.take() {
            active.drain.abort();
            drop(active);
        }
    }

    #[cfg(test)]
    pub(crate) fn inject_for_test(&self, event: InputEvent) {
        self.hub.publish(event);
    }

    #[cfg(test)]
    pub(crate) fn subscribe_safety_for_test(&self) -> SafetyInputSubscription {
        self.hub.subscribe_safety()
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
        let first = InputEvent::KeyDown {
            vk: 1,
            text: None,
            ts_ms: 1,
        };
        let second = InputEvent::KeyDown {
            vk: 2,
            text: None,
            ts_ms: 2,
        };

        hub.publish(first);
        hub.publish(second);

        assert_eq!(fast_rx.recv().await, Some(first));
        assert_eq!(fast_rx.recv().await, Some(second));
    }

    #[tokio::test]
    async fn safety_subscriber_never_drops_bursty_input() {
        let hub = Arc::new(SubscriberHub::default());
        let mut safety = hub.subscribe_safety();
        let mut rx = safety.take_receiver();
        for vk in 0..1_000 {
            hub.publish(InputEvent::KeyDown {
                vk,
                text: None,
                ts_ms: 1,
            });
        }
        for vk in 0..1_000 {
            assert_eq!(
                rx.recv().await,
                Some(InputEvent::KeyDown {
                    vk,
                    text: None,
                    ts_ms: 1
                })
            );
        }
    }
}
