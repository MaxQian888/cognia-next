use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

use super::axum_app::{AppHandleEmitter, EventEmitter};
use super::server_lifecycle::{start_server, ServerHandle};
use super::state::ConnectorsState;
use super::types::{AdapterRegistration, ConnectorsHealth, TauriHttpRequest, TauriHttpResponse};

// ---------------------------------------------------------------------------
// Task 19 — basic adapter registry commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn connectors_register_adapter(
    state: State<'_, ConnectorsState>,
    reg: AdapterRegistration,
) -> Result<(), String> {
    let mut inner = state.inner.lock();
    inner
        .registered_adapters
        .insert(reg.adapter_id.clone(), reg);
    Ok(())
}

#[tauri::command]
pub async fn connectors_unregister_adapter(
    state: State<'_, ConnectorsState>,
    adapter_id: String,
) -> Result<(), String> {
    let mut inner = state.inner.lock();
    inner.registered_adapters.remove(&adapter_id);
    Ok(())
}

#[tauri::command]
pub async fn connectors_health(
    state: State<'_, ConnectorsState>,
) -> Result<ConnectorsHealth, String> {
    let inner = state.inner.lock();
    Ok(ConnectorsHealth {
        server_running: inner.server_running,
        bound_addr: inner.bound_addr.clone(),
        registered_adapter_count: inner.registered_adapters.len(),
    })
}

// ---------------------------------------------------------------------------
// Single-owner runtime lease
// ---------------------------------------------------------------------------
//
// The same three operations the companion dispatcher exposes over RPC, bound
// to the SAME `ConnectorsState` this app manages. The desktop webview cannot
// reach the RPC surface (it speaks Tauri IPC, not its own companion HTTP), so
// without these it could not contend at all — and a brain process attached to
// this desktop's companion would happily boot a second copy of every bot.
//
// Owner ids carry their class as a prefix (`desktop:` / `brain:`); an
// always-on brain reserves an acknowledged handoff from a desktop holder. See
// `state::runtime_owner_class`.

#[tauri::command]
pub async fn connectors_runtime_lease_acquire(
    state: State<'_, ConnectorsState>,
    owner_id: String,
    ttl_ms: u64,
    handoff_aware: Option<bool>,
) -> Result<serde_json::Value, String> {
    if handoff_aware.unwrap_or(false) {
        let outcome = state.acquire_runtime_lease_outcome(&owner_id, ttl_ms)?;
        Ok(serde_json::Value::String(outcome.as_str().to_string()))
    } else {
        // Legacy callers cannot acknowledge a handoff, so their boolean claim
        // is intentionally non-preemptive and has no effect on a live holder.
        state
            .acquire_runtime_lease(&owner_id, ttl_ms)
            .map(serde_json::Value::Bool)
    }
}

#[tauri::command]
pub async fn connectors_runtime_lease_renew(
    state: State<'_, ConnectorsState>,
    owner_id: String,
    ttl_ms: u64,
) -> Result<bool, String> {
    state.renew_runtime_lease(&owner_id, ttl_ms)
}

#[tauri::command]
pub async fn connectors_runtime_lease_release(
    state: State<'_, ConnectorsState>,
    owner_id: String,
) -> Result<bool, String> {
    state.release_runtime_lease(&owner_id)
}

// ---------------------------------------------------------------------------
// Task 20 — server lifecycle commands
// ---------------------------------------------------------------------------

/// Tauri-managed wrapper around the live server handle (async mutex because
/// the handle is held across async commands).
pub struct ConnectorsServer(pub Arc<AsyncMutex<Option<ServerHandle>>>);

#[tauri::command]
pub async fn connectors_start_server(
    app: AppHandle,
    state: State<'_, ConnectorsState>,
    server: State<'_, ConnectorsServer>,
    port: u16,
    bind_loopback_only: bool,
) -> Result<String, String> {
    let mut handle_lock = server.0.lock().await;
    if handle_lock.is_some() {
        return Err("connectors server already running".into());
    }
    let ip = if bind_loopback_only {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    };
    let emitter: Arc<dyn EventEmitter> = Arc::new(AppHandleEmitter(app));
    let handle = start_server(state.inner_state(), SocketAddr::new(ip, port), emitter).await?;
    let bound = handle.bound_addr.to_string();
    *handle_lock = Some(handle);
    Ok(bound)
}

