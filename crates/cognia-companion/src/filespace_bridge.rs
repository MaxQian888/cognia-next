//! How the live file-share host reaches the app that holds a conversation
//! (ADR-0222 §7.2): the WebView on the desktop, the brain on a headless host.
//!
//! Two questions travel this way.
//!
//! - **Asset slices.** `/uploads` and `/artifacts` live in that app's
//!   IndexedDB. A WebDAV or SFTP read of one asks for one bounded slice over
//!   the channel session media uses (`DesktopMessagesBridge::filespace_asset`,
//!   answered by `companion_media_response`), so a large upload is streamed
//!   slice by slice and never buffered whole on either side.
//! - **Mount tables.** The host pulls a conversation's mounts when it needs
//!   them fresh (`DesktopMessagesBridge::filespace_mounts`, answered by
//!   `companion_message_response`): a grant created from a paired device, a
//!   resume, the minute maintenance.
//!
//! The desktop source is bound to the WebView once at startup; the headless
//! source resolves the brain on every call, because the brain reconnects and
//! may be an older build that does not answer these requests.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cognia_companion_bus::bridge_transport::BridgeTransport;
use cognia_companion_bus::desktop_messages_bridge::DesktopMessagesBridge;
use cognia_file_share::assets::AssetReader;
use cognia_file_share::mounts::{MountSource, SessionMountsInput};

/// How long one slice or one mount table may take. A slice is at most 4 MiB
/// read out of IndexedDB; a WebDAV client gives up long before a minute.
const TIMEOUT: Duration = Duration::from_secs(30);

enum Source {
    /// The desktop WebView.
    Fixed(Arc<dyn BridgeTransport>),
    /// Whichever headless brain is connected when the read arrives.
    Brain,
}

/// Reads FileSpace assets and mount tables through the renderer or brain
/// bridge.
pub struct BridgeFileSpaceSource {
    bridge: Arc<DesktopMessagesBridge>,
    source: Source,
    timeout: Duration,
}

impl BridgeFileSpaceSource {
    /// The desktop source: `bridge` must be the long-lived bridge the
    /// `companion_media_response` and `companion_message_response` commands
    /// resolve.
    pub fn webview(bridge: Arc<DesktopMessagesBridge>, transport: Arc<dyn BridgeTransport>) -> Self {
        Self {
            bridge,
            source: Source::Fixed(transport),
            timeout: TIMEOUT,
        }
    }

    /// The headless source: `bridge` must be the companion state's bridge,
    /// which the `/internal/bridge` socket resolves.
    pub fn brain(bridge: Arc<DesktopMessagesBridge>) -> Self {
        Self {
            bridge,
            source: Source::Brain,
            timeout: TIMEOUT,
        }
    }

    fn transport(&self) -> Result<Arc<dyn BridgeTransport>, String> {
        match &self.source {
            Source::Fixed(transport) => Ok(Arc::clone(transport)),
            Source::Brain => {
                let Some(socket) = super::ws_bridge::socket_bridge_transport() else {
                    return Err("the brain that holds this conversation's uploads and artifacts is not connected".into());
                };
                if !super::ws_bridge::brain_serves_filespace() {
                    return Err("the connected brain cannot serve conversation uploads and artifacts; upgrade it".into());
                }
                Ok(socket)
            }
        }
    }
}

