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
pub mod discord_upload;
pub mod http_client;
pub mod keyring;
pub mod lark_upload;
pub mod lark_ws;
pub mod matrix_crypto;
pub mod media_upload;
pub mod replay_guard;
pub mod server_lifecycle;
pub mod sigverify;
pub mod state;
pub mod types;
pub mod ws_client;
pub mod ws_server;

pub use state::ConnectorsState;

// NOTE on secret-dependent tests: this crate's [dev-dependencies] enable
// cognia-secrets' `test-inmemory` feature, so `cargo test -p cognia-connectors`
// runs against a hermetic in-memory secret store — no OS keyring is touched.
// The former `COGNIA_TEST_KEYRING=1` opt-in gate is therefore gone; keyring-
// dependent tests run unconditionally.
