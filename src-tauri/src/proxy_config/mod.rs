//! App-side facade over [`cognia_net::proxy_config`] (ADR-0067).
//!
//! The proxy state, detection and WSS-dialer logic live in the `cognia-net`
//! crate; this module re-exports them so existing `crate::proxy_config::…`
//! call sites are unchanged, and keeps the thin `proxy_*` `#[tauri::command]`
//! shells (`commands.rs`) app-side.

pub use cognia_net::proxy_config::*;

pub mod commands;
pub mod stream;
