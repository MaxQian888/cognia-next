/**
 * Loads + merges hook configurations from the Cognia CLI home and the user's
 * Claude Code home, so an existing `~/.claude/settings.json` `hooks` block is
 * honored alongside Cognia's own `~/.cognia/config.json` `hooks` block.
 *
 * The core merge is pure (every input injected) so it unit-tests without disk.
 */
import path from "node:path"

import {
  HOOK_EVENTS,
  HooksConfigSchema,
  type HookEvent,
  type HookGroup,
  type HooksConfig,
} from "./types"

/** Reads a file's text, or returns `null` when it does not exist. */
export type FileReader = (absPath: string) => string | null

/**
 * Merge two hook configs. For each event, Cognia's groups come first, then the
 * Claude Code groups — so a Cognia hook runs (and can block) before a Claude
 * one. Undefined sources are tolerated as empty.
 */
export function mergeHookConfigs(cognia?: HooksConfig, claude?: HooksConfig): HooksConfig {
  const a = cognia ?? {}
  const b = claude ?? {}
  const merged: HooksConfig = {}
  for (const event of HOOK_EVENTS) {
    const groups: HookGroup[] = [...(a[event] ?? []), ...(b[event] ?? [])]
    if (groups.length > 0) merged[event] = groups
  }
  return merged
}

/**
 * Parse a JSON file's `hooks` key into a validated {@link HooksConfig}. Any
 * read/parse/validation failure falls back to `{}` — a malformed settings file
 * must never crash the TUI, only forgo its hooks.
 */
function readHooksBlock(absPath: string, readFile: FileReader): HooksConfig {
  let raw: string | null
  try {
    raw = readFile(absPath)
  } catch {
    return {}
  }
  if (raw == null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const hooks = (parsed as { hooks?: unknown } | null)?.hooks
  if (hooks == null) return {}
  const result = HooksConfigSchema.safeParse(hooks)
  return result.success ? result.data : {}
}

/**
 * Load and merge the Cognia + Claude Code hook configs.
 *
 * Reads `<home>/config.json` (Cognia) and `<claudeHome>/settings.json` (Claude
 * Code), extracts each file's `hooks` key, Zod-validates it (invalid → `{}`),
 * and merges with Cognia groups first.
 */
export function loadHooks(opts: {
  home: string
  claudeHome: string
  readFile: FileReader
}): HooksConfig {
  const cognia = readHooksBlock(path.join(opts.home, "config.json"), opts.readFile)
  const claude = readHooksBlock(path.join(opts.claudeHome, "settings.json"), opts.readFile)
  return mergeHookConfigs(cognia, claude)
}

export type { HookEvent, HookGroup, HooksConfig }
