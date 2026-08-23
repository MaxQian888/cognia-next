//! Event-plane leases — one per live canonical-event connection.
//!
//! A paired device can answer HTTP while the stream that carries agent events
//! is dead. That half-connected state used to be invisible: the only record of
//! "is this device listening" was a refcount inside `PushTokenRegistry`, keyed
//! by device, incremented from the WebSocket handler and *never* from the
//! WebRTC dispatcher. So an RTC-only phone counted as offline (it got a native
//! push for a prompt already on its screen) and a WebSocket that had upgraded
//! but not yet drained its replay backlog counted as fully caught up (it could
//! be handed control of a run whose recent history it had not seen).
//!
//! This module is the single source of truth for that question. Each live
//! connection takes a lease with:
//!
//! * a **stable id**, so an attachment can bind itself to *this* stream and
//!   stop conferring control the moment that stream — not merely "some stream"
//!   — goes away;
//! * a **transport**, because WS and RTC may both be open at once and closing
//!   one must not declare the device streamless;
//! * a **state**, because `connecting` → `replaying` → `ready` are three
//!   different answers to "may this device steer a run right now", and only
//!   `ready` means yes.
//!
//! Process-global and in-memory on purpose: it describes live sockets, which do
//! not survive a Host restart. Everything durable (pairing, capability grants)
//! lives in the SecurityStore. The renderer's mirror of this is
//! `lib/companion/device-presence-registry.ts`; leases cross to it as the
//! `callerEventStreams` field injected onto `session_attach`.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use uuid::Uuid;

/// Transport a device's event stream arrived on.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventStreamTransport {
    /// `GET /ws/events`.
    Ws,
    /// WebRTC data channel (`signaling::dispatch`).
    Rtc,
}

impl EventStreamTransport {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ws => "ws",
            Self::Rtc => "rtc",
        }
    }
}

/// How far along a connection is. Not a health rating — a position in the
/// handshake. A stream that is `replaying` is working correctly and is still
/// behind the Host.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventStreamState {
    /// Socket upgraded; the Host has not started sending history yet.
    Connecting,
    /// Draining the replay backlog. The device's view is behind the Host's.
    Replaying,
    /// Caught up and live. The only state that permits control.
    Ready,
}

impl EventStreamState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Replaying => "replaying",
            Self::Ready => "ready",
        }
    }
}

/// The wire shape handed to the renderer on `session_attach`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventStreamLeaseView {
    /// Wire name is `leaseId`, not the camel-cased `id` the container rule
    /// would produce: `readEventStreams` in
    /// `lib/companion/desktop-write-source.ts` keys every entry off it, and an
    /// entry without it is dropped — which silently emptied `callerEventStreams`
    /// and left every attachment downgraded to observe with no stream to bind.
    #[serde(rename = "leaseId")]
    pub id: String,
    pub transport: &'static str,
    pub state: &'static str,
    pub opened_at: u64,
}

#[derive(Clone, Debug)]
struct Lease {
    device_id: String,
    transport: EventStreamTransport,
    state: EventStreamState,
    opened_at: u64,
}

static LEASES: Lazy<Mutex<HashMap<String, Lease>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// Register a newly opened stream and return its lease id.
pub fn open(device_id: &str, transport: EventStreamTransport) -> String {
    let id = format!("esl_{}", Uuid::new_v4());
    LEASES.lock().insert(
        id.clone(),
        Lease {
            device_id: device_id.to_owned(),
            transport,
            state: EventStreamState::Connecting,
            opened_at: now_ms(),
        },
    );
    id
}

/// Advance a lease. Never moves backwards: a `ready` stream that reports
/// `replaying` again would otherwise strip control from a device mid-turn for
/// the duration of one bookkeeping call.
pub fn advance(lease_id: &str, state: EventStreamState) {
    let mut leases = LEASES.lock();
    if let Some(lease) = leases.get_mut(lease_id) {
        let rank = |state: EventStreamState| match state {
            EventStreamState::Connecting => 0,
            EventStreamState::Replaying => 1,
            EventStreamState::Ready => 2,
        };
        if rank(state) > rank(lease.state) {
            lease.state = state;
        }
    }
}

pub fn close(lease_id: &str) {
    LEASES.lock().remove(lease_id);
}

/// Drop every lease held by one device. Called when the pairing or the grant
/// behind those streams is withdrawn, so authority ends with the revocation
/// rather than whenever the socket happens to notice.
pub fn close_device(device_id: &str) {
    LEASES
        .lock()
        .retain(|_, lease| lease.device_id != device_id);
}

/// Every live lease for `device_id`, oldest first.
pub fn leases_for(device_id: &str) -> Vec<EventStreamLeaseView> {
    let leases = LEASES.lock();
    let mut views: Vec<(u64, EventStreamLeaseView)> = leases
        .iter()
        .filter(|(_, lease)| lease.device_id == device_id)
        .map(|(id, lease)| {
            (
                lease.opened_at,
                EventStreamLeaseView {
                    id: id.clone(),
                    transport: lease.transport.as_str(),
                    state: lease.state.as_str(),
                    opened_at: lease.opened_at,
                },
            )
        })
        .collect();
    views.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    views.into_iter().map(|(_, view)| view).collect()
}

/// True when at least one of the device's streams has finished replaying.
///
/// This is the "is it in-band right now" test. Push suppression uses it: a
/// device that is merely *connected* has not necessarily seen the frame the
/// push is about.
pub fn has_ready_stream(device_id: &str) -> bool {
    LEASES
        .lock()
        .values()
        .any(|lease| lease.device_id == device_id && lease.state == EventStreamState::Ready)
}

