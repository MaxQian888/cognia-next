//! Integrated terminal subsystem — `portable-pty` + xterm.js bridge.
//!
//! This module owns the Rust half of the VS Code-style terminal panel
//! described in the approved plan at
//! `~/.claude/plans/vscode-vivid-wilkinson.md`:
//!
//!   * `osc633` — streaming OSC 633 parser (per-spawn nonce gated).
//!   * `integration` — per-shell argv + env builder for the bundled
//!     shell-integration scripts at `src-tauri/resources/terminal/`.
//!   * `session` — `PtySession` wrapping `portable_pty::PtyPair` and the
//!     reader / waiter threads. First user of `tauri::ipc::Channel<T>`.
//!   * `host_bridge` (`tauri-host`) — the PTY lifecycle commands, forwarded
//!     to the durable `cognia-server desktop-host`.
//!   * `commands` — the shell-integration / CLI path resolvers the bridge and
//!     headless sessions share, and the `terminal_kill_port` command.
//!
//! The renderer pre-flights every spawn through
//! `lib/plugin/messaging/hooks-system.ts::dispatchTerminalWillSpawn` so
//! plugins can veto, modify, or audit. Rust stays narrow: spawn / write /
//! resize / kill / list. Audit fan-out happens on the TS side via
//! `loggers.ui` (user-driven) or the plugin permission-guard audit pipe
//! (extension-driven).

pub mod commands;
pub mod complete;
pub mod exec;
pub mod headless;
pub mod host;
pub mod host_capabilities;
// ADR-0196 — the desktop bridge to the durable terminal host: the
// `terminal_*` / `ssh_terminal_*` command shells and their managed state.
// `src-tauri`'s `terminal_host_bridge` glob-re-exports it.
#[cfg(feature = "tauri-host")]
pub mod host_bridge;
// ADR-0196 P6e — the one-shot terminal-host client the companion's terminal
// socket and RPC arms use, and the spawn/framing helpers the desktop bridge
// shares. Tauri-free: callers pass the app resource dir, or `None`.
pub mod host_client;
pub mod host_wire;
pub mod integration;
pub mod multiplexer;
pub mod osc633;
pub mod path_scan;
pub mod protocol;
pub mod replay;
pub mod serial;
pub mod session;
pub mod sftp;
pub mod ssh;
pub mod ssh_forward;
// ADR-0067 Tier C — the durable terminal-host service moved in from
// `app_lib` (it had zero `crate::` deps there and already built on this
// crate's host/host_wire/session). `app_lib` re-aliases it so
// `crate::terminal_host_service::…` (companion_api, bin/cognia-server)
// resolves unchanged.
pub mod terminal_host_service;

// Re-export the public session API so downstream Rust consumers (e.g.
// the LAN terminal WebSocket handler can `use …::terminal::*`
// without reaching into a sub-module. The unused-import lint fires for
// the types this crate itself doesn't reference today — they're still
// part of the module's stable surface.
#[allow(unused_imports)]
pub use replay::ReplayBuffer;
#[allow(unused_imports)]
pub use session::{PtySession, SessionOrigin, SpawnRequest, TerminalEvent, TerminalSessionInfo};
