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
    inner.registered_adapters.insert(reg.adapter_id.clone(), reg);
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
    let app_for_bridge = app.clone();
    let emitter: Arc<dyn EventEmitter> = Arc::new(AppHandleEmitter(app));
    let handle = start_server(
        state.inner_state(),
        SocketAddr::new(ip, port),
        emitter,
        Some(app_for_bridge),
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
    super::ws_client::open_ws(app, url, headers).await
}

#[tauri::command]
pub async fn connectors_ws_send(handle_id: String, data: String) -> Result<(), String> {
    let _perf = crate::perf::guard("connector.ws_send");
    super::ws_client::ws_send(&handle_id, data).await
}

#[tauri::command]
pub async fn connectors_ws_close(handle_id: String) -> Result<(), String> {
    super::ws_client::ws_close(&handle_id).await
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
    super::lark_ws::open(app, adapter_id).await
}

#[tauri::command]
pub async fn connectors_lark_ws_close(handle_id: String) -> Result<(), String> {
    super::lark_ws::close(&handle_id).await
}

// ---------------------------------------------------------------------------
// Task 24 — attachment cache command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn connectors_attachment_fetch(
    adapter_id: String,
    remote_ref: String,
    source_url: String,
) -> Result<super::attachments::AttachmentRef, String> {
    super::attachments::fetch_attachment(adapter_id, remote_ref, source_url).await
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
