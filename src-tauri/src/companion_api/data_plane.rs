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

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use parking_lot::RwLock;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    bridge_transport::{BridgeTransport, WebViewBridgeTransport},
    desktop_messages_bridge::DesktopMessagesBridge,
    store::{AppStore, MessageRow, StoreError},
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

    /// Direct-store revision accessor used by the RPC layer to publish the
    /// same reconciliation event that the WebView-backed repository emits.
    pub async fn direct_transcript_revision(&self, session_id: &str) -> Option<u64> {
        match self {
            DataPlane::Direct(store) => store.transcript_revision(session_id).await.ok(),
            DataPlane::Bridge { .. } => None,
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

    pub async fn transcript_capabilities(&self) -> Result<Value, String> {
        match self {
            DataPlane::Bridge { bridge, transport } => {
                Arc::clone(bridge)
                    .transcript_capabilities(transport.as_ref(), DEFAULT_TIMEOUT)
                    .await
            }
            DataPlane::Direct(_) => Ok(json!({
                "version": 1,
                "maxTimelinePageSize": TRANSCRIPT_TIMELINE_PAGE_MAX,
                "maxTurnMessagePageSize": TRANSCRIPT_DETAIL_PAGE_MAX,
                "maxTurnMessagePageBytes": TRANSCRIPT_DETAIL_PAGE_BYTES,
                "maxSummaryBytes": TRANSCRIPT_SUMMARY_BYTES,
                "maxSummaryMediaRefs": 0,
                "mediaVariants": [],
            })),
        }
    }

    pub async fn session_timeline(
        &self,
        session_id: String,
        direction: Option<String>,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<Value, String> {
        match self {
            DataPlane::Bridge { bridge, transport } => {
                Arc::clone(bridge)
                    .session_timeline(
                        transport.as_ref(),
                        session_id,
                        direction,
                        cursor,
                        limit,
                        DEFAULT_TIMEOUT,
                    )
                    .await
            }
            DataPlane::Direct(store) => {
                direct_session_timeline(store.as_ref(), session_id, direction, cursor, limit).await
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn session_turn_messages(
        &self,
        session_id: String,
        turn_key: String,
        revision: u64,
        detail_revision: u64,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<Value, String> {
        match self {
            DataPlane::Bridge { bridge, transport } => {
                Arc::clone(bridge)
                    .session_turn_messages(
                        transport.as_ref(),
                        session_id,
                        turn_key,
                        revision,
                        detail_revision,
                        cursor,
                        limit,
                        DEFAULT_TIMEOUT,
                    )
                    .await
            }
            DataPlane::Direct(store) => {
                direct_session_turn_messages(
                    store.as_ref(),
                    session_id,
                    turn_key,
                    revision,
                    detail_revision,
                    cursor,
                    limit,
                )
                .await
            }
        }
    }

    pub async fn session_media(
        &self,
        session_id: String,
        hash: String,
        variant: String,
    ) -> Result<super::desktop_messages_bridge::MediaBridgeResponse, String> {
        match self {
            DataPlane::Bridge { bridge, transport } => {
                Arc::clone(bridge)
                    .session_media(
                        transport.as_ref(),
                        session_id,
                        hash,
                        variant,
                        DEFAULT_TIMEOUT,
                    )
                    .await
            }
            // The direct SQLite store has no binary media table and therefore
            // does not advertise transcript/media V1.
            DataPlane::Direct(_) => Err("MEDIA_NOT_FOUND".to_string()),
        }
    }
}

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const TRANSCRIPT_TIMELINE_PAGE_DEFAULT: u32 = 30;
const TRANSCRIPT_TIMELINE_PAGE_MAX: u32 = 100;
const TRANSCRIPT_DETAIL_PAGE_DEFAULT: u32 = 100;
const TRANSCRIPT_DETAIL_PAGE_MAX: u32 = 200;
const TRANSCRIPT_DETAIL_PAGE_BYTES: usize = 2 * 1024 * 1024;
const TRANSCRIPT_SUMMARY_BYTES: usize = 64 * 1024;
const TRANSCRIPT_PREVIEW_BYTES: usize = 24 * 1024;
const TRANSCRIPT_SCAN_CHUNK: u32 = 200;
const TRANSCRIPT_MAX_SCANNED_MESSAGES: usize = 2_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectTimelineCursor {
    version: u8,
    session_id: String,
    revision: u64,
    direction: String,
    position: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectDetailCursor {
    version: u8,
    session_id: String,
    revision: u64,
    turn_key: String,
    detail_revision: u64,
    position: u32,
}

fn encode_cursor<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_vec(value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| "INVALID_PARAMS".to_string())
}

fn decode_cursor<T: DeserializeOwned>(value: &str) -> Result<T, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "INVALID_PARAMS".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "INVALID_PARAMS".to_string())
}

fn store_session_revision_error(error: StoreError) -> String {
    match error {
        StoreError::NotFound(_) | StoreError::InvalidInput(_) => "INVALID_PARAMS".to_string(),
        StoreError::Sqlite(_) => "TRANSCRIPT_STORE_ERROR".to_string(),
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let boundary = value
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max_bytes)
        .last()
        .unwrap_or(0);
    (value[..boundary].to_string(), true)
}

fn direct_preview(message: &MessageRow) -> Value {
    let (text, truncated) = truncate_utf8(&message.content, TRANSCRIPT_PREVIEW_BYTES);
    json!({
        "id": message.id,
        "role": message.role,
        "text": text,
        "createdAt": message.created_at,
        "truncated": truncated,
    })
}

fn direct_full_message(message: &MessageRow, turn_key: &str) -> Value {
    json!({
        "id": message.id,
        "sessionId": message.session_id,
        "turnKey": turn_key,
        "role": message.role,
        "parts": [{ "type": "text", "text": message.content }],
        "createdAt": message.created_at,
    })
}

fn direct_completed_turn(turn_key: &str, messages: &[MessageRow], revision: u64) -> Value {
    let users: Vec<Value> = messages
        .iter()
        .filter(|message| message.role == "user")
        .map(direct_preview)
        .collect();
    let user_count = users.len();
    let final_response = messages
        .iter()
        .rev()
        .find(|message| message.role == "assistant");
    let final_index = final_response
        .and_then(|target| messages.iter().position(|message| message.id == target.id));
    let started_at = messages
        .first()
        .map(|message| message.created_at)
        .unwrap_or(0);
    let completed_at = messages
        .last()
        .map(|message| message.created_at)
        .unwrap_or(0);
    let mut item = json!({
        "kind": "completed-turn",
        "itemKey": turn_key,
        "turnKey": turn_key,
        "revision": revision,
        "detailRevision": revision,
        "status": "completed",
        "userMessages": users,
        "collapsed": {
            "exists": messages.len() > user_count + usize::from(final_response.is_some()),
            "messageCount": messages.len(),
            "trailingCount": final_index
                .map(|index| messages.len().saturating_sub(index + 1))
                .unwrap_or(0),
            "mediaCount": 0,
        },
        "startedAt": started_at,
        "completedAt": completed_at,
        "durationMs": completed_at.saturating_sub(started_at),
    });
    if let Some(response) = final_response {
        item["finalResponse"] = direct_preview(response);
    }
    item
}

fn project_direct_timeline(messages: &[MessageRow], revision: u64) -> Vec<Value> {
    let mut items = Vec::new();
    let mut current: Vec<MessageRow> = Vec::new();
    let mut current_key = String::new();

    let flush =
        |items: &mut Vec<Value>, current: &mut Vec<MessageRow>, current_key: &mut String| {
            if current.is_empty() {
                return;
            }
            items.push(direct_completed_turn(current_key, current, revision));
            current.clear();
            current_key.clear();
        };

    for message in messages {
        if message.role == "system" && current.is_empty() {
            items.push(json!({
                "kind": "system",
                "itemKey": format!("system:{}", message.id),
                "revision": revision,
                "status": "completed",
                "message": direct_preview(message),
                "startedAt": message.created_at,
                "completedAt": message.created_at,
                "durationMs": 0,
            }));
            continue;
        }
        if message.role == "user" && !current.is_empty() {
            flush(&mut items, &mut current, &mut current_key);
        }
        if current.is_empty() {
            current_key = format!("turn:{}", message.id);
        }
        current.push(message.clone());
    }
    flush(&mut items, &mut current, &mut current_key);
    items
}

async fn direct_session_timeline(
    store: &dyn AppStore,
    session_id: String,
    direction: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let direction = direction.unwrap_or_else(|| "backward".to_string());
    if direction != "backward" {
        return Err("INVALID_PARAMS".to_string());
    }
    let revision = store
        .transcript_revision(&session_id)
        .await
        .map_err(store_session_revision_error)?;
    let mut position = 0;
    if let Some(cursor) = cursor {
        let decoded: DirectTimelineCursor = decode_cursor(&cursor)?;
        if decoded.version != 1
            || decoded.session_id != session_id
            || decoded.direction != direction
        {
            return Err("INVALID_PARAMS".to_string());
        }
        if decoded.revision != revision {
            return Err("TRANSCRIPT_STALE".to_string());
        }
        position = decoded.position;
    }
    let limit = limit
        .unwrap_or(TRANSCRIPT_TIMELINE_PAGE_DEFAULT)
        .clamp(1, TRANSCRIPT_TIMELINE_PAGE_MAX);
    let mut descending = Vec::new();
    let mut user_boundaries = 0_u32;

    while user_boundaries < limit && descending.len() < TRANSCRIPT_MAX_SCANNED_MESSAGES {
        let page = store
            .get_messages_by_session_reverse(
                &session_id,
                TRANSCRIPT_SCAN_CHUNK,
                position.saturating_add(descending.len() as u32),
            )
            .await
            .map_err(|_| "TRANSCRIPT_STORE_ERROR".to_string())?;
        if page.rows.is_empty() {
            break;
        }
        let page_len = page.rows.len();
        for message in page.rows {
            if message.role == "user" {
                user_boundaries += 1;
            }
            descending.push(message);
            if user_boundaries >= limit || descending.len() >= TRANSCRIPT_MAX_SCANNED_MESSAGES {
                break;
            }
        }
        if page_len < TRANSCRIPT_SCAN_CHUNK as usize {
            break;
        }
    }

    let next_position = position.saturating_add(descending.len() as u32);
    let has_more = !store
        .get_messages_by_session_reverse(&session_id, 1, next_position)
        .await
        .map_err(|_| "TRANSCRIPT_STORE_ERROR".to_string())?
        .rows
        .is_empty();
    descending.reverse();
    let projected = project_direct_timeline(&descending, revision);
    let start = projected.len().saturating_sub(limit as usize);
    let items = projected[start..].to_vec();
    let next_cursor = if has_more {
        Some(encode_cursor(&DirectTimelineCursor {
            version: 1,
            session_id,
            revision,
            direction,
            position: next_position,
        })?)
    } else {
        None
    };
    let mut response = json!({
        "items": items,
        "revision": revision,
        "hasMore": has_more,
    });
    if let Some(next_cursor) = next_cursor {
        response["nextCursor"] = Value::String(next_cursor);
    }
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
async fn direct_session_turn_messages(
    store: &dyn AppStore,
    session_id: String,
    turn_key: String,
    revision: u64,
    detail_revision: u64,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let current_revision = store
        .transcript_revision(&session_id)
        .await
        .map_err(store_session_revision_error)?;
    if revision != current_revision || detail_revision != current_revision {
        return Err("TRANSCRIPT_STALE".to_string());
    }
    let anchor = turn_key
        .strip_prefix("turn:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "TURN_NOT_FOUND".to_string())?;
    let mut position = 0;
    if let Some(cursor) = cursor {
        let decoded: DirectDetailCursor = decode_cursor(&cursor)?;
        if decoded.version != 1 || decoded.session_id != session_id {
            return Err("INVALID_PARAMS".to_string());
        }
        if decoded.turn_key != turn_key {
            return Err("TURN_NOT_FOUND".to_string());
        }
        if decoded.revision != revision || decoded.detail_revision != detail_revision {
            return Err("TRANSCRIPT_STALE".to_string());
        }
        position = decoded.position;
    }
    let limit = limit
        .unwrap_or(TRANSCRIPT_DETAIL_PAGE_DEFAULT)
        .clamp(1, TRANSCRIPT_DETAIL_PAGE_MAX);
    let page = store
        .get_implicit_turn_messages(&session_id, anchor, limit, position)
        .await
        .map_err(|error| match error {
            StoreError::NotFound(_) => "TURN_NOT_FOUND".to_string(),
            _ => "TRANSCRIPT_STORE_ERROR".to_string(),
        })?;
    let total = page.total;
    let mut messages = Vec::new();
    let mut approximate_bytes = 2_usize;
    for row in page.rows {
        let message = direct_full_message(&row, &turn_key);
        let message_bytes = serde_json::to_vec(&message)
            .map_err(|_| "TRANSCRIPT_STORE_ERROR".to_string())?
            .len()
            + 1;
        if messages.is_empty() && message_bytes > TRANSCRIPT_DETAIL_PAGE_BYTES {
            return Err("INVALID_PARAMS".to_string());
        }
        if !messages.is_empty()
            && approximate_bytes.saturating_add(message_bytes) > TRANSCRIPT_DETAIL_PAGE_BYTES
        {
            break;
        }
        approximate_bytes = approximate_bytes.saturating_add(message_bytes);
        messages.push(message);
    }
    let next_position = position.saturating_add(messages.len() as u32);
    let has_more = next_position < total;
    let next_cursor = if has_more {
        Some(encode_cursor(&DirectDetailCursor {
            version: 1,
            session_id,
            revision,
            turn_key,
            detail_revision,
            position: next_position,
        })?)
    } else {
        None
    };
    let mut response = json!({
        "messages": messages,
        "revision": revision,
        "detailRevision": detail_revision,
        "total": total,
        "approximateBytes": approximate_bytes,
        "hasMore": has_more,
    });
    if let Some(next_cursor) = next_cursor {
        response["nextCursor"] = Value::String(next_cursor);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::store::sqlite::SqliteAppStore;
    use crate::companion_api::ws_bridge::test_support::{
        clear_socket_for_testing, install_socket_for_testing, lock_slot,
    };

    fn test_state() -> SharedState {
        use crate::companion_api::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache, CompanionState,
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

    #[tokio::test]
    async fn direct_store_serves_bounded_transcript_v1_pages() {
        let store = SqliteAppStore::in_memory().expect("open");
        store
            .upsert_session("s1", "Transcript", "direct")
            .await
            .unwrap();
        store.create_message("s1", "first", "user").await.unwrap();
        store
            .create_message("s1", "answer", "assistant")
            .await
            .unwrap();
        store.create_message("s1", "second", "user").await.unwrap();
        store
            .create_message("s1", "done", "assistant")
            .await
            .unwrap();
        let dp = DataPlane::Direct(store as Arc<dyn AppStore>);

        let capabilities = dp.transcript_capabilities().await.unwrap();
        assert_eq!(capabilities["version"], 1);

        let newest = dp
            .session_timeline("s1".into(), None, None, Some(1))
            .await
            .unwrap();
        assert_eq!(newest["items"].as_array().unwrap().len(), 1);
        assert_eq!(newest["items"][0]["finalResponse"]["text"], "done");
        assert_eq!(newest["hasMore"], true);
        let cursor = newest["nextCursor"].as_str().unwrap().to_string();

        let older = dp
            .session_timeline("s1".into(), None, Some(cursor), Some(1))
            .await
            .unwrap();
        assert_eq!(older["items"][0]["finalResponse"]["text"], "answer");
        assert_eq!(older["hasMore"], false);
    }

    #[tokio::test]
    async fn direct_store_turn_detail_is_revision_bound_and_byte_budgeted() {
        let store = SqliteAppStore::in_memory().expect("open");
        store
            .upsert_session("s1", "Transcript", "direct")
            .await
            .unwrap();
        let user = store
            .create_message("s1", "question", "user")
            .await
            .unwrap();
        store
            .create_message("s1", "answer", "assistant")
            .await
            .unwrap();
        let dp = DataPlane::Direct(store.clone() as Arc<dyn AppStore>);
        let timeline = dp
            .session_timeline("s1".into(), None, None, Some(1))
            .await
            .unwrap();
        let revision = timeline["revision"].as_u64().unwrap();
        let turn_key = format!("turn:{}", user.id);

        let detail = dp
            .session_turn_messages(
                "s1".into(),
                turn_key.clone(),
                revision,
                revision,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(detail["messages"].as_array().unwrap().len(), 2);
        assert!(detail["approximateBytes"].as_u64().unwrap() <= 2 * 1024 * 1024);

        store
            .update_message_content(&user.id, "edited")
            .await
            .unwrap();
        assert_eq!(
            dp.session_turn_messages("s1".into(), turn_key, revision, revision, None, None,)
                .await
                .unwrap_err(),
            "TRANSCRIPT_STALE"
        );
    }
}