/// Start the loopback server if it is not already up, and return the bound
/// address either way.
///
/// `connectors_start_server` deliberately errors when a server is already
/// running — it is the boot path, and a second boot means a lifecycle bug. But
/// the remote-document OAuth flow (ADR-0134) needs a *guarantee* that the
/// loopback listener exists for the duration of a Google consent round-trip,
/// and it has no way to know whether a webhook adapter already started one. So
/// it asks for the address instead of the transition, and never learns which
/// of the two happened.
///
/// Always binds loopback-only: an OAuth redirect target has no business being
/// reachable off-box.
#[tauri::command]
pub async fn connectors_ensure_server(
    app: AppHandle,
    state: State<'_, ConnectorsState>,
    server: State<'_, ConnectorsServer>,
    port: u16,
) -> Result<String, String> {
    let mut handle_lock = server.0.lock().await;
    if let Some(handle) = handle_lock.as_ref() {
        return Ok(handle.bound_addr.to_string());
    }
    let emitter: Arc<dyn EventEmitter> = Arc::new(AppHandleEmitter(app));
    let handle = start_server(
        state.inner_state(),
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        emitter,
    )
    .await?;
    let bound = handle.bound_addr.to_string();
    *handle_lock = Some(handle);
    Ok(bound)
}

#[tauri::command]
pub async fn connectors_stop_server(
    state: State<'_, ConnectorsState>,
    server: State<'_, ConnectorsServer>,
) -> Result<(), String> {
    let mut handle_lock = server.0.lock().await;
    if let Some(h) = handle_lock.take() {
        h.shutdown().await;
    }
    {
        let mut inner = state.inner.lock();
        inner.server_running = false;
        inner.bound_addr = None;
    }
    Ok(())
}

/// Reap every live connector WS / Lark long-connection socket. Returns the
/// total number closed.
///
/// A webview hard reload (Ctrl+R / Fast-Refresh full reload / crash) discards
/// the renderer without running its JS cleanup, so the `adapter.stop()` that
/// would call `connectors_ws_close` / `connectors_lark_ws_close` never fires.
/// The Rust core process survives the reload, so those sockets — and Lark's
/// self-reconnect loop — leak and keep delivering duplicate inbound events.
/// The connector bootstrap calls this ONCE before opening any adapter so the
/// previous load's leaked sockets are reaped first.
#[tauri::command]
pub async fn connectors_reset_all_ws() -> Result<u32, String> {
    // Piggyback the attachment raw-cache cleanup on this once-per-boot reset:
    // the plaintext copies decrypted for the previous session's webview are
    // reaped before any adapter re-fetches (see the attachments.rs module
    // header for the remaining exposure window). Best-effort — a cleanup
    // failure must not block the WS reset.
    match tokio::task::spawn_blocking(super::attachments::cleanup_raw_attachment_cache).await {
        Ok(Ok(removed)) => {
            if removed > 0 {
                log::debug!("connectors bootstrap: removed {removed} raw attachment cache files");
            }
        }
        Ok(Err(e)) => log::warn!("connectors bootstrap: raw attachment cache cleanup failed: {e}"),
        Err(e) => log::warn!("connectors bootstrap: raw attachment cleanup task failed: {e}"),
    }

    let generic = super::ws_client::close_all().await;
    let lark = super::lark_ws::close_all();
    Ok((generic + lark) as u32)
}

// ---------------------------------------------------------------------------
// Task 21 — keyring commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn connectors_keyring_set(
    adapter_id: String,
    credential: String,
    value: String,
) -> Result<(), String> {
    super::keyring::set(&adapter_id, &credential, &value)
}

#[tauri::command]
pub async fn connectors_keyring_get(
    adapter_id: String,
    credential: String,
) -> Result<Option<String>, String> {
    super::keyring::get(&adapter_id, &credential)
}

#[tauri::command]
pub async fn connectors_keyring_delete(
    adapter_id: String,
    credential: String,
) -> Result<(), String> {
    super::keyring::delete(&adapter_id, &credential)
}

#[tauri::command]
pub async fn connectors_keyring_list(
    adapter_id: String,
    accounts: Vec<String>,
) -> Result<Vec<String>, String> {
    super::keyring::list(&adapter_id, &accounts)
}

// ---------------------------------------------------------------------------
// Task 22 — outbound HTTP client command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn connectors_http_request(req: TauriHttpRequest) -> Result<TauriHttpResponse, String> {
    super::http_client::http_request(req).await
}

// ---------------------------------------------------------------------------
// Task 23 — WebSocket client commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn connectors_ws_open(
    app: tauri::AppHandle,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    let emitter = std::sync::Arc::new(super::axum_app::AppHandleEmitter(app));
    super::ws_client::open_ws(emitter, url, headers).await
}