#[async_trait]
impl AssetReader for BridgeFileSpaceSource {
    async fn read(
        &self,
        session_id: &str,
        mount_id: &str,
        source_id: &str,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>, String> {
        let transport = self.transport()?;
        Arc::clone(&self.bridge)
            .filespace_asset(
                transport.as_ref(),
                session_id.to_string(),
                mount_id.to_string(),
                source_id.to_string(),
                offset,
                length,
                self.timeout,
            )
            .await
    }
}

#[async_trait]
impl MountSource for BridgeFileSpaceSource {
    async fn session_mounts(&self, session_id: &str) -> Result<SessionMountsInput, String> {
        let transport = self.transport()?;
        let value = Arc::clone(&self.bridge)
            .filespace_mounts(transport.as_ref(), session_id.to_string(), self.timeout)
            .await?;
        serde_json::from_value(value).map_err(|error| format!("malformed mount table: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop_messages_bridge::{
        MediaBridgeResponse, MessageBridgeResponse, FILESPACE_ASSET_EVENT, FILESPACE_MOUNTS_EVENT,
    };
    use crate::ws_bridge::test_support::{
        clear_socket_for_testing, install_socket_with_capabilities_for_testing, lock_slot,
    };
    use crate::SharedState;
    use axum::extract::ws::Message;
    use serde_json::Value;

    fn test_state() -> SharedState {
        use crate::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache, CompanionState,
        };
        Arc::new(CompanionState {
            secret: parking_lot::RwLock::new(vec![0u8; 32]),
            deny_list: Arc::new(DenyList::new()),
            renderer: None,
            runtime: crate::runtime::unwired(),
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: crate::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge: DesktopMessagesBridge::new(),
            desktop_writes_bridge: crate::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::push::PushTokenRegistry::new(),
        })
    }

    fn payload_of(message: Message, event: &str) -> Value {
        let Message::Text(text) = message else {
            panic!("the bridge sends text frames");
        };
        let frame: Value = serde_json::from_str(&text).expect("a JSON frame");
        assert_eq!(frame["type"], "event");
        assert_eq!(frame["event"], event);
        frame["payload"].clone()
    }

    #[tokio::test]
    async fn a_headless_read_without_a_brain_says_so() {
        let _slot = lock_slot().await;
        clear_socket_for_testing();
        let state = test_state();
        let reader = BridgeFileSpaceSource::brain(Arc::clone(&state.desktop_messages_bridge));
        let error = reader.read("s1", "uploads", "a1", 0, 10).await.unwrap_err();
        assert!(error.contains("not connected"), "{error}");
    }

    #[tokio::test]
    async fn an_older_brain_is_refused_before_anything_is_sent() {
        let _slot = lock_slot().await;
        let state = test_state();
        let mut socket = install_socket_with_capabilities_for_testing(&state, &["media"]);
        let reader = BridgeFileSpaceSource::brain(Arc::clone(&state.desktop_messages_bridge));
        let error = reader.read("s1", "uploads", "a1", 0, 10).await.unwrap_err();
        assert!(error.contains("upgrade"), "{error}");
        assert!(socket.try_recv().is_err(), "no request reaches a brain that cannot answer it");
        clear_socket_for_testing();
    }

    #[tokio::test]
    async fn a_capable_brain_answers_one_slice() {
        let _slot = lock_slot().await;
        let state = test_state();
        let mut socket = install_socket_with_capabilities_for_testing(&state, &["media", "filespace"]);
        let reader = Arc::new(BridgeFileSpaceSource::brain(Arc::clone(&state.desktop_messages_bridge)));
        let read = tokio::spawn({
            let reader = Arc::clone(&reader);
            async move { reader.read("s1", "artifacts", "art-9", 4, 6).await }
        });
        let payload = payload_of(socket.recv().await.expect("a frame"), FILESPACE_ASSET_EVENT);
        assert_eq!(payload["kind"], "filespace_asset");
        assert_eq!(payload["sessionId"], "s1");
        assert_eq!(payload["mountId"], "artifacts");
        assert_eq!(payload["sourceId"], "art-9");
        assert_eq!(payload["offset"], 4);
        assert_eq!(payload["length"], 6);
        state.desktop_messages_bridge.resolve_media(MediaBridgeResponse {
            request_id: payload["requestId"].as_str().unwrap().to_string(),
            bytes: b"slice!".to_vec(),
            media_type: "application/octet-stream".into(),
            etag: None,
            error: None,
        });
        assert_eq!(read.await.unwrap().unwrap(), b"slice!");
        clear_socket_for_testing();
    }

    #[tokio::test]
    async fn a_capable_brain_answers_a_mount_table() {
        let _slot = lock_slot().await;
        let state = test_state();
        let mut socket = install_socket_with_capabilities_for_testing(&state, &["filespace"]);
        let source = Arc::new(BridgeFileSpaceSource::brain(Arc::clone(&state.desktop_messages_bridge)));
        let pull = tokio::spawn({
            let source = Arc::clone(&source);
            async move { source.session_mounts("s1").await }
        });
        let payload = payload_of(socket.recv().await.expect("a frame"), FILESPACE_MOUNTS_EVENT);
        assert_eq!(payload["kind"], "filespace_mounts");
        assert_eq!(payload["sessionId"], "s1");
        state.desktop_messages_bridge.resolve(MessageBridgeResponse {
            request_id: payload["requestId"].as_str().unwrap().to_string(),
            result: Some(serde_json::json!({
                "sessionId": "s1",
                "state": "active",
                "mounts": [{
                    "mountId": "uploads", "virtualPath": "/uploads", "backing": "dexie",
                    "writable": false, "status": "available"
                }],
                "assets": []
            })),
            error: None,
        });
        let input = pull.await.unwrap().unwrap();
        assert_eq!(input.session_id, "s1");
        assert_eq!(input.mounts.len(), 1);
        clear_socket_for_testing();
    }
}
