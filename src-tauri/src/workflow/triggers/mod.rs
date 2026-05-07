//! Workflow trigger daemons.
//!
//! Phase 5a ships only the cron daemon (the highest-value trigger that
//! genuinely needs Rust because cron must keep firing while the webview is
//! minimized). The webhook receiver and connector inbound tap will mount on
//! the existing `connectors::axum_app` instance once Phase 5b lands the TS
//! bridge that consumes the events.

pub mod cron_daemon;
