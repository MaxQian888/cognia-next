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
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

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
    async fn deliver(
        &self,
        record: &PushTokenRecord,
        payload: &PushPayload,
    ) -> DeliveryOutcome;
}

#[allow(dead_code)] // Default placeholder until FCM/APNs delivery is wired up.
pub struct NoopDispatcher;

#[async_trait::async_trait]
impl PushDispatcher for NoopDispatcher {
    async fn deliver(
        &self,
        _record: &PushTokenRecord,
        _payload: &PushPayload,
    ) -> DeliveryOutcome {
        // No credentials wired up yet — the dispatcher exists so the
        // contract is testable. Replace with a real FCM / APNs client
        // when push-credentials.json is configured.
        DeliveryOutcome::NotConfigured
    }
}

/// Per-device push token registry plus the active-WS suppression flag.
pub struct PushTokenRegistry {
    inner: RwLock<RegistryInner>,
}

#[allow(dead_code)] // websocket_active is consumed via the helper methods below.
struct RegistryInner {
    tokens: HashMap<String, PushTokenRecord>,
    /// Devices whose phone holds a live WS subscription. Live
    /// subscribers receive payloads through the event bus, not push.
    websocket_active: HashMap<String, usize>,
}

impl PushTokenRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(RegistryInner {
                tokens: HashMap::new(),
                websocket_active: HashMap::new(),
            }),
        })
    }

    pub fn register(&self, record: PushTokenRecord) {
        let mut g = self.inner.write();
        g.tokens.insert(record.device_id.clone(), record);
    }

    pub fn revoke(&self, device_id: &str) {
        let mut g = self.inner.write();
        g.tokens.remove(device_id);
    }

    #[allow(dead_code)] // public for the dispatcher path landing in a follow-up.
    pub fn get(&self, device_id: &str) -> Option<PushTokenRecord> {
        self.inner.read().tokens.get(device_id).cloned()
    }

    #[allow(dead_code)]
    pub fn has_websocket(&self, device_id: &str) -> bool {
        self.inner
            .read()
            .websocket_active
            .get(device_id)
            .map(|n| *n > 0)
            .unwrap_or(false)
    }

    #[allow(dead_code)]
    pub fn note_websocket_open(&self, device_id: &str) {
        let mut g = self.inner.write();
        *g.websocket_active.entry(device_id.to_string()).or_insert(0) += 1;
    }

    #[allow(dead_code)]
    pub fn note_websocket_close(&self, device_id: &str) {
        let mut g = self.inner.write();
        if let Some(slot) = g.websocket_active.get_mut(device_id) {
            if *slot > 0 {
                *slot -= 1;
            }
            if *slot == 0 {
                g.websocket_active.remove(device_id);
            }
        }
    }

    #[allow(dead_code)]
    pub async fn dispatch_to_device(
        &self,
        device_id: &str,
        payload: &PushPayload,
        dispatcher: &dyn PushDispatcher,
    ) -> DeliveryOutcome {
        if self.has_websocket(device_id) {
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

    #[test]
    fn websocket_active_suppresses_delivery_path() {
        let r = PushTokenRegistry::new();
        r.register(make_record("dev-1"));
        r.note_websocket_open("dev-1");
        assert!(r.has_websocket("dev-1"));
        r.note_websocket_close("dev-1");
        assert!(!r.has_websocket("dev-1"));
    }

    #[test]
    fn ws_open_close_count_is_balanced() {
        let r = PushTokenRegistry::new();
        r.note_websocket_open("dev-1");
        r.note_websocket_open("dev-1");
        r.note_websocket_close("dev-1");
        assert!(r.has_websocket("dev-1"));
        r.note_websocket_close("dev-1");
        assert!(!r.has_websocket("dev-1"));
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
        r.register(make_record("dev-1"));
        r.note_websocket_open("dev-1");
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
        assert!(matches!(outcome, DeliveryOutcome::SuppressedWebsocketActive));
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
}
