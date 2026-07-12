//! cua desktop sandbox — remote Computer-Use execution target (ADR-0020
//! remote-target addendum). Phase 1 orchestrates a local Docker
//! `ghcr.io/trycua/cua-xfce` container and drives its `computer-server` over a
//! WebSocket, slotting in behind the existing automation gate as a `Remote`
//! `CallTarget`.

pub mod lifecycle;
pub mod protocol;
pub mod registry;
pub mod remote_client;

pub use registry::CuaSandboxRegistry;

/// Start (idempotently) the cua sandbox container for `connection_id` and
/// return the mapped host port for its `computer-server`.
#[tauri::command]
pub async fn cua_sandbox_start(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
    image: String,
) -> std::result::Result<u16, String> {
    reg.start(&connection_id, &image)
        .await
        .map_err(|e| e.to_string())
}

/// Stop and remove the cua sandbox container for `connection_id`.
#[tauri::command]
pub async fn cua_sandbox_stop(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
) -> std::result::Result<(), String> {
    reg.stop(&connection_id).await.map_err(|e| e.to_string())
}

/// Whether the cua sandbox container for `connection_id` is currently running.
#[tauri::command]
pub async fn cua_sandbox_health(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
) -> std::result::Result<bool, String> {
    Ok(reg.health(&connection_id).await)
}
