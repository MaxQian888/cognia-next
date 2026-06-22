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
//! [`pick`] returns the appropriate variant based on whether a headless
//! `AppStore` has been installed via [`install_headless_store`]. The
//! `cognia-server` binary calls `install_headless_store` at boot before
//! spawning the axum server.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde_json::{json, Value};
use tauri::AppHandle;

use super::{desktop_messages_bridge::DesktopMessagesBridge, store::AppStore, SharedState};

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
    TauriBridge {
        bridge: Arc<DesktopMessagesBridge>,
        app: AppHandle,
    },
    Direct(Arc<dyn AppStore>),
}

impl DataPlane {
    /// Resolve the right variant given the current process state.
    pub fn pick(state: &SharedState) -> Option<Self> {
        if let Some(store) = headless_store() {
            return Some(DataPlane::Direct(store));
        }
        if let Some(app) = state.app_handle.as_ref() {
            return Some(DataPlane::TauriBridge {
                bridge: Arc::clone(&state.desktop_messages_bridge),
                app: app.clone(),
            });
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
            DataPlane::TauriBridge { bridge, app } => {
                Arc::clone(bridge)
                    .list_sessions(app, limit, offset, before, DEFAULT_TIMEOUT)
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
            DataPlane::TauriBridge { bridge, app } => {
                Arc::clone(bridge)
                    .get_messages_by_session(app, session_id, limit, offset, DEFAULT_TIMEOUT)
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
            DataPlane::TauriBridge { bridge, app } => {
                Arc::clone(bridge)
                    .send_message(app, session_id, content, role, DEFAULT_TIMEOUT)
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
            DataPlane::TauriBridge { bridge, app } => {
                Arc::clone(bridge)
                    .update_message(app, session_id, message_id, updates, DEFAULT_TIMEOUT)
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
            DataPlane::TauriBridge { bridge, app } => Arc::clone(bridge)
                .delete_message(app, session_id, message_id, DEFAULT_TIMEOUT)
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

    #[tokio::test]
    async fn install_and_uninstall_headless_store() {
        let store = SqliteAppStore::in_memory().expect("open");
        install_headless_store(Some(store.clone() as Arc<dyn AppStore>));
        assert!(headless_store().is_some());
        install_headless_store(None);
        assert!(headless_store().is_none());
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
