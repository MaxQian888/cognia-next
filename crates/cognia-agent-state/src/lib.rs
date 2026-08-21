//! Local SQLite mirrors of renderer-side agent state (ADR-0067 Tier C —
//! extracted from `app_lib`).
//!
//! - [`agent_session_store`] — the agent session/message store and its
//!   host-RPC dispatch, keyed by `SessionKey` and swept by retention.
//! - [`provider_profiles`] — provider profile rows, the routing-snapshot
//!   projection consumed by the gateway, and a `watch` channel that version-
//!   bumps subscribers.
//! - [`session_import`] — read-only probes of an external agent's on-disk
//!   history (currently OpenCode's SQLite database).
//!
//! **This crate deliberately has no `tauri` dependency.**
//! `bin/cognia-server.rs` links `provider_profiles` and
//! `agent_session_store` on the headless path, and ADR-0067 Batch 4's
//! `cognia-agent-protocols` will path-dep this crate for the ACP session
//! registry. The Tauri-facing shells stay in `app_lib`: the single
//! `opencode_sessions_read` command wraps
//! [`session_import::read_opencode_sessions`], and the whole
//! `session_import_watch` module (which exists only to `emit` a frontend
//! event through an `AppHandle`) never moved.

pub mod agent_session_store;
pub mod provider_profiles;
pub mod session_import;
