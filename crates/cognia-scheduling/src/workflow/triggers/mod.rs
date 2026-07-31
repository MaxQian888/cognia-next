//! Workflow trigger daemons.
//!
//! Phase 5a ships:
//!   • `cron_daemon` — the cron firing loop that survives webview minimize.
//!   • `webhook_router` — the local axum HTTP receiver that turns inbound
//!     requests into `workflow:trigger` events.
//!
//! The connector inbound tap and the chat-message tap remain TS-side hooks
//! into existing subsystems; they don't need Rust because the bus / chat
//! pipeline already runs in the webview.

pub mod cron_daemon;
pub mod webhook_router;
