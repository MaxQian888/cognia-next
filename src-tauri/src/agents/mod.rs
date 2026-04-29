// Multi-agent MCP config IO. Each external coding agent (Claude Code,
// Cursor, VS Code, Codex, Gemini, Windsurf, Cline, Roo Code) stores MCP
// servers in its own file at a platform-specific path. This module:
//   - resolves those paths per-OS (paths.rs)
//   - reads them as raw text + canonical JSON (io.rs handles JSON / JSONC /
//     TOML format quirks)
//   - exposes Tauri commands for the frontend (commands.rs)
//
// The frontend's `lib/claude/agents/*` adapters consume the canonical JSON
// tree and produce one back; this module is the boundary that knows how
// they live on disk.

pub mod commands;
pub mod io;
pub mod paths;