/// RAII holder for one connection's lease. Every exit path out of a socket
/// handler — and there are many — releases through `Drop`.
pub struct EventStreamLeaseGuard {
    id: String,
}

impl EventStreamLeaseGuard {
    pub fn open(device_id: &str, transport: EventStreamTransport) -> Self {
        Self {
            id: open(device_id, transport),
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn advance(&self, state: EventStreamState) {
        advance(&self.id, state);
    }
}

impl Drop for EventStreamLeaseGuard {
    fn drop(&mut self) {
        close(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_stream_is_not_ready_until_it_finishes_replaying() {
        let device = "device-replay";
        let guard = EventStreamLeaseGuard::open(device, EventStreamTransport::Ws);
        assert!(
            !has_ready_stream(device),
            "a socket that has only upgraded has not shown the device anything yet"
        );
        guard.advance(EventStreamState::Replaying);
        assert!(!has_ready_stream(device));
        guard.advance(EventStreamState::Ready);
        assert!(has_ready_stream(device));
        drop(guard);
        assert!(!has_ready_stream(device));
    }

    /// The renderer keys each entry off `leaseId` and drops anything without
    /// it, so the wire name is part of the contract rather than a formatting
    /// detail of the container's `rename_all`.
    #[test]
    fn the_wire_shape_names_the_lease_id_the_way_the_renderer_reads_it() {
        let guard = EventStreamLeaseGuard::open("device-wire", EventStreamTransport::Ws);
        let views = leases_for("device-wire");
        let json = serde_json::to_value(&views[0]).unwrap();
        assert_eq!(json["leaseId"], serde_json::json!(guard.id()));
        assert!(
            json.get("id").is_none(),
            "`id` is the Rust field, not the wire name"
        );
        assert_eq!(json["transport"], serde_json::json!("ws"));
        assert_eq!(json["state"], serde_json::json!("connecting"));
        assert!(json.get("openedAt").is_some());
    }

    #[test]
    fn a_lease_never_moves_backwards() {
        let device = "device-monotonic";
        let guard = EventStreamLeaseGuard::open(device, EventStreamTransport::Ws);
        guard.advance(EventStreamState::Ready);
        guard.advance(EventStreamState::Replaying);
        assert!(
            has_ready_stream(device),
            "a late bookkeeping call must not strip control from a caught-up device"
        );
    }

    #[test]
    fn closing_one_transport_leaves_the_other_serving() {
        let device = "device-two-transports";
        let ws = EventStreamLeaseGuard::open(device, EventStreamTransport::Ws);
        let rtc = EventStreamLeaseGuard::open(device, EventStreamTransport::Rtc);
        ws.advance(EventStreamState::Ready);
        rtc.advance(EventStreamState::Ready);
        assert_eq!(leases_for(device).len(), 2);
        drop(ws);
        assert!(
            has_ready_stream(device),
            "the WebRTC channel is still delivering; the device is not streamless"
        );
        assert_eq!(leases_for(device).len(), 1);
        assert_eq!(leases_for(device)[0].transport, "rtc");
        drop(rtc);
        assert!(!has_ready_stream(device));
    }

    #[test]
    fn leases_are_reported_per_device_with_their_state() {
        let mine = EventStreamLeaseGuard::open("device-mine", EventStreamTransport::Ws);
        let theirs = EventStreamLeaseGuard::open("device-theirs", EventStreamTransport::Rtc);
        mine.advance(EventStreamState::Ready);

        let views = leases_for("device-mine");
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id, mine.id());
        assert_eq!(views[0].state, "ready");
        assert_eq!(views[0].transport, "ws");
        assert!(
            leases_for("device-theirs")
                .iter()
                .all(|view| view.state == "connecting"),
            "one device's progress must not be reported for another"
        );
        drop(theirs);
    }

    #[test]
    fn lease_view_uses_the_renderer_wire_field_names() {
        let view = EventStreamLeaseView {
            id: "esl-contract".to_string(),
            transport: "ws",
            state: "ready",
            opened_at: 42,
        };

        assert_eq!(
            serde_json::to_value(view).unwrap(),
            serde_json::json!({
                "leaseId": "esl-contract",
                "transport": "ws",
                "state": "ready",
                "openedAt": 42
            })
        );
    }

    #[test]
    fn revoking_a_device_drops_its_streams_without_touching_anyone_elses() {
        let victim = EventStreamLeaseGuard::open("device-revoked", EventStreamTransport::Ws);
        let bystander = EventStreamLeaseGuard::open("device-kept", EventStreamTransport::Ws);
        victim.advance(EventStreamState::Ready);
        bystander.advance(EventStreamState::Ready);

        close_device("device-revoked");
        assert!(!has_ready_stream("device-revoked"));
        assert!(has_ready_stream("device-kept"));
        // Dropping an already-closed guard is a no-op, not a panic or a
        // resurrection: revocation races the socket's own teardown.
        drop(victim);
        assert!(has_ready_stream("device-kept"));
        drop(bystander);
    }

    #[test]
    fn advancing_a_closed_lease_is_inert() {
        let id = {
            let guard = EventStreamLeaseGuard::open("device-gone", EventStreamTransport::Ws);
            guard.id().to_owned()
        };
        advance(&id, EventStreamState::Ready);
        assert!(!has_ready_stream("device-gone"));
        assert!(leases_for("device-gone").is_empty());
    }
}
