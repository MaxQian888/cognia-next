//! Multi-agent MCP config IO (ADR-0067 Tier C — extracted from `app_lib`).
//!
//! Each external coding agent (Claude Code, Cursor, VS Code, Codex, Gemini,
//! Windsurf, Cline, Roo Code) stores MCP servers in its own file at a
//! platform-specific path. This crate:
//!   - resolves those paths per-OS ([`paths`])
//!   - reads them as raw text + canonical JSON ([`io`] handles JSON / JSONC /
//!     TOML format quirks)
//!   - exposes Tauri commands for the frontend ([`commands`])
//!
//! The frontend's `lib/claude/agents/*` adapters consume the canonical JSON
//! tree and produce one back; this crate is the boundary that knows how they
//! live on disk.
//!
//! The command fns stay in the [`commands`] submodule rather than at this crate
//! root: a `#[tauri::command]` at a library crate root collides in the macro
//! namespace (E0255). `app_lib` re-aliases the crate as `agents`, so both
//! `agents::commands::…` in `generate_handler!` and the `crate::agents::paths::…`
//! / `crate::agents::io::…` call sites in `cli_bridge`, `tray`, `fleet`,
//! `codeserver` and `files` resolve unchanged.

pub mod commands;
pub mod io;
pub mod paths;
