//! Optional desktop "Pro IDE" mode: an on-demand, embedded `code-server`
//! (browser VS Code) that augments — never replaces — the Monaco editor.
//!
//! - `download` — fetch + SHA-256-verify + extract the pinned code-server
//!   standalone tarball from GitHub Releases into app-data.
//! - `process` — spawn code-server bound to a loopback port, health-poll it,
//!   and manage one instance per project root (`CodeServerState`).
//! - `commands` — the Tauri IPC surface.
//!
//! Desktop-only in effect: `download::resolve_platform` errors on hosts with no
//! prebuilt binary (Windows, exotic arch); the frontend gates the toggle via
//! `codeserver_supported`.

pub mod agent_channel;
pub mod commands;
pub mod download;
pub mod process;
pub mod webview;

pub use process::CodeServerState;
