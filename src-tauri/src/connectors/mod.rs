//! Platform Connectors subsystem.
//!
//! Provides an axum HTTP/WS server for inbound platform webhooks, OS-keyring
//! credential storage, outbound HTTP client with rate limiting, and WebSocket
//! client/server for OneBot reverse-WS. Mirrors the `remote_control` module
//! structure: `state.rs` owns Tauri-managed state, `commands.rs` exposes
//! `#[tauri::command]` functions only.

pub mod attachments;
pub mod axum_app;
pub mod commands;
pub mod http_client;
pub mod keyring;
pub mod server_lifecycle;
pub mod sigverify;
pub mod state;
pub mod types;
pub mod ws_client;
pub mod ws_server;

pub use state::ConnectorsState;

/// Whether the OS keyring is available for integration tests.
///
/// Set `COGNIA_TEST_KEYRING=1` to run tests that require a real OS keyring
/// (or a keyring-accessible environment). Mirrors the pattern in
/// `tts::keyring`.
#[cfg(test)]
pub(crate) fn keyring_available() -> bool {
    std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
}
