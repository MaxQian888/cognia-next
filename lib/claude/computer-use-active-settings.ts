/**
 * ADR-0020 W1+W3 audit — per-session active Computer Use settings cache.
 *
 * The renderer-side `applyComputerUseTools` runs at chat-send time
 * with full access to the character's `computerUseSettings`. The plugin
 * MCP tools that actually fire `desktop.*` calls (in
 * `plugins/computer-use/src/index.ts`) run later, asynchronously, with
 * only the model's tool args in hand — no direct line to the active
 * character.
 *
 * Pre-audit gap: my W1 wired `forceTier: "perCall"` onto
 * `opts.anthropicTools[]`, but the chat path uses Plugin MCP tools
 * (`mcp__cognia-plugin-tools__*`), not the Anthropic native-tool API.
 * The Claude Code Agent SDK ignores `opts.anthropicTools`, so the
 * `forceTier` value never reached the Tauri commands —
 * `requireConsent: true` was effectively a no-op on the chat path.
 *
 * Fix: build-options stashes the active character's
 * `computerUseSettings` keyed by chat session id; the plugin's
 * `execute()` callback reads it at dispatch time and stamps
 * `ctx.forceTier` on the Tauri command's `CallContext`. The Rust
 * `command_body!` macro's `maybe_upgrade_to_consent` helper then
 * upgrades the gate decision exactly as the Wave 1 plan described.
 *
 * Scope is process-local; the cache is keyed by chat session id so
 * concurrent chat sessions with different characters can't bleed
 * settings. Entries are kept until `clearActiveComputerUseSettings`
 * fires from the chat session close path.
 */

import type { Character } from "@/lib/claude/types"

export type ActiveComputerUseSettings = NonNullable<Character["computerUseSettings"]>

const ACTIVE: Map<string, ActiveComputerUseSettings> = new Map()

/**
 * Snapshot the active character's `computerUseSettings` for a session.
 * Idempotent — repeated calls overwrite. `undefined` settings clear
 * the entry (so disabling Computer Use mid-session drops the override).
 */
export function setActiveComputerUseSettings(
  sessionId: string,
  settings: ActiveComputerUseSettings | undefined
): void {
  if (!sessionId) return
  if (!settings) {
    ACTIVE.delete(sessionId)
    return
  }
  ACTIVE.set(sessionId, settings)
}

/** Returns the cached settings for `sessionId`, or `null` when absent. */
export function getActiveComputerUseSettings(
  sessionId: string | undefined
): ActiveComputerUseSettings | null {
  if (!sessionId) return null
  return ACTIVE.get(sessionId) ?? null
}

/** Drop the entry for `sessionId`. Wired into session-close handlers. */
export function clearActiveComputerUseSettings(sessionId: string): void {
  if (!sessionId) return
  ACTIVE.delete(sessionId)
}

/** Test-only — wipe every entry. */
export function __resetForTesting(): void {
  ACTIVE.clear()
}
