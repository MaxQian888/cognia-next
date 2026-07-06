//! Phase D — DataPlane: the abstraction every message / session RPC arm
//! uses to read or mutate the canonical store.
//!
//! Two variants:
//!
//! - `TauriBridge` — the existing flow. Emits a `companion://*-request`
//!   Tauri event the desktop WebView listens for, then awaits a oneshot
//!   resolution via the `companion_message_response` Tauri command. The
//!   authoritative store is the WebView's Dexie database.
//!
//! - `Direct(Arc<dyn AppStore>)` — the headless flow. Calls the store
//!   directly. The server IS the canonical store.
//!
//! Each `DataPlane` method returns `serde_json::Value` because that's the
//! shape the RPC handler ultimately serializes — keeping the return type
//! uniform avoids forcing the handler to branch on the variant.
//!
//! # Selection
//!
//! [`DataPlane::pick`] resolves in this order (ADR-0059 D3 — the brain owns
//! the data; the SQLite `AppStore` is a degraded fallback, not a
//! destination):
//!
//! 1. A **connected headless brain** (`ws_bridge` socket transport) — its
//!    Dexie is the canonical store.
//! 2. The **desktop WebView** (`AppHandle` present) — today's flow.
//! 3. The **headless `AppStore`** installed via [`install_headless_store`]
//!    by the `cognia-server` binary at boot — serves degraded reads/writes
//!    while the brain is down or restarting.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde_json::{json, Value};

use super::{
    bridge_transport::{BridgeTransport, WebViewBridgeTransport},
    desktop_messages_bridge::DesktopMessagesBridge,
    store::AppStore,
    SharedState,
};

/// Process-wide store for the headless `AppStore`. When `Some`, every RPC
/// dispatch picks the `Direct` variant. When `None`, falls back to the
/// Tauri bridge.
static HEADLESS_STORE: RwLock<Option<Arc<dyn AppStore>>> = RwLock::new(None);

/// Install (or clear with `None`) the headless `AppStore`. Called by the
/// `cognia-server` binary at boot. Idempotent.
pub fn install_headless_store(store: Option<Arc<dyn AppStore>>) {
    *HEADLESS_STORE.write() = store;
}

pub fn headless_store() -> Option<Arc<dyn AppStore>> {
    HEADLESS_STORE.read().clone()
}

/// Dispatch target for one RPC invocation.
pub enum DataPlane {
    /// Round-trip through a bridge to whichever process hosts the brain. On
    /// desktop the transport is a [`WebViewBridgeTransport`] (today's flow); a
    /// later slice swaps in a socket transport for the headless brain.
    Bridge {
        bridge: Arc<DesktopMessagesBridge>,
        transport: Arc<dyn BridgeTransport>,
    },
    Direct(Arc<dyn AppStore>),
}

impl DataPlane {
    /// Resolve the right variant given the current process state. See the
    /// module docs for the ordering rationale (connected brain → WebView →
    /// degraded store).
    pub fn pick(state: &SharedState) -> Option<Self> {
        if let Some(socket) = super::ws_bridge::socket_bridge_transport() {
            return Some(DataPlane::Bridge {
                bridge: Arc::clone(&state.desktop_messages_bridge),
                transport: socket,
            });
        }
        if let Some(app) = state.app_handle.as_ref() {
            return Some(DataPlane::Bridge {
                bridge: Arc::clone(&state.desktop_messages_bridge),
                transport: Arc::new(WebViewBridgeTransport(app.clone())),
            });
        }
        if let Some(store) = headless_store() {
            return Some(DataPlane::Direct(store));
        }
        None
    }

    pub async fn list_sessions(
        &self,
        limit: u32,
        offset: u32,
        before: Option<i64>,
    ) -> Result<Value, String> {
        match self {
            DataPlane::Bridge { bridge, transport } => {
                Arc::clone(bridge)
                    .list_sessions(transport.as_ref(), limit, offset, before, DEFAULT_TIMEOUT)
                    .await
            }
            DataPlane::Direct(store) => {
                let page = store
                    .list_sessions(limit, offset, before)
                    .await
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(page).map_err(|e| e.to_string())
            }
        }
    }

    pub async fn get_messages_by_session(
        &self,
        session_id: String,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Value, String> {
        match self {
            DataPlane::Bridge { bridge, transport } => {
                Arc::clone(bridge)
                    .get_messages_by_session(
                        transport.as_ref(),
                        session_id,
                        limit,
                        offset,
                        DEFAULT_TIMEOUT,
                    )
                    .await
            }
            DataPlane::Direct(store) => {
                let page = store
                    .get_messages_by_session(&session_id, limit, offset)
                    .await
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(page).map_err(|e| e.to_string())
            }
        }
    }

    pub async fn send_message(
        &self,
        session_id: String,
        content: String,
        role: Option<String>,
    ) -> Result<Value, String> {
        match self {
            DataPlane::Bridge { bridge, transport } => {
                Arc::clone(bridge)
                    .send_message(
                        transport.as_ref(),
                        session_id,
                        content,
                        role,
                        DEFAULT_TIMEOUT,
                    )
                    .await
            }
            DataPlane::Direct(store) => {
                let role = role.as_deref().unwrap_or("user");
                let normalized = if role == "assistant" {
                    "assistant"
                } else {
                    "user"
                };
                let row = store
                    .create_message(&session_id, &content, normalized)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({ "message_id": row.id }))
            }
        }
    }

