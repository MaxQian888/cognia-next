/**
 * CLI lifecycle-hook firer.
 *
 * The renderer/desktop firer (`lib/claude/hooks/lifecycle-firer.ts`) reaches the
 * Rust System-B runtime through the `run_agent_hook` Tauri bridge. The CLI has
 * no Tauri host, so this adapter fires the same lifecycle events through the
 * CLI's own command-hook runner (`cli/src/hooks/*`) — the loaded `~/.cognia` +
 * `~/.claude/settings.json` hook config.
 *
 * Reduced fidelity vs the Rust runtime: command hooks here signal a block via a
 * non-zero exit (parity with `run-hooks`), and stdout `additionalContext` is not
 * parsed, so `additionalContext` is always null. Used to bracket the CLI `/goal`
 * judge call so a `UserPromptSubmit` guard can still deny it.
 */
import { spawn as nodeSpawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { loadHooks, type FileReader } from "../../hooks/load-hooks"
import { runHooks } from "../../hooks/run-hooks"
import { HOOK_EVENTS, type HookEvent, type HooksConfig } from "../../hooks/types"
import type { LifecycleHookFirer } from "@/lib/claude/hooks/lifecycle-firer"

export interface CliLifecycleFirerDeps {
  /** Cognia config home (`~/.cognia`). */
  home: string
  /** OS home (`~`) — `~/.claude/settings.json` hangs off this. */
  osHome?: string
  spawn?: typeof nodeSpawn
  readFile?: FileReader
}

const defaultReadFile: FileReader = (absPath) => {
  try {
    return fs.readFileSync(absPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

const KNOWN_EVENTS = new Set<string>(HOOK_EVENTS)

/**
 * Build a {@link LifecycleHookFirer} backed by the CLI command-hook runner. The
 * hook config is read once; each call costs one map lookup when no hooks are
 * configured for the event (the common case).
 */
export function createCliLifecycleFirer(deps: CliLifecycleFirerDeps): LifecycleHookFirer {
  const spawn = deps.spawn ?? nodeSpawn
  const readFile = deps.readFile ?? defaultReadFile
  const claudeHome = path.join(deps.osHome ?? os.homedir(), ".claude")
  const config: HooksConfig = loadHooks({ home: deps.home, claudeHome, readFile })

  return async (event, _ctx, opts) => {
    if (!KNOWN_EVENTS.has(event)) return null
    const groups = config[event as HookEvent] ?? []
    if (groups.length === 0) return null
    const res = await runHooks({
      event: event as HookEvent,
      toolName: opts?.toolName,
      payload: opts?.payload ?? {},
      groups,
      spawn,
    })
    return {
      block: res.deny ? (res.reason ?? "blocked by hook") : null,
      additionalContext: null,
      warnings: [],
    }
  }
}