#[tauri::command]
pub async fn connectors_ws_send(handle_id: String, data: String) -> Result<(), String> {
    let _perf = cognia_instrument::guard("connector.ws_send");
    super::ws_client::ws_send(&handle_id, data).await
}

#[tauri::command]
pub async fn connectors_ws_close(handle_id: String) -> Result<(), String> {
    super::ws_client::ws_close(&handle_id).await
}

#[tauri::command]
pub async fn connectors_onebot_send(adapter_id: String, call_json: String) -> Result<(), String> {
    super::ws_server::send(&adapter_id, call_json).await
}

// ---------------------------------------------------------------------------
// Lark long-connection (protobuf-framed WS) — dedicated client because the
// generic `connectors_ws_*` passthrough can't decode Feishu's binary frames.
// Credentials are read from the keyring inside Rust (mirrors the webhook path)
// so App Secret never crosses the IPC boundary.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn connectors_lark_ws_open(
    app: tauri::AppHandle,
    adapter_id: String,
) -> Result<String, String> {
    let emitter = std::sync::Arc::new(super::axum_app::AppHandleEmitter(app));
    super::lark_ws::open(emitter, adapter_id).await
}

#[tauri::command]
pub async fn connectors_lark_ws_close(handle_id: String) -> Result<(), String> {
    super::lark_ws::close(&handle_id).await
}

// ---------------------------------------------------------------------------
// OneBot reverse-WS live-client probe (ADR-0036 follow-up)
//
// Reverse-WS adapters give no inbound signal that the QQ client is up other
// than the live socket itself. This probe surfaces the in-memory registry the
// WS server maintains so the OneBot settings UI can show which adapters have a
// client dialed in (and since when).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn connectors_onebot_probe() -> Result<Vec<super::types::OneBotLiveClient>, String> {
    Ok(super::ws_server::live_clients())
}

// ---------------------------------------------------------------------------
// Task 24 — attachment cache command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn connectors_attachment_fetch(
    adapter_id: String,
    remote_ref: String,
    source_url: String,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<super::attachments::AttachmentRef, String> {
    super::attachments::fetch_attachment(adapter_id, remote_ref, source_url, headers).await
}

/// Read a cached attachment's plaintext as base64 (None when uncached or
/// larger than `max_bytes`). Renderer-side inlining (e.g. Matrix small-image
/// vision path) uses this instead of raw filesystem access — the webview's fs
/// scope does not cover the connector cache dir.
#[tauri::command]
pub async fn connectors_attachment_read(
    adapter_id: String,
    remote_ref: String,
    max_bytes: u64,
) -> Result<Option<String>, String> {
    super::attachments::read_attachment_base64(&adapter_id, &remote_ref, max_bytes)
}

#[tauri::command]
pub async fn connectors_media_upload(
    req: super::types::ConnectorMediaUploadRequest,
) -> Result<String, String> {
    super::media_upload::upload_media(req).await
}

#[tauri::command]
pub async fn connectors_matrix_encrypted_media_upload(
    req: super::types::MatrixEncryptedMediaUploadRequest,
) -> Result<super::types::MatrixEncryptedMediaUploadResponse, String> {
    super::media_upload::upload_matrix_encrypted_media(req).await
}

#[tauri::command]
pub async fn connectors_matrix_encrypted_media_fetch(
    req: super::types::MatrixEncryptedMediaFetchRequest,
) -> Result<super::attachments::AttachmentRef, String> {
    super::attachments::fetch_matrix_encrypted_attachment(req).await
}

/// Discord multipart media upload — fetch each source URL and POST the bytes as
/// `multipart/form-data` to `/channels/{id}/messages`, returning the created
/// message id. Handles voice messages via the IS_VOICE_MESSAGE flag.
#[tauri::command]
pub async fn connectors_discord_upload(
    req: super::discord_upload::ConnectorDiscordUploadRequest,
) -> Result<String, String> {
    super::discord_upload::upload(req).await
}

#[tauri::command]
pub async fn connectors_matrix_crypto_init(
    req: super::matrix_crypto::MatrixCryptoInitRequest,
) -> Result<(), String> {
    super::matrix_crypto::matrix_crypto_init(req).await
}

#[tauri::command]
pub async fn connectors_matrix_crypto_close(adapter_id: String) -> Result<(), String> {
    super::matrix_crypto::matrix_crypto_close(&adapter_id).await
}

