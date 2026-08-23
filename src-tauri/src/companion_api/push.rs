//! Push notification channel (Wave 3.4) — minimal in-house dispatcher.
//!
//! `fcm-rust` / `a2-rs` would be the off-the-shelf clients; we keep the
//! crate footprint minimal and use plain `reqwest` for HTTP delivery.
//!
//! # Surface
//!
//! - [`PushTokenRegistry`] — per-device APNs / FCM token store, keyed
//!   by `device_id`. Lives in `CompanionState` so RPCs can register
//!   tokens and the dispatcher can read them.
//! - [`PushDispatcher`] trait — pluggable delivery backend. The
//!   default [`NoopDispatcher`] logs the call without delivering;
//!   a Tauri command can swap in the FCM/APNs implementation once
//!   credentials are configured.
//! - [`PushPayload`] — the documented `{ title, body, data }`
//!   payload shape that the mobile boot provider already understands.
//!
//! # Suppression
//!
//! When a device has an open WebSocket session, push delivery is
//! skipped — the WS event bus carries the same payload and double-
//! delivery would surface as a duplicate notification on the lock
//! screen. The check is cooperative; the WS layer flips a flag in the
//! registry on connect/disconnect.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

const PUSH_TOKENS_FILE: &str = "push-tokens.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushProvider {
    Fcm,
    Apns,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushTokenRecord {
    pub device_id: String,
    pub provider: PushProvider,
    pub token: String,
    pub app_version: Option<String>,
    pub device_locale: Option<String>,
    pub registered_at: i64,
}

/// Payload delivered to one or many devices. The mobile boot provider
/// (`components/providers/companion-boot-provider.tsx`) already routes on
/// `data.sessionId` to deep-link a tap, so existing client logic handles
/// these payloads unchanged.
///
/// Foundation API — surface stays public so future delivery hooks
/// (workflow run finished, twin job completed, connector draft created)
/// can call `PushTokenRegistry::dispatch_to_device` without further
/// plumbing.
#[allow(dead_code)] // Wave 3.4 foundation — full delivery pipeline ships in a follow-up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushPayload {
    pub title: Option<String>,
    pub body: Option<String>,
    #[serde(default)]
    pub data: serde_json::Map<String, serde_json::Value>,
}

#[allow(dead_code)] // Foundation — Sent/Failed return paths arrive with the FCM/APNs client.
#[derive(Debug, Clone, Copy)]
pub enum DeliveryOutcome {
    Sent,
    SuppressedWebsocketActive,
    SuppressedNoToken,
    NotConfigured,
    Failed,
}

#[allow(dead_code)] // Trait surface for plugin / future built-in delivery clients.
#[async_trait::async_trait]
pub trait PushDispatcher: Send + Sync {
    async fn deliver(&self, record: &PushTokenRecord, payload: &PushPayload) -> DeliveryOutcome;
}

#[allow(dead_code)] // Default placeholder until FCM/APNs delivery is wired up.
pub struct NoopDispatcher;

#[async_trait::async_trait]
impl PushDispatcher for NoopDispatcher {
    async fn deliver(&self, _record: &PushTokenRecord, _payload: &PushPayload) -> DeliveryOutcome {
        // No credentials wired up yet — the dispatcher exists so the
        // contract is testable. Replace with a real FCM / APNs client
        // when push-credentials.json is configured.
        DeliveryOutcome::NotConfigured
    }
}

/// Per-device push token registry. Whether a device is currently listening
/// in-band is NOT stored here — see [`PushTokenRegistry::has_live_event_stream`].
pub struct PushTokenRegistry {
    inner: RwLock<RegistryInner>,
    /// Where to persist the token map. `None` ⇒ in-memory only (tests).
    persistence: Option<PathBuf>,
}

struct RegistryInner {
    tokens: HashMap<String, PushTokenRecord>,
}

