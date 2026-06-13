/**
 * `/hooks` controller — lists the settings.json lifecycle hooks that are active
 * for this session. Reads the merged Cognia (`~/.cognia/config.json`) + Claude
 * Code (`~/.claude/settings.json`) hook config via the pure `loadHooks` core and
 * renders it into the scrollable document pager. Read-only: editing hooks is
 * done in the JSON files, mirroring Claude Code.
 *
 * The pure `buildHooksDocument` is unit-tested without disk; `runHooksList`
 * wires the injected fs read + dispatch.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { loadHooks, type FileReader } from "../../hooks/load-hooks"
import { HOOK_EVENTS, type HookEvent, type HookHandler, type HooksConfig } from "../../hooks/types"
import { openDocument } from "./shared"
import type { TuiAction } from "../state/types"

export interface HooksDeps {
  dispatch: (action: TuiAction) => void
  /** Cognia config home (`~/.cognia`). */
  home: string
  /** OS home (`~`) — `~/.claude/settings.json` hooks hang off this. */
  osHome?: string
  /** Injected file reader (tests pass an in-memory double). */
  readFile?: FileReader
}

/** One-line description of a single hook handler for the listing. */
function describeHandler(handler: HookHandler): string {
  const h = handler as { type: string; command?: string; timeout?: number; url?: string }
  if (h.type === "command") {
    const timeout = h.timeout ? ` (timeout ${h.timeout}s)` : ""
    return `\`${h.command}\`${timeout}`
  }
  if (h.type === "webhook") {
    return `webhook → ${h.url} (inert — not run in the CLI)`
  }
  return `${h.type} handler (inert)`
}

/**
 * Render the merged hook config into a markdown document, grouped by lifecycle
 * event. Only events that have at least one group are shown; an empty config
 * yields a short "no hooks" body so the pager always has content.
 */
export function buildHooksDocument(config: HooksConfig): string {
  const lines: string[] = ["# Active hooks", ""]
  const active = HOOK_EVENTS.filter((event) => (config[event]?.length ?? 0) > 0)
  if (active.length === 0) {
    lines.push(
      "No hooks are configured.",
      "",
      "Add a `hooks` block to `~/.cognia/config.json` (or reuse your",
      "`~/.claude/settings.json` hooks). Only `command` handlers run in the CLI;",
      "a non-zero exit on `PreToolUse` / `UserPromptSubmit` blocks the action.",
      "",
      "Example:",
      "",
      "```json",
      '{ "hooks": { "PreToolUse": [{ "matcher": "Edit|Write",',
      '  "hooks": [{ "type": "command", "command": "./guard.sh" }] }] } }',
      "```"
    )
    return lines.join("\n")
  }
  for (const event of active) {
    const groups = config[event] ?? []
    lines.push(`## ${event}`, "")
    for (const group of groups) {
      const matcher = group.matcher ? `matcher \`${group.matcher}\`` : "matches all"
      lines.push(`- ${matcher}`)
      for (const handler of group.hooks) {
        lines.push(`  - ${describeHandler(handler)}`)
      }
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

/** Count the configured hook groups across every event (for the empty notice). */
function totalGroups(config: HooksConfig): number {
  return HOOK_EVENTS.reduce((sum, event) => sum + (config[event]?.length ?? 0), 0)
}

/** `/hooks` (and `/hooks list`) — open the active-hooks document. */
export function hooksList(deps: HooksDeps): void {
  const readFile = deps.readFile ?? defaultReadFile
  const claudeHome = path.join(deps.osHome ?? os.homedir(), ".claude")
  const config = loadHooks({ home: deps.home, claudeHome, readFile })
  const count = totalGroups(config)
  openDocument(deps.dispatch, {
    title: count > 0 ? `Hooks (${count})` : "Hooks",
    body: buildHooksDocument(config),
    format: "markdown",
  })
}

const defaultReadFile: FileReader = (absPath) => {
  try {
    return fs.readFileSync(absPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

export type { HookEvent }
