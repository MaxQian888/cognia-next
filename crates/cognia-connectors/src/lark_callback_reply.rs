//! Single-use replies shared by Lark's WebSocket and webhook transports.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::oneshot;
use tokio::time::Instant;
use uuid::Uuid;

/// Leave transport overhead inside Feishu's fixed three-second callback limit.
pub const REPLY_BUDGET: Duration = Duration::from_millis(2_500);
pub const CALLBACK_ID_FIELD: &str = "_cognia_callback_id";
const MAX_PENDING_REPLIES: usize = 1_024;

struct Entry {
    deadline: Instant,
    sender: oneshot::Sender<Value>,
}

fn pending() -> &'static Mutex<HashMap<String, Entry>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Owning the receiver also owns cleanup, including cancellation of a webhook
/// request or closure of a WebSocket while its callback is pending.
pub struct PendingReply {
    callback_id: String,
    deadline: Instant,
    receiver: oneshot::Receiver<Value>,
}

impl PendingReply {
    pub async fn receive(mut self) -> Value {
        tokio::time::timeout_at(self.deadline, &mut self.receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_else(|| serde_json::json!({}))
    }
}

impl Drop for PendingReply {
    fn drop(&mut self) {
        pending().lock().remove(&self.callback_id);
    }
}

fn make_room(entries: &mut HashMap<String, Entry>, now: Instant) {
    entries.retain(|_, entry| entry.deadline > now && !entry.sender.is_closed());
    if entries.len() >= MAX_PENDING_REPLIES {
        // Release the oldest waiter with its empty fallback instead of growing
        // memory without a bound when the renderer cannot keep up.
        if let Some(oldest) = entries
            .iter()
            .min_by_key(|(_, entry)| entry.deadline)
            .map(|(id, _)| id.clone())
        {
            entries.remove(&oldest);
        }
    }
}

pub fn register() -> (String, PendingReply) {
    let callback_id = Uuid::new_v4().to_string();
    let now = Instant::now();
    let deadline = now + REPLY_BUDGET;
    let (sender, receiver) = oneshot::channel();
    {
        let mut entries = pending().lock();
        make_room(&mut entries, now);
        entries.insert(callback_id.clone(), Entry { deadline, sender });
    }
    let reply = PendingReply {
        callback_id: callback_id.clone(),
        deadline,
        receiver,
    };
    (callback_id, reply)
}

/// False means the transport timed out, closed, or already received a reply.
pub fn respond(callback_id: &str, response: Value) -> bool {
    let entry = pending().lock().remove(callback_id);
    entry
        .is_some_and(|entry| entry.deadline > Instant::now() && entry.sender.send(response).is_ok())
}

pub fn is_card_callback(payload: &Value) -> bool {
    matches!(
        payload
            .pointer("/header/event_type")
            .and_then(Value::as_str),
        Some("card.action.trigger" | "im.interactive_message.action_triggered_v1")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lark_reply_is_delivered_once_and_removed() {
        let (id, receiver) = register();
        let response = serde_json::json!({"toast": {"type": "success", "content": "Approved"}});
        assert!(respond(&id, response.clone()));
        assert_eq!(receiver.receive().await, response);
        assert!(!respond(&id, serde_json::json!({})));
    }

    #[tokio::test]
    async fn lark_reply_timeout_returns_empty_object_and_removes_entry() {
        let (id, receiver) = register();
        assert_eq!(receiver.receive().await, serde_json::json!({}));
        assert!(!pending().lock().contains_key(&id));
        assert!(!respond(&id, serde_json::json!({})));
    }

    #[test]
    fn lark_unknown_and_cancelled_replies_return_false() {
        assert!(!respond("unknown-callback", serde_json::json!({})));
        let (id, receiver) = register();
        drop(receiver);
        assert!(!pending().lock().contains_key(&id));
        assert!(!respond(&id, serde_json::json!({})));
    }

    #[test]
    fn lark_registry_evicts_oldest_at_capacity() {
        let now = Instant::now();
        let mut entries = HashMap::new();
        let mut receivers = Vec::new();
        for index in 0..MAX_PENDING_REPLIES {
            let (sender, receiver) = oneshot::channel();
            receivers.push(receiver);
            entries.insert(
                index.to_string(),
                Entry {
                    deadline: now + REPLY_BUDGET + Duration::from_millis(index as u64),
                    sender,
                },
            );
        }
        make_room(&mut entries, now);
        assert_eq!(entries.len(), MAX_PENDING_REPLIES - 1);
        assert!(!entries.contains_key("0"));
        assert!(matches!(
            receivers[0].try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn lark_registry_prunes_expired_and_closed_receivers() {
        let now = Instant::now();
        let (expired_sender, _expired_receiver) = oneshot::channel();
        let (closed_sender, closed_receiver) = oneshot::channel();
        drop(closed_receiver);
        let mut entries = HashMap::from([
            (
                "expired".to_string(),
                Entry {
                    deadline: now,
                    sender: expired_sender,
                },
            ),
            (
                "closed".to_string(),
                Entry {
                    deadline: now + REPLY_BUDGET,
                    sender: closed_sender,
                },
            ),
        ]);
        make_room(&mut entries, now);
        assert!(entries.is_empty());
    }

    #[test]
    fn lark_card_detection_accepts_both_callback_event_types() {
        for event_type in [
            "card.action.trigger",
            "im.interactive_message.action_triggered_v1",
        ] {
            assert!(is_card_callback(
                &serde_json::json!({"header": {"event_type": event_type}})
            ));
        }
        assert!(!is_card_callback(
            &serde_json::json!({"header": {"event_type": "im.message.receive_v1"}})
        ));
    }
}
