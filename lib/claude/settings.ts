// Tauri-side wrappers around the Rust `read_claude_*_settings` commands.
// Returns `null` when the file is missing rather than throwing — most callers
// want to merge present scopes and fall through silently when none exist.

import { invoke } from "@tauri-apps/api/core"

/**
 * Subset of `~/.claude/settings.json` fields we explicitly model. Anything
 * else lands in `extra` so future Claude Code releases don't break the reader.
 *
 * The shape mirrors the Rust `ClaudeSettings` struct, with camelCased fields.
 */
export interface ClaudeSettings {
  model?: string
  effortLevel?: string
  outputStyle?: string
  /** Permissions block (allow/ask/deny/additionalDirectories/defaultMode). */
  permissions?: Record<string, unknown>
  /** Hooks keyed by event name. */
  hooks?: Record<string, unknown>
  /** MCP server map keyed by server name. */
  mcpServers?: Record<string, unknown>
  /** Anything we don't model. */
  extra?: Record<string, unknown>
}

export interface EffectiveSettings {
  user: ClaudeSettings | null
  project: ClaudeSettings | null
  local: ClaudeSettings | null
  /**
   * Shallow per-key merge: local > project > user. Hooks / permissions /
   * mcpServers are NOT deep-merged — consumers do that with their own
   * semantics (e.g. concat hooks).
   */
  merged: ClaudeSettings
}

export async function readClaudeUserSettings(): Promise<ClaudeSettings | null> {
  return invoke<ClaudeSettings | null>("read_claude_user_settings")
}

export async function readClaudeProjectSettings(cwd: string): Promise<ClaudeSettings | null> {
  return invoke<ClaudeSettings | null>("read_claude_project_settings", { cwd })
}

export async function readClaudeLocalSettings(cwd: string): Promise<ClaudeSettings | null> {
  return invoke<ClaudeSettings | null>("read_claude_local_settings", { cwd })
}

export async function readClaudeEffectiveSettings(cwd?: string | null): Promise<EffectiveSettings> {
  return invoke<EffectiveSettings>("read_claude_effective_settings", {
    cwd: cwd ?? null,
  })
}
