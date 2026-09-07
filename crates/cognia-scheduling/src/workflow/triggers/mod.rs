//! Workflow trigger daemons.
//!
//! Three daemons live here:
//!   • `cron_daemon` — the cron firing loop that survives webview minimize.
//!   • `webhook_router` — the local axum HTTP receiver that turns inbound
//!     requests into `workflow:trigger` events.
//!   • `file_watch` — the `notify` watcher behind `trigger.file.watch`, whose
//!     mute window is what stops a workflow's own writes re-triggering it.
//!
//! The connector inbound tap and the chat-message tap remain TS-side hooks
//! into existing subsystems; they don't need Rust because the bus / chat
//! pipeline already runs in the webview.

pub mod cron_daemon;
pub mod file_watch;
pub mod webhook_router;