impl PushTokenRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(RegistryInner {
                tokens: HashMap::new(),
            }),
            persistence: None,
        })
    }

    /// Construct a registry that persists its token map to
    /// `<data_dir>/cognia/companion/push-tokens.json`. Reads the file on
    /// startup if it exists; missing or corrupt files start empty.
    ///
    /// Persistence (Phase B1) — keeps registered devices stable across
    /// desktop restarts so the user doesn't have to re-pair just because
    /// they closed the app.
    #[allow(dead_code)] // used by `companion_server_start` in commands.rs.
    pub fn with_persistence(data_dir: &std::path::Path) -> Arc<Self> {
        let dir = data_dir.join("cognia").join("companion");
        let path = dir.join(PUSH_TOKENS_FILE);
        let tokens = std::fs::read_to_string(&path)
            .ok()
            .and_then(|contents| {
                serde_json::from_str::<HashMap<String, PushTokenRecord>>(&contents).ok()
            })
            .unwrap_or_default();
        Arc::new(Self {
            inner: RwLock::new(RegistryInner { tokens }),
            persistence: Some(path),
        })
    }

    pub fn register(&self, record: PushTokenRecord) {
        {
            let mut g = self.inner.write();
            g.tokens.insert(record.device_id.clone(), record);
        }
        self.save_to_disk();
    }

    pub fn revoke(&self, device_id: &str) {
        {
            let mut g = self.inner.write();
            g.tokens.remove(device_id);
        }
        self.save_to_disk();
    }

    /// Best-effort persistence — failures are logged but never propagated
    /// because losing a write here just means the user re-registers on
    /// the next push token rotation (Capacitor calls register on every
    /// app boot).
    fn save_to_disk(&self) {
        let Some(path) = self.persistence.as_ref() else {
            return;
        };
        let snapshot = {
            let g = self.inner.read();
            g.tokens.clone()
        };
        let json = match serde_json::to_string_pretty(&snapshot) {
            Ok(s) => s,
            Err(err) => {
                log::warn!("push-tokens serialize failed: {err}");
                return;
            }
        };
        if let Some(parent) = path.parent() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                log::warn!("push-tokens dir create failed: {err}");
                return;
            }
        }
        if let Err(err) = std::fs::write(path, json) {
            log::warn!("push-tokens write failed: {err}");
        }
    }

    #[allow(dead_code)] // public for the dispatcher path landing in a follow-up.
    pub fn get(&self, device_id: &str) -> Option<PushTokenRecord> {
        self.inner.read().tokens.get(device_id).cloned()
    }

    /// True when the device is already receiving canonical events in-band, so
    /// a native push would duplicate something it can see.
    ///
    /// This used to be a WebSocket-only refcount owned by this registry, which
    /// two things made wrong: nothing outside this file's tests ever
    /// incremented it (so it answered `false` for everyone and every push woke
    /// every paired device), and it had no notion of WebRTC (so an RTC-only
    /// phone would still have read as offline once it did). Ownership now sits
    /// with `event_leases`, which both transports register with, and which
    /// distinguishes a socket that has upgraded from one that has caught up.
    pub fn has_live_event_stream(&self, device_id: &str) -> bool {
        super::event_leases::has_ready_stream(device_id)
    }

    #[allow(dead_code)]
    pub async fn dispatch_to_device(
        &self,
        device_id: &str,
        payload: &PushPayload,
        dispatcher: &dyn PushDispatcher,
    ) -> DeliveryOutcome {
        if self.has_live_event_stream(device_id) {
            return DeliveryOutcome::SuppressedWebsocketActive;
        }
        let record = match self.get(device_id) {
            Some(r) => r,
            None => return DeliveryOutcome::SuppressedNoToken,
        };
        dispatcher.deliver(&record, payload).await
    }

    #[cfg(test)]
    pub fn token_count(&self) -> usize {
        self.inner.read().tokens.len()
    }

    /// Iterate registered devices for one provider and call
    /// `dispatch_to_device` on the supplied dispatcher. Used by the event-bus
    /// trigger wiring in Phase B4 to deliver a single payload to compatible
    /// offline phones without submitting APNs tokens to FCM or vice versa.
    #[allow(dead_code)]
    pub async fn broadcast_to_offline(
        &self,
        provider: PushProvider,
        payload: &PushPayload,
        dispatcher: &dyn PushDispatcher,
    ) -> usize {
        self.broadcast_to_offline_targets(provider, payload, dispatcher, None)
            .await
    }

    /// Same fan-out, restricted to `targets` when the caller knows which
    /// devices the event is *for*.
    ///
    /// Broadcasting is right for account-wide news ("you have a notification"),
    /// and wrong for a decision prompt: a tool-approval request is routed to the
    /// one device attached to that session, so waking every paired phone tells
    /// devices about a prompt they cannot answer and leaks which sessions are
    /// active to devices that were never watching. `None` keeps the broadcast
    /// behaviour; an empty slice sends to nobody, which is the correct outcome
    /// when no attached device qualifies.
    pub async fn broadcast_to_offline_targets(
        &self,
        provider: PushProvider,
        payload: &PushPayload,
        dispatcher: &dyn PushDispatcher,
        targets: Option<&[String]>,
    ) -> usize {
        let device_ids: Vec<String> = {
            let g = self.inner.read();
            g.tokens
                .values()
                .filter(|record| record.provider == provider)
                .filter(|record| match targets {
                    Some(allowed) => allowed.iter().any(|id| id == &record.device_id),
                    None => true,
                })
                .map(|record| record.device_id.clone())
                .collect()
        };
        let mut sent = 0;
        for id in device_ids {
            let outcome = self.dispatch_to_device(&id, payload, dispatcher).await;
            if matches!(outcome, DeliveryOutcome::Sent) {
                sent += 1;
            }
        }
        sent
    }
}

