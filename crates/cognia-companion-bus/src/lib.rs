//! The companion's event, push and bridge plumbing (ADR-0196 P4).
//!
//! - [`event_bus`] — the sequenced, replayable stream of host events every
//!   transport forwards to paired devices. [`event_batcher`] batches it per
//!   subscriber (ADR-0127), [`event_channels`] is the catalog of channels and
//!   who may subscribe to each, and [`event_leases`] records which live
//!   connection carries each device's stream.
//! - [`push`], [`dispatchers`], [`push_creds`] — push tokens, FCM and APNs
//!   delivery, and the credentials the dispatchers sign with.
//! - [`bridge_transport`], [`sync_bridge`], [`desktop_messages_bridge`],
//!   [`desktop_writes_bridge`] — request/response bridges from the companion
//!   server to whichever process holds the canonical store: the desktop
//!   WebView, or the headless brain over its socket.
//! - [`store`] — the `AppStore` trait and the SQLite store the headless
//!   server owns. [`sync_registry`] names the tables a sync pull may read.
//! - [`remote_context`] — which paired device a turn answers to.
//!
//! None of this reads companion state, so the companion core, the desktop app
//! and the headless server all build on it. The desktop re-exports each module
//! at its old `companion_api::<module>` path. Tauri appears in two places,
//! `event_bus::register_tauri_event` and `bridge_transport::WebViewBridgeTransport`,
//! both behind the `tauri-host` feature.

pub mod bridge_transport;
pub mod desktop_messages_bridge;
pub mod desktop_writes_bridge;
pub mod dispatchers;
pub mod event_batcher;
pub mod event_bus;
pub mod event_channels;
pub mod event_leases;
pub mod push;
pub mod push_creds;
pub mod remote_context;
pub mod store;
pub mod sync_bridge;
pub mod sync_registry;