    pub async fn update_message(
        &self,
        session_id: String,
        message_id: String,
        updates: Value,
    ) -> Result<Value, String> {
        match self {
            DataPlane::Bridge { bridge, transport } => {
                Arc::clone(bridge)
                    .update_message(
                        transport.as_ref(),
                        session_id,
                        message_id,
                        updates,
                        DEFAULT_TIMEOUT,
                    )
                    .await
            }
            DataPlane::Direct(store) => {
                // Direct path only honors content updates today. Other fields
                // (role, attachments, etc.) need follow-up store methods.
                let content = updates
                    .get("content")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        "headless update_message currently requires `content` only".to_string()
                    })?;
                store
                    .update_message_content(&message_id, content)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
        }
    }

    pub async fn delete_message(
        &self,
        session_id: String,
        message_id: String,
    ) -> Result<Value, String> {
        match self {
            DataPlane::Bridge { bridge, transport } => Arc::clone(bridge)
                .delete_message(transport.as_ref(), session_id, message_id, DEFAULT_TIMEOUT)
                .await
                .map(|_| Value::Null),
            DataPlane::Direct(store) => {
                store
                    .delete_message(&message_id)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
        }
    }
}

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::store::sqlite::SqliteAppStore;
    use crate::companion_api::ws_bridge::test_support::{
        clear_socket_for_testing, install_socket_for_testing, lock_slot,
    };

    fn test_state() -> SharedState {
        use crate::companion_api::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache,
            CompanionState,
        };
        Arc::new(CompanionState {
            secret: RwLock::new(vec![0u8; 32]),
            redemption_lru: crate::companion_api::redemption_lru::RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        })
    }

    #[tokio::test]
    async fn install_and_uninstall_headless_store() {
        let _guard = lock_slot().await;
        let store = SqliteAppStore::in_memory().expect("open");
        install_headless_store(Some(store.clone() as Arc<dyn AppStore>));
        assert!(headless_store().is_some());
        install_headless_store(None);
        assert!(headless_store().is_none());
    }

    // ── pick ordering (ADR-0059 D3 / R4) ─────────────────────────────────────

    #[tokio::test]
    async fn pick_prefers_the_connected_brain_over_the_degraded_store() {
        let _guard = lock_slot().await;
        let state = test_state();
        let store = SqliteAppStore::in_memory().expect("open");
        install_headless_store(Some(store as Arc<dyn AppStore>));
        let _rx = install_socket_for_testing();

        match DataPlane::pick(&state) {
            Some(DataPlane::Bridge { transport, .. }) => {
                assert_eq!(transport.kind(), "socket", "connected brain must win");
            }
            Some(DataPlane::Direct(_)) => panic!("store must not shadow a connected brain"),
            None => panic!("expected a data plane"),
        }

        clear_socket_for_testing();
        install_headless_store(None);
    }

    #[tokio::test]
    async fn pick_falls_back_to_the_store_when_no_brain_is_connected() {
        let _guard = lock_slot().await;
        let state = test_state();
        clear_socket_for_testing();
        let store = SqliteAppStore::in_memory().expect("open");
        install_headless_store(Some(store as Arc<dyn AppStore>));

        assert!(
            matches!(DataPlane::pick(&state), Some(DataPlane::Direct(_))),
            "brain down ⇒ degraded store serves"
        );

        install_headless_store(None);
    }

    /// Desktop regression: with no socket and no store, an app_handle-less
    /// state yields None — i.e. nothing shadows the WebView branch on a
    /// desktop where `app_handle` is `Some` (an `AppHandle` itself can't be
    /// constructed in unit tests).
    #[tokio::test]
    async fn pick_returns_none_with_no_brain_no_webview_no_store() {
        let _guard = lock_slot().await;
        let state = test_state();
        clear_socket_for_testing();
        install_headless_store(None);
        assert!(DataPlane::pick(&state).is_none());
    }

    #[tokio::test]
    async fn direct_path_round_trip() {
        let store = SqliteAppStore::in_memory().expect("open");
        let dp = DataPlane::Direct(store.clone() as Arc<dyn AppStore>);

        // Seed a session.
        store
            .upsert_session("s1", "Hello", "direct")
            .await
            .expect("upsert");

        let send = dp
            .send_message("s1".into(), "hi from phone".into(), Some("user".into()))
            .await
            .expect("send");
        let msg_id = send["message_id"].as_str().unwrap().to_string();

        let page = dp
            .get_messages_by_session("s1".into(), None, None)
            .await
            .expect("get");
        let rows = page["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["content"].as_str().unwrap(), "hi from phone");

        dp.update_message("s1".into(), msg_id.clone(), json!({ "content": "edited" }))
            .await
            .expect("update");
        let page = dp
            .get_messages_by_session("s1".into(), None, None)
            .await
            .expect("get-after");
        assert_eq!(
            page["rows"].as_array().unwrap()[0]["content"]
                .as_str()
                .unwrap(),
            "edited"
        );

        dp.delete_message("s1".into(), msg_id)
            .await
            .expect("delete");
        let page = dp
            .get_messages_by_session("s1".into(), None, None)
            .await
            .expect("get-after-del");
        assert!(page["rows"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn direct_path_list_sessions_renders_page_shape() {
        let store = SqliteAppStore::in_memory().expect("open");
        let dp = DataPlane::Direct(store.clone() as Arc<dyn AppStore>);

        store.upsert_session("a", "alpha", "direct").await.unwrap();
        let page = dp.list_sessions(10, 0, None).await.expect("list");
        assert_eq!(page["total"].as_u64().unwrap(), 1);
        assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn direct_path_update_without_content_errors() {
        let store = SqliteAppStore::in_memory().expect("open");
        let dp = DataPlane::Direct(store as Arc<dyn AppStore>);
        let err = dp
            .update_message("s".into(), "m".into(), json!({ "role": "assistant" }))
            .await
            .expect_err("should error");
        assert!(err.contains("content"));
    }
}