/// Holds the currently configured FCM + APNs dispatchers (Phase B2/B4).
/// Both slots start empty; the user uploads credentials via Tauri commands
/// to populate. The trigger wiring picks the right dispatcher based on
/// each device's `PushProvider`.
pub struct DispatcherSet {
    inner: parking_lot::RwLock<DispatcherSlots>,
}

struct DispatcherSlots {
    fcm: Option<Arc<dyn PushDispatcher>>,
    apns: Option<Arc<dyn PushDispatcher>>,
}

impl DispatcherSet {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: parking_lot::RwLock::new(DispatcherSlots {
                fcm: None,
                apns: None,
            }),
        })
    }

    #[allow(dead_code)]
    pub fn set_fcm(&self, dispatcher: Arc<dyn PushDispatcher>) {
        self.inner.write().fcm = Some(dispatcher);
    }

    #[allow(dead_code)]
    pub fn set_apns(&self, dispatcher: Arc<dyn PushDispatcher>) {
        self.inner.write().apns = Some(dispatcher);
    }

    #[allow(dead_code)]
    pub fn clear_fcm(&self) {
        self.inner.write().fcm = None;
    }

    #[allow(dead_code)]
    pub fn clear_apns(&self) {
        self.inner.write().apns = None;
    }

    #[allow(dead_code)]
    pub fn for_provider(&self, provider: PushProvider) -> Option<Arc<dyn PushDispatcher>> {
        let g = self.inner.read();
        match provider {
            PushProvider::Fcm => g.fcm.clone(),
            PushProvider::Apns => g.apns.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_record(device_id: &str) -> PushTokenRecord {
        PushTokenRecord {
            device_id: device_id.to_string(),
            provider: PushProvider::Fcm,
            token: "tok-1".to_string(),
            app_version: Some("0.1.0".to_string()),
            device_locale: Some("en-US".to_string()),
            registered_at: 0,
        }
    }

    #[test]
    fn register_then_get_round_trip() {
        let r = PushTokenRegistry::new();
        r.register(make_record("dev-1"));
        let got = r.get("dev-1").unwrap();
        assert_eq!(got.token, "tok-1");
        assert_eq!(r.token_count(), 1);
    }

    #[test]
    fn revoke_removes_the_token() {
        let r = PushTokenRegistry::new();
        r.register(make_record("dev-1"));
        r.revoke("dev-1");
        assert!(r.get("dev-1").is_none());
    }

    /// Liveness is now read from `event_leases`, so this asserts the delegation
    /// as well as the suppression: a ready stream on EITHER transport counts,
    /// and a stream that has merely opened does not.
    #[test]
    fn a_ready_stream_on_either_transport_suppresses_delivery() {
        let r = PushTokenRegistry::new();
        r.register(make_record("push-live-1"));
        let lease = super::super::event_leases::EventStreamLeaseGuard::open(
            "push-live-1",
            super::super::event_leases::EventStreamTransport::Rtc,
        );
        assert!(
            !r.has_live_event_stream("push-live-1"),
            "a channel that is still replaying has not shown the device the frame yet"
        );
        lease.advance(super::super::event_leases::EventStreamState::Ready);
        assert!(r.has_live_event_stream("push-live-1"));
        drop(lease);
        assert!(!r.has_live_event_stream("push-live-1"));
    }

    #[test]
    fn the_device_stays_live_until_its_last_stream_closes() {
        let r = PushTokenRegistry::new();
        let ws = super::super::event_leases::EventStreamLeaseGuard::open(
            "push-live-2",
            super::super::event_leases::EventStreamTransport::Ws,
        );
        let rtc = super::super::event_leases::EventStreamLeaseGuard::open(
            "push-live-2",
            super::super::event_leases::EventStreamTransport::Rtc,
        );
        ws.advance(super::super::event_leases::EventStreamState::Ready);
        rtc.advance(super::super::event_leases::EventStreamState::Ready);
        drop(ws);
        assert!(r.has_live_event_stream("push-live-2"));
        drop(rtc);
        assert!(!r.has_live_event_stream("push-live-2"));
    }

    #[tokio::test]
    async fn dispatch_with_no_token_is_suppressed() {
        let r = PushTokenRegistry::new();
        let outcome = r
            .dispatch_to_device(
                "dev-1",
                &PushPayload {
                    title: None,
                    body: None,
                    data: Default::default(),
                },
                &NoopDispatcher,
            )
            .await;
        assert!(matches!(outcome, DeliveryOutcome::SuppressedNoToken));
    }

    #[tokio::test]
    async fn dispatch_with_active_ws_is_suppressed_even_if_token_present() {
        let r = PushTokenRegistry::new();
        r.register(make_record("push-suppress-1"));
        let lease = super::super::event_leases::EventStreamLeaseGuard::open(
            "push-suppress-1",
            super::super::event_leases::EventStreamTransport::Ws,
        );
        lease.advance(super::super::event_leases::EventStreamState::Ready);
        let outcome = r
            .dispatch_to_device(
                "push-suppress-1",
                &PushPayload {
                    title: None,
                    body: None,
                    data: Default::default(),
                },
                &NoopDispatcher,
            )
            .await;
        assert!(matches!(
            outcome,
            DeliveryOutcome::SuppressedWebsocketActive
        ));
    }

    #[tokio::test]
    async fn dispatch_with_token_and_no_ws_returns_dispatcher_outcome() {
        let r = PushTokenRegistry::new();
        r.register(make_record("dev-1"));
        let outcome = r
            .dispatch_to_device(
                "dev-1",
                &PushPayload {
                    title: Some("hi".to_string()),
                    body: None,
                    data: Default::default(),
                },
                &NoopDispatcher,
            )
            .await;
        assert!(matches!(outcome, DeliveryOutcome::NotConfigured));
    }

    #[test]
    fn persistence_roundtrip_through_disk() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // First registry populates and writes to disk.
        let r1 = PushTokenRegistry::with_persistence(tmp.path());
        r1.register(make_record("dev-1"));
        r1.register(PushTokenRecord {
            device_id: "dev-2".to_string(),
            provider: PushProvider::Apns,
            token: "tok-2".to_string(),
            app_version: None,
            device_locale: None,
            registered_at: 0,
        });

        // Second registry reads the same dir and sees both entries.
        let r2 = PushTokenRegistry::with_persistence(tmp.path());
        assert_eq!(r2.token_count(), 2);
        let dev1 = r2.get("dev-1").expect("dev-1 reloaded");
        assert_eq!(dev1.token, "tok-1");
        let dev2 = r2.get("dev-2").expect("dev-2 reloaded");
        assert!(matches!(dev2.provider, PushProvider::Apns));
    }

    #[test]
    fn persistence_revoke_is_persisted() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let r1 = PushTokenRegistry::with_persistence(tmp.path());
        r1.register(make_record("dev-1"));
        r1.revoke("dev-1");

        let r2 = PushTokenRegistry::with_persistence(tmp.path());
        assert_eq!(r2.token_count(), 0);
    }

    #[test]
    fn persistence_corrupt_file_starts_empty() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("cognia").join("companion");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("push-tokens.json"), "this is not json").unwrap();

        let r = PushTokenRegistry::with_persistence(tmp.path());
        assert_eq!(r.token_count(), 0);
    }

    // ── DispatcherSet ─────────────────────────────────────────────────────────

    struct StubDispatcher {
        outcome: DeliveryOutcome,
    }

    #[async_trait::async_trait]
    impl PushDispatcher for StubDispatcher {
        async fn deliver(
            &self,
            _record: &PushTokenRecord,
            _payload: &PushPayload,
        ) -> DeliveryOutcome {
            self.outcome
        }
    }

    /// Records who was actually delivered to — the targeting assertions need
    /// the audience, not just the count.
    #[derive(Default)]
    struct RecordingDispatcher {
        delivered: parking_lot::Mutex<Vec<String>>,
    }

    impl RecordingDispatcher {
        fn device_ids(&self) -> Vec<String> {
            self.delivered.lock().clone()
        }
    }

    #[async_trait::async_trait]
    impl PushDispatcher for RecordingDispatcher {
        async fn deliver(
            &self,
            record: &PushTokenRecord,
            _payload: &PushPayload,
        ) -> DeliveryOutcome {
            self.delivered.lock().push(record.device_id.clone());
            DeliveryOutcome::Sent
        }
    }

    #[test]
    fn dispatcher_set_empty_returns_none() {
        let set = DispatcherSet::new();
        assert!(set.for_provider(PushProvider::Fcm).is_none());
        assert!(set.for_provider(PushProvider::Apns).is_none());
    }

    #[test]
    fn dispatcher_set_set_and_clear_per_provider() {
        let set = DispatcherSet::new();
        let stub: Arc<dyn PushDispatcher> = Arc::new(StubDispatcher {
            outcome: DeliveryOutcome::Sent,
        });
        set.set_fcm(Arc::clone(&stub));
        assert!(set.for_provider(PushProvider::Fcm).is_some());
        assert!(set.for_provider(PushProvider::Apns).is_none());

        set.set_apns(Arc::clone(&stub));
        assert!(set.for_provider(PushProvider::Apns).is_some());

        set.clear_fcm();
        assert!(set.for_provider(PushProvider::Fcm).is_none());
        assert!(set.for_provider(PushProvider::Apns).is_some());

        set.clear_apns();
        assert!(set.for_provider(PushProvider::Apns).is_none());
    }

    #[tokio::test]
    async fn broadcast_to_offline_sends_only_to_matching_provider() {
        let r = PushTokenRegistry::new();
        r.register(make_record("dev-1"));
        r.register(PushTokenRecord {
            device_id: "dev-2".to_string(),
            provider: PushProvider::Apns,
            token: "tok-2".to_string(),
            app_version: None,
            device_locale: None,
            registered_at: 0,
        });

        let dispatcher = StubDispatcher {
            outcome: DeliveryOutcome::Sent,
        };
        let count = r
            .broadcast_to_offline(
                PushProvider::Fcm,
                &PushPayload {
                    title: Some("t".into()),
                    body: None,
                    data: Default::default(),
                },
                &dispatcher,
            )
            .await;
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn broadcast_to_offline_targets_reaches_only_the_named_devices() {
        // Device ids are unique per test: `event_leases` is process-global, so
        // a `dev-2` leased by a sibling test would suppress delivery here and
        // this assertion would fail depending on scheduling.
        let r = PushTokenRegistry::new();
        r.register(make_record("push-target-1"));
        r.register(make_record("push-target-2"));
        r.register(make_record("push-target-3"));
        let dispatcher = RecordingDispatcher::default();

        let sent = r
            .broadcast_to_offline_targets(
                PushProvider::Fcm,
                &PushPayload {
                    title: None,
                    body: None,
                    data: Default::default(),
                },
                &dispatcher,
                Some(&["push-target-2".to_string()]),
            )
            .await;

        assert_eq!(sent, 1);
        assert_eq!(dispatcher.device_ids(), vec!["push-target-2".to_string()]);
    }

    /// An empty audience must send to nobody rather than falling back to a
    /// broadcast — the difference between "nobody is attached" and "everybody".
    #[tokio::test]
    async fn broadcast_to_offline_targets_sends_nothing_for_an_empty_audience() {
        let r = PushTokenRegistry::new();
        r.register(make_record("dev-1"));
        let dispatcher = RecordingDispatcher::default();

        let sent = r
            .broadcast_to_offline_targets(
                PushProvider::Fcm,
                &PushPayload {
                    title: None,
                    body: None,
                    data: Default::default(),
                },
                &dispatcher,
                Some(&[]),
            )
            .await;

        assert_eq!(sent, 0);
        assert!(dispatcher.device_ids().is_empty());
    }

    #[tokio::test]
    async fn broadcast_to_offline_skips_active_ws_devices() {
        // The leased id is unique to this test: `event_leases` is
        // process-global, so a shared id would suppress delivery in whichever
        // sibling test happened to be running at the same time.
        let r = PushTokenRegistry::new();
        r.register(make_record("push-skip-offline"));
        r.register(PushTokenRecord {
            device_id: "push-skip-live".to_string(),
            provider: PushProvider::Fcm,
            token: "tok-2".to_string(),
            app_version: None,
            device_locale: None,
            registered_at: 0,
        });
        // Mark the second device as actively streaming so it is suppressed.
        let lease = super::super::event_leases::EventStreamLeaseGuard::open(
            "push-skip-live",
            super::super::event_leases::EventStreamTransport::Ws,
        );
        lease.advance(super::super::event_leases::EventStreamState::Ready);

        let dispatcher = StubDispatcher {
            outcome: DeliveryOutcome::Sent,
        };
        let count = r
            .broadcast_to_offline(
                PushProvider::Fcm,
                &PushPayload {
                    title: None,
                    body: None,
                    data: Default::default(),
                },
                &dispatcher,
            )
            .await;
        // Only the offline device should have been delivered to.
        assert_eq!(count, 1);
    }
}