#[tauri::command]
pub async fn connectors_matrix_crypto_outgoing_requests(
    adapter_id: String,
) -> Result<Vec<super::matrix_crypto::MatrixCryptoOutgoingRequest>, String> {
    super::matrix_crypto::matrix_crypto_outgoing_requests(adapter_id).await
}

#[tauri::command]
pub async fn connectors_matrix_crypto_mark_request_sent(
    req: super::matrix_crypto::MatrixCryptoMarkSentRequest,
) -> Result<(), String> {
    super::matrix_crypto::matrix_crypto_mark_request_sent(req).await
}

#[tauri::command]
pub async fn connectors_matrix_crypto_receive_sync_changes(
    req: super::matrix_crypto::MatrixCryptoReceiveSyncRequest,
) -> Result<(), String> {
    super::matrix_crypto::matrix_crypto_receive_sync_changes(req).await
}

#[tauri::command]
pub async fn connectors_matrix_crypto_decrypt_event(
    req: super::matrix_crypto::MatrixCryptoDecryptRequest,
) -> Result<super::matrix_crypto::MatrixCryptoDecryptResponse, String> {
    super::matrix_crypto::matrix_crypto_decrypt_event(req).await
}

#[tauri::command]
pub async fn connectors_matrix_crypto_encrypt_event(
    req: super::matrix_crypto::MatrixCryptoEncryptRequest,
) -> Result<super::matrix_crypto::MatrixCryptoEncryptResponse, String> {
    super::matrix_crypto::matrix_crypto_encrypt_event(req).await
}

#[tauri::command]
pub async fn connectors_matrix_crypto_share_room_key(
    req: super::matrix_crypto::MatrixCryptoShareRoomKeyRequest,
) -> Result<Vec<super::matrix_crypto::MatrixCryptoOutgoingRequest>, String> {
    super::matrix_crypto::matrix_crypto_share_room_key(req).await
}

#[tauri::command]
pub async fn connectors_matrix_crypto_update_tracked_users(
    req: super::matrix_crypto::MatrixCryptoTrackUsersRequest,
) -> Result<(), String> {
    super::matrix_crypto::matrix_crypto_update_tracked_users(req).await
}

#[tauri::command]
pub async fn connectors_matrix_crypto_get_missing_sessions(
    req: super::matrix_crypto::MatrixCryptoMissingSessionsRequest,
) -> Result<Vec<super::matrix_crypto::MatrixCryptoOutgoingRequest>, String> {
    super::matrix_crypto::matrix_crypto_get_missing_sessions(req).await
}

// ---------------------------------------------------------------------------
// Lark media upload — voice / video / file / image
//
// The TS adapter caches the tenant access token (`lark/auth.ts`) and passes
// it here; this command does the URL fetch + multipart POST to Lark in one
// round-trip and returns the opaque `file_key` / `image_key`.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn connectors_lark_upload_file(
    access_token: String,
    source_url: String,
    file_type: String,
    file_name: String,
    duration_ms: Option<u64>,
) -> Result<String, String> {
    super::lark_upload::upload_file(
        &access_token,
        &source_url,
        &file_type,
        &file_name,
        duration_ms,
    )
    .await
}

#[tauri::command]
pub async fn connectors_lark_upload_image(
    access_token: String,
    source_url: String,
    image_type: Option<String>,
) -> Result<String, String> {
    super::lark_upload::upload_image(&access_token, &source_url, image_type.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use wiremock::matchers::{body_bytes, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn connectors_reset_all_ws_command_runs_without_live_handles() {
        super::super::ws_client::close_all().await;
        super::super::lark_ws::close_all();

        let _closed = connectors_reset_all_ws().await.unwrap();
    }

    #[tokio::test]
    async fn connectors_media_upload_posts_local_bytes_and_returns_content_uri() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/media/v3/upload"))
            .and(header("authorization", "Bearer tok"))
            .and(header("content-type", "image/png"))
            .and(body_bytes(vec![1u8, 2, 3]))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "content_uri": "mxc://matrix.org/up" })),
            )
            .expect(1)
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pic.png");
        std::fs::write(&path, [1u8, 2, 3]).unwrap();
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), "Bearer tok".to_string());

        let content_uri =
            connectors_media_upload(super::super::types::ConnectorMediaUploadRequest {
                upload_url: format!("{}/_matrix/media/v3/upload", mock_server.uri()),
                headers: Some(headers),
                source_url: None,
                local_path: Some(path.to_string_lossy().into_owned()),
                content_type: Some("image/png".to_string()),
            })
            .await
            .unwrap();

        assert_eq!(content_uri, "mxc://matrix.org/up");
        mock_server.verify().await;
    }
}
