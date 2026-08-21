// Tauri-side wrappers around the Rust `read_claude_*_settings` commands.
// Returns `null` when the file is missing rather than throwing — most callers
// want to merge present scopes and fall through silently when none exist.

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { defaultLifecycleFirer } from "@/lib/claude/hooks/lifecycle-firer"

/**
 * Fire the `ConfigChange` lifecycle hook after a settings write (ADR-0040
 * follow-up — lights up a previously-dormant event). Best-effort + fire-and-
 * forget: observational only, never blocks or fails the write. No-ops on web.
 */
function fireConfigChange(scope: "user" | "project" | "local", cwd?: string): void {
  void defaultLifecycleFirer(
    "ConfigChange",
    { agentId: "settings", agentKind: "system", sessionId: scope, cwd },
    {
      payload: { scope },
    }
  )
}

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

/**
 * Result returned by every `write_claude_*_settings` command. `backupPath`
 * is set when the writer rotated a previous version aside (e.g.,
 * `~/.claude/settings.json.bak.<unix>`), `null` on first write.
 */
export interface ClaudeSettingsWriteResult {
  path: string
  backupPath?: string | null
}

/**
 * Atomically write the full `ClaudeSettings` payload to `~/.claude/settings.json`.
 * Refuses if `~/.claude/` is missing (we don't want to silently materialize a
 * settings file for users who haven't installed Claude Code).
 *
 * The payload is serialized verbatim — recognized fields go to their named
 * keys and the `extra` map is flattened into the top level. Callers who want
 * to perform a partial update should `read → patch → write` rather than
 * sending only the changed fields.
 */
export async function writeClaudeUserSettings(
  payload: ClaudeSettings
): Promise<ClaudeSettingsWriteResult> {
  const result = await invoke<ClaudeSettingsWriteResult>("write_claude_user_settings", { payload })
  fireConfigChange("user")
  return result
}

/** Atomically write `<cwd>/.claude/settings.json`. Creates `.claude/` if missing. */
export async function writeClaudeProjectSettings(
  cwd: string,
  payload: ClaudeSettings
): Promise<ClaudeSettingsWriteResult> {
  const result = await invoke<ClaudeSettingsWriteResult>("write_claude_project_settings", {
    cwd,
    payload,
  })
  fireConfigChange("project", cwd)
  return result
}

/** Atomically write `<cwd>/.claude/settings.local.json`. Creates `.claude/` if missing. */
export async function writeClaudeLocalSettings(
  cwd: string,
  payload: ClaudeSettings
): Promise<ClaudeSettingsWriteResult> {
  const result = await invoke<ClaudeSettingsWriteResult>("write_claude_local_settings", {
    cwd,
    payload,
  })
  fireConfigChange("local", cwd)
  return result
}

/**
 * Subscribe to settings-file changes emitted by the Rust writer commands.
 * Useful for in-process caches (e.g., Hooks Editor's pending-state guard) to
 * invalidate after a successful write.
 *
 * Returns an unsubscriber. The Tauri event name is intentionally generic —
 * the payload carries which scope changed.
 */
export interface ClaudeSettingsChangedEvent {
  scope: "user" | "project" | "local"
  path: string
}

export async function subscribeClaudeSettings(
  handler: (evt: ClaudeSettingsChangedEvent) => void
): Promise<UnlistenFn> {
  return listen<ClaudeSettingsChangedEvent>("claude-settings-changed", (e) => handler(e.payload))
}
