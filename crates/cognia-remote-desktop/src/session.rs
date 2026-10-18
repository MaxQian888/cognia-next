//! Viewer sessions and per-target control (ADR-0234 §3, Phase 2 item 6).
//!
//! A session is one bridge plus a renew deadline. Many sessions may view a
//! target; one holds its control lease. Every session is owned by a watcher
//! task kept in its entry: the watcher ends the session when the viewer goes,
//! the bridge fails, renewal stops for [`RENEW_TIMEOUT`], or the Host closes
//! it (explicit close, takeover, binding change, target deletion). Dropping
//! the broker aborts every watcher, and with it every bridge.

use crate::{
    audit,
    bridge::{Bridge, BridgeState},
    control::{ControlLease, ControlLeaseCore},
    error::{RemoteDesktopError, Result},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle, time::Instant};

pub const MAX_SESSIONS: usize = 8;
pub const RENEW_TIMEOUT: Duration = Duration::from_secs(15);
/// The desktop's own user. Phase 3 adds paired-device principals.
pub const LOCAL_PRINCIPAL: &str = "local-owner";
pub(crate) const TARGET_KIND: &str = "external";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    View,
    Control,
}

impl SessionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionMode::View => "view",
            SessionMode::Control => "control",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpened {
    pub session_id: String,
    /// Loopback WebSocket URL carrying the one-shot ticket.
    pub url: String,
    pub mode: SessionMode,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<ControlLease>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRenewed {
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<ControlLease>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum EndReason {
    Closed,
    Expired,
    Preempted,
    ViewerClosed,
    Failed(RemoteDesktopError),
    BindingChanged,
    TargetDeleted,
}

impl EndReason {
    fn as_str(&self) -> &'static str {
        match self {
            EndReason::Closed => "closed",
            EndReason::Expired => "expired",
            EndReason::Preempted => "preempted",
            EndReason::ViewerClosed => "viewer_closed",
            EndReason::Failed(_) => "failed",
            EndReason::BindingChanged => "binding_changed",
            EndReason::TargetDeleted => "target_deleted",
        }
    }
}

struct SessionEntry {
    target_id: String,
    binding_id: String,
    mode: SessionMode,
    lease: Option<ControlLease>,
    deadline: watch::Sender<Instant>,
    stop: watch::Sender<Option<EndReason>>,
    task: Option<JoinHandle<()>>,
}

impl SessionEntry {
    fn end(&self, reason: EndReason) {
        self.stop.send_if_modified(|current| {
            if current.is_none() {
                *current = Some(reason);
                true
            } else {
                false
            }
        });
    }
}

impl Drop for SessionEntry {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[derive(Default)]
struct BrokerState {
    sessions: HashMap<String, SessionEntry>,
    leases: HashMap<String, ControlLeaseCore>,
    /// Bumped whenever a binding a session could use changes; an open that
    /// started before the bump is refused instead of bridging a stale binding.
    revision: u64,
}

#[derive(Default)]
pub(crate) struct Broker {
    state: Mutex<BrokerState>,
}

/// What an open needs to commit once the bridge is listening.
pub(crate) struct Admission {
    pub target_id: String,
    pub binding_id: String,
    pub mode: SessionMode,
    pub takeover: bool,
    pub revision: u64,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl Broker {
    pub fn revision(&self) -> u64 {
        self.state.lock().revision
    }

    /// Fail fast before reading credentials or binding a port. The same
    /// rules are checked again at commit.
    pub fn precheck(&self, target_id: &str, mode: SessionMode, takeover: bool) -> Result<()> {
        let state = self.state.lock();
        admit(&state, target_id, mode, takeover)
    }

    pub fn commit(self: &Arc<Self>, admission: Admission, bridge: Bridge) -> Result<SessionOpened> {
        let url = bridge.url.clone();
        let session_id = uuid::Uuid::new_v4().simple().to_string();
        let now = now_ms();
        let deadline = Instant::now() + RENEW_TIMEOUT;
        let (deadline_tx, deadline_rx) = watch::channel(deadline);
        let (stop_tx, stop_rx) = watch::channel(None);
        let mut state = self.state.lock();
        if state.revision != admission.revision {
            return Err(RemoteDesktopError::new("remote_desktop_binding_changed"));
        }
        admit(&state, &admission.target_id, admission.mode, admission.takeover)?;
        let mut preempted = false;
        let lease = if admission.mode == SessionMode::Control {
            for entry in state.sessions.values() {
                if entry.target_id == admission.target_id && entry.mode == SessionMode::Control {
                    entry.end(EndReason::Preempted);
                    preempted = true;
                }
            }
            let core = state.leases.entry(admission.target_id.clone()).or_default();
            Some(core.issue(LOCAL_PRINCIPAL, now, i64::MAX))
        } else {
            None
        };
        let task = tokio::spawn(watch_session(
            Arc::downgrade(self),
            session_id.clone(),
            bridge,
            deadline_rx,
            stop_rx,
        ));
        state.sessions.insert(
            session_id.clone(),
            SessionEntry {
                target_id: admission.target_id.clone(),
                binding_id: admission.binding_id.clone(),
                mode: admission.mode,
                lease: lease.clone(),
                deadline: deadline_tx,
                stop: stop_tx,
                task: Some(task),
            },
        );
        drop(state);
        let fields = json!({"binding_id": admission.binding_id, "mode": admission.mode.as_str()});
        audit::record_background(
            "remote_desktop.session.open",
            TARGET_KIND,
            &admission.target_id,
            LOCAL_PRINCIPAL,
            "allow",
            lease.as_ref().map_or(0, |lease| lease.fence),
            fields.clone(),
        );
        if let Some(lease) = &lease {
            audit::record_background(
                if preempted {
                    "remote_desktop.lease.takeover"
                } else {
                    "remote_desktop.lease.acquire"
                },
                TARGET_KIND,
                &admission.target_id,
                LOCAL_PRINCIPAL,
                "allow",
                lease.fence,
                json!({"binding_id": admission.binding_id, "expires_at": lease.expires_at}),
            );
        }
        Ok(SessionOpened {
            session_id,
            url,
            mode: admission.mode,
            expires_at: now + RENEW_TIMEOUT.as_millis() as i64,
            lease,
        })
    }

    pub fn renew(&self, session_id: &str) -> Result<SessionRenewed> {
        let now = now_ms();
        let mut state = self.state.lock();
        let state = &mut *state;
        let entry = state
            .sessions
            .get_mut(session_id)
            .filter(|entry| entry.stop.borrow().is_none())
            .ok_or_else(|| RemoteDesktopError::new("remote_desktop_session_not_found"))?;
        if let Some(lease) = entry.lease.clone() {
            let renewed = state
                .leases
                .get_mut(&entry.target_id)
                .ok_or(())
                .and_then(|core| {
                    core.renew(LOCAL_PRINCIPAL, &lease.token, lease.fence, now, i64::MAX)
                        .map_err(|_| ())
                });
            match renewed {
                Ok(renewed) => entry.lease = Some(renewed),
                Err(()) => {
                    entry.end(EndReason::Preempted);
                    return Err(RemoteDesktopError::new("remote_desktop_lease_lost"));
                }
            }
            audit::record_background(
                "remote_desktop.lease.renew",
                TARGET_KIND,
                &entry.target_id,
                LOCAL_PRINCIPAL,
                "allow",
                lease.fence,
                json!({"binding_id": entry.binding_id,
                    "expires_at": entry.lease.as_ref().map(|lease| lease.expires_at)}),
            );
        }
        let _ = entry.deadline.send(Instant::now() + RENEW_TIMEOUT);
        Ok(SessionRenewed {
            expires_at: now + RENEW_TIMEOUT.as_millis() as i64,
            lease: entry.lease.clone(),
        })
    }

    /// Idempotent: closing an unknown or ending session is not an error.
    pub fn close(&self, session_id: &str) {
        if let Some(entry) = self.state.lock().sessions.get(session_id) {
            entry.end(EndReason::Closed);
        }
    }

    /// End every session on `target_id` whose binding is in `binding_ids`
    /// (all of the target's sessions when `None`), and invalidate opens that
    /// are still in flight.
    pub fn end_bindings(&self, target_id: &str, binding_ids: Option<&[String]>, reason: EndReason) {
        let mut state = self.state.lock();
        state.revision = state.revision.wrapping_add(1);
        for entry in state.sessions.values() {
            if entry.target_id == target_id
                && binding_ids.is_none_or(|ids| ids.contains(&entry.binding_id))
            {
                entry.end(reason.clone());
            }
        }
        if reason == EndReason::TargetDeleted {
            if let Some(core) = state.leases.get_mut(target_id) {
                core.invalidate();
            }
        }
    }

    /// Drop the lease table of a deleted target once its sessions are gone.
    pub fn forget_target(&self, target_id: &str) {
        let mut state = self.state.lock();
        if !state.sessions.values().any(|entry| entry.target_id == target_id) {
            state.leases.remove(target_id);
        }
    }

    #[cfg(test)]
    pub fn session_count(&self) -> usize {
        self.state.lock().sessions.len()
    }

    /// Called by the watcher once its bridge is gone.
    fn finish(&self, session_id: &str, reason: EndReason) {
        let mut state = self.state.lock();
        let Some(mut entry) = state.sessions.remove(session_id) else {
            return;
        };
        // The watcher is the caller: it must not abort itself on drop.
        entry.task.take();
        let mut released = None;
        if let Some(lease) = &entry.lease {
            if let Some(core) = state.leases.get_mut(&entry.target_id) {
                if core
                    .status()
                    .lease
                    .is_some_and(|held| held.dto.token == lease.token)
                {
                    core.invalidate();
                    released = Some(lease.fence);
                }
            }
        }
        drop(state);
        let mut fields = json!({"binding_id": entry.binding_id, "mode": entry.mode.as_str(),
            "reason": reason.as_str()});
        let (kind, decision) = match &reason {
            EndReason::Failed(error) => {
                fields["code"] = json!(error.code);
                ("remote_desktop.session.failed", "deny")
            }
            _ => ("remote_desktop.session.close", "allow"),
        };
        let fence = entry.lease.as_ref().map_or(0, |lease| lease.fence);
        audit::record_background(kind, TARGET_KIND, &entry.target_id, LOCAL_PRINCIPAL, decision, fence, fields);
        if let Some(fence) = released {
            audit::record_background(
                if reason == EndReason::Expired {
                    "remote_desktop.lease.expire"
                } else {
                    "remote_desktop.lease.release"
                },
                TARGET_KIND,
                &entry.target_id,
                LOCAL_PRINCIPAL,
                "allow",
                fence,
                json!({"binding_id": entry.binding_id}),
            );
        }
    }
}

fn admit(state: &BrokerState, target_id: &str, mode: SessionMode, takeover: bool) -> Result<()> {
    let live = state
        .sessions
        .values()
        .filter(|entry| entry.stop.borrow().is_none());
    if live.clone().count() >= MAX_SESSIONS {
        return Err(RemoteDesktopError::new("remote_desktop_session_limit"));
    }
    if mode == SessionMode::Control && !takeover {
        let controlled = live
            .clone()
            .any(|entry| entry.target_id == target_id && entry.mode == SessionMode::Control);
        if controlled {
            return Err(RemoteDesktopError::new("remote_desktop_control_busy"));
        }
    }
    Ok(())
}

async fn watch_session(
    broker: Weak<Broker>,
    session_id: String,
    mut bridge: Bridge,
    mut deadline: watch::Receiver<Instant>,
    mut stop: watch::Receiver<Option<EndReason>>,
) {
    let reason = loop {
        if let Some(reason) = stop.borrow_and_update().clone() {
            break reason;
        }
        let at = *deadline.borrow_and_update();
        tokio::select! {
            state = bridge.finished() => break match state {
                BridgeState::Failed(error) => EndReason::Failed(error),
                _ => EndReason::ViewerClosed,
            },
            _ = tokio::time::sleep_until(at) => {
                if *deadline.borrow() <= Instant::now() {
                    break EndReason::Expired;
                }
            }
            changed = deadline.changed() => if changed.is_err() { break EndReason::Closed },
            changed = stop.changed() => if changed.is_err() { break EndReason::Closed },
        }
    };
    bridge.close();
    drop(bridge);
    if let Some(broker) = broker.upgrade() {
        broker.finish(&session_id, reason);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bridge::BridgeTarget, target::Adapter};
    use std::net::SocketAddr;

    async fn idle_bridge() -> Bridge {
        // Nothing dials it in these tests: the session ends on Host rules.
        Bridge::start(
            BridgeTarget {
                addr: SocketAddr::from(([127, 0, 0, 1], 9)),
                adapter: Adapter::None,
                password: None,
            },
            Duration::from_secs(3600),
        )
        .await
        .unwrap()
    }

    fn admission(broker: &Broker, target: &str, mode: SessionMode, takeover: bool) -> Admission {
        Admission {
            target_id: target.into(),
            binding_id: "b".into(),
            mode,
            takeover,
            revision: broker.revision(),
        }
    }

    async fn settle(broker: &Broker, count: usize) {
        for _ in 0..200 {
            if broker.session_count() == count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("expected {count} sessions, have {}", broker.session_count());
    }

    #[tokio::test]
    async fn one_controller_many_viewers_and_takeover_preempts() {
        let broker = Arc::new(Broker::default());
        let view = broker
            .commit(admission(&broker, "t", SessionMode::View, false), idle_bridge().await)
            .unwrap();
        assert!(view.lease.is_none());
        let first = broker
            .commit(admission(&broker, "t", SessionMode::Control, false), idle_bridge().await)
            .unwrap();
        let first_lease = first.lease.clone().unwrap();
        assert_eq!(
            broker.precheck("t", SessionMode::Control, false).unwrap_err().code,
            "remote_desktop_control_busy"
        );
        // Another target is independent.
        broker.precheck("u", SessionMode::Control, false).unwrap();
        let second = broker
            .commit(admission(&broker, "t", SessionMode::Control, true), idle_bridge().await)
            .unwrap();
        assert!(second.lease.as_ref().unwrap().fence > first_lease.fence);
        assert_eq!(
            broker.renew(&first.session_id).unwrap_err().code,
            "remote_desktop_session_not_found"
        );
        settle(&broker, 2).await;
        broker.renew(&view.session_id).unwrap();
        let renewed = broker.renew(&second.session_id).unwrap();
        assert_eq!(renewed.lease.unwrap().token, second.lease.unwrap().token);
    }

    #[tokio::test]
    async fn the_session_limit_counts_live_sessions() {
        let broker = Arc::new(Broker::default());
        let mut ids = Vec::new();
        for _ in 0..MAX_SESSIONS {
            ids.push(
                broker
                    .commit(admission(&broker, "t", SessionMode::View, false), idle_bridge().await)
                    .unwrap()
                    .session_id,
            );
        }
        assert_eq!(
            broker.precheck("t", SessionMode::View, false).unwrap_err().code,
            "remote_desktop_session_limit"
        );
        broker.close(&ids[0]);
        broker.close(&ids[0]);
        broker.close("unknown");
        broker.precheck("t", SessionMode::View, false).unwrap();
        settle(&broker, MAX_SESSIONS - 1).await;
    }

    #[tokio::test]
    async fn a_binding_change_ends_its_sessions_and_refuses_inflight_opens() {
        let broker = Arc::new(Broker::default());
        let kept = broker
            .commit(admission(&broker, "t", SessionMode::View, false), idle_bridge().await)
            .unwrap();
        let mut other = admission(&broker, "t", SessionMode::Control, false);
        other.binding_id = "c".into();
        let ended = broker.commit(other, idle_bridge().await).unwrap();
        let inflight = admission(&broker, "t", SessionMode::View, false);
        broker.end_bindings("t", Some(&["c".to_string()]), EndReason::BindingChanged);
        assert_eq!(
            broker.commit(inflight, idle_bridge().await).unwrap_err().code,
            "remote_desktop_binding_changed"
        );
        settle(&broker, 1).await;
        broker.renew(&kept.session_id).unwrap();
        assert!(broker.renew(&ended.session_id).is_err());
        broker.end_bindings("t", None, EndReason::TargetDeleted);
        settle(&broker, 0).await;
        broker.forget_target("t");
        assert!(broker.state.lock().leases.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_without_renewal_expires_and_releases_control() {
        let broker = Arc::new(Broker::default());
        let opened = broker
            .commit(admission(&broker, "t", SessionMode::Control, false), idle_bridge().await)
            .unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
        broker.renew(&opened.session_id).unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert_eq!(broker.session_count(), 1);
        tokio::time::sleep(Duration::from_secs(6)).await;
        tokio::task::yield_now().await;
        assert_eq!(broker.session_count(), 0);
        assert!(broker.state.lock().leases["t"].status().lease.is_none());
        broker.precheck("t", SessionMode::Control, false).unwrap();
    }

    #[tokio::test]
    async fn dropping_the_broker_ends_every_bridge() {
        let broker = Arc::new(Broker::default());
        let opened = broker
            .commit(admission(&broker, "t", SessionMode::View, false), idle_bridge().await)
            .unwrap();
        let port: u16 = opened.url.trim_start_matches("ws://127.0.0.1:").split('/').next().unwrap().parse().unwrap();
        drop(broker);
        for _ in 0..200 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the bridge listener outlived its broker");
    }
}
