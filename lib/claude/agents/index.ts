// Registry of external-agent MCP adapters. Each adapter knows how to parse
// one agent's config file (Claude Code, Cursor, Codex, etc.) into our
// internal McpImportDraft shape, and — for writable agents — how to project
// a list of managed servers back into the canonical JSON tree while
// preserving every unmanaged field.
//
// Adapters work on parsed JSON values (the wire format from Rust), not raw
// file text. The Rust IPC layer is responsible for format-specific reads
// and writes:
//   - JSON  agents (claude-code, claude-desktop, cursor, gemini, windsurf, …):
//           parse / stringify with 2-space indent.
//   - JSONC agents (vscode):
//           comments are stripped on parse; round-trip drops them. (Documented
//           limitation; vscode users edit MCP servers via Cognia after import.)
//   - TOML  agents (codex):
//           Rust uses `toml_edit` to round-trip with comment / ordering
//           preservation; adapters never see TOML text.
//
// Frontend code never deals with file paths; that's resolved per-OS in Rust
// (see src-tauri/src/agents/paths.rs).

import type { AgentId, McpServer } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import { CLAUDE_CODE_AGENT } from "./claude-code"
import { CLAUDE_DESKTOP_AGENT } from "./claude-desktop"
import { CLINE_AGENT } from "./cline"
import { CODEX_AGENT } from "./codex"
import { COGNIA_AGENT } from "./cognia"
import { CURSOR_AGENT } from "./cursor"
import { GEMINI_AGENT } from "./gemini"
import { ROO_CODE_AGENT } from "./roo-code"
import { VSCODE_AGENT } from "./vscode"
import { WINDSURF_AGENT } from "./windsurf"

export {
  CLAUDE_CODE_AGENT,
  CLAUDE_DESKTOP_AGENT,
  CLINE_AGENT,
  CODEX_AGENT,
  COGNIA_AGENT,
  CURSOR_AGENT,
  GEMINI_AGENT,
  ROO_CODE_AGENT,
  VSCODE_AGENT,
  WINDSURF_AGENT,
}

export type AgentFileFormat = "json" | "jsonc" | "toml"

export interface McpAgentAdapter {
  id: AgentId
  /** Display name shown in UI (e.g. "Claude Code"). */
  displayName: string
  /** One-line description for UI hover/tooltip. */
  description?: string
  /** Whether `project()` can be called. Read-only adapters throw on project. */
  writable: boolean
  /** File format hint — Rust IPC uses this to pick the serializer. */
  format: AgentFileFormat
  /**
   * Parse a JSON tree (already decoded by IPC) into import drafts. Forgiving:
   * returns [] on unexpected shapes rather than throwing.
   */
  parse(value: unknown): McpImportDraft[]
  /**
   * Project `servers` into the existing parsed value tree (or `null` if the
   * file doesn't exist yet). Returns the new tree; Rust IPC re-serializes
   * via the appropriate format. Throws for read-only adapters.
   *
   * Semantics, in order:
   *   1. Preserve every entry whose name is NOT in `managedNames` (unmanaged
   *      user entries — Cognia doesn't own them).
   *   2. Drop every entry whose name IS in `managedNames` (we owned it; the
   *      caller decides what survives via `servers`).
   *   3. Stamp each `server` in `servers` into the tree.
   *
   * `managedNames` is the set of every server Cognia tracks in its DB, not
   * just the subset projected to this agent. That's how flipping
   * `appsEnabled[X]` from true → false makes the entry disappear from agent
   * X's file: the name is in `managedNames` but absent from `servers`.
   *
   * The default `managedNames` (when `undefined`) is the names of `servers`,
   * matching the simpler "import a fresh file" use case.
   */
  project(
    existing: unknown | null,
    servers: McpServer[],
    managedNames?: ReadonlySet<string>
  ): unknown
}

/**
 * Adapter registry. Order is stable and used directly for UI iteration
 * (chips, import dialog). Read-only agents (cline, roo-code) come last.
 */
export const MCP_AGENT_ADAPTERS: McpAgentAdapter[] = [
  COGNIA_AGENT,
  CLAUDE_CODE_AGENT,
  CLAUDE_DESKTOP_AGENT,
  CURSOR_AGENT,
  VSCODE_AGENT,
  CODEX_AGENT,
  GEMINI_AGENT,
  WINDSURF_AGENT,
  CLINE_AGENT,
  ROO_CODE_AGENT,
]

const ADAPTERS_BY_ID = new Map<AgentId, McpAgentAdapter>(MCP_AGENT_ADAPTERS.map((a) => [a.id, a]))

export function getAgentAdapter(id: AgentId): McpAgentAdapter | undefined {
  return ADAPTERS_BY_ID.get(id)
}

export function requireAgentAdapter(id: AgentId): McpAgentAdapter {
  const a = ADAPTERS_BY_ID.get(id)
  if (!a) throw new Error(`unknown agent: ${id}`)
  return a
}
