/**
 * Runs the `command` handlers of the hook groups matched for an event, with the
 * JSON event payload piped on stdin. Mirrors the desktop Rust runner's blocking
 * semantics: a non-zero exit on a `PreToolUse` / `UserPromptSubmit` event denies
 * the action (first deny wins). `webhook` and unknown handlers are inert.
 *
 * The spawner is injected (mirroring `cli/src/tui/clipboard.ts`) so the runner
 * unit-tests without spawning real processes.
 */
import { spawn as nodeSpawn } from "node:child_process"

import type { HookEvent, HookGroup, HookHandler } from "./types"

/** Minimal surface of `child_process.spawn` the runner needs. */
export type Spawn = typeof nodeSpawn

/** Default per-command timeout when a handler omits `timeout` (ms). */
const DEFAULT_TIMEOUT_MS = 60_000

/** Events whose non-zero command exit denies (blocks) the action. */
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  "PreToolUse",
  "UserPromptSubmit",
])

/**
 * Does a `matcher` match `toolName`? A matcher is either a comma-separated list
 * of literal tool names (case-sensitive exact match) or a regex. The literal
 * list is tried first; if no comma-separated token matches AND the matcher is a
 * valid regex, the regex is tried as a fallback. A bare single token is treated
 * as both a literal and (if valid) a regex.
 */
function matcherMatches(matcher: string, toolName: string): boolean {
  const literals = matcher
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (literals.includes(toolName)) return true
  // Fallback: treat the whole matcher as a regex (anchored full-string match).
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName)
  } catch {
    return false
  }
}

/**
 * Select the groups that apply to an event. A group with no `matcher` matches
 * everything. A group WITH a matcher only applies when a `toolName` is present
 * and the matcher matches it — so for non-tool events (no `toolName`), only
 * null-matcher groups apply.
 */
export function matchGroups(groups: HookGroup[], toolName?: string): HookGroup[] {
  return groups.filter((g) => {
    if (g.matcher == null || g.matcher === "") return true
    if (toolName == null) return false
    return matcherMatches(g.matcher, toolName)
  })
}

/** Is this handler an executable `command` handler? */
function isCommandHandler(
  h: HookHandler
): h is { type: "command"; command: string; timeout?: number } {
  return h.type === "command" && typeof (h as { command?: unknown }).command === "string"
}

/** Outcome of running a single command handler. */
interface CommandOutcome {
  /** Non-zero exit (or spawn failure on a blocking event ⇒ deny). */
  blocked: boolean
  reason?: string
}

/**
 * Spawn one command handler, pipe `payload` JSON on stdin, and resolve once it
 * exits / errors / times out. A non-zero exit is reported as blocked; spawn
 * errors and timeouts soft-allow (a broken hook must not lock the user out).
 */
function runCommand(
  handler: { command: string; timeout?: number },
  payloadJson: string,
  spawn: Spawn,
  defaultTimeoutMs: number
): Promise<CommandOutcome> {
  const timeoutMs =
    typeof handler.timeout === "number" && handler.timeout > 0
      ? handler.timeout * 1000
      : defaultTimeoutMs
  return new Promise<CommandOutcome>((resolve) => {
    let settled = false
    const done = (outcome: CommandOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      // Soft-allow on timeout; surface as a non-blocking reason for diagnostics.
      done({ blocked: false, reason: `hook timed out after ${timeoutMs}ms (soft-allow)` })
    }, timeoutMs)
    // Avoid keeping the event loop alive solely for the timeout.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      ;(timer as { unref: () => void }).unref()
    }
    try {
      const child = spawn(handler.command, { shell: true })
      child.on("error", () => done({ blocked: false }))
      child.on("close", (code: number | null) => {
        const exit = code ?? 0
        done(
          exit === 0 ? { blocked: false } : { blocked: true, reason: `hook command exited ${exit}` }
        )
      })
      child.stdin?.end(payloadJson)
    } catch {
      done({ blocked: false })
    }
  })
}

/**
 * Run every `command` handler in the matched groups for an event, piping the
 * JSON `payload` on stdin. On a `PreToolUse` / `UserPromptSubmit` event, the
 * first handler that exits non-zero denies the action (and short-circuits the
 * rest). `webhook` and unknown handlers are inert.
 */
export async function runHooks(opts: {
  event: HookEvent
  toolName?: string
  payload: Record<string, unknown>
  groups: HookGroup[]
  spawn: Spawn
  timeoutMsDefault?: number
}): Promise<{ deny: boolean; reason?: string }> {
  const defaultTimeoutMs = opts.timeoutMsDefault ?? DEFAULT_TIMEOUT_MS
  const blocking = BLOCKING_EVENTS.has(opts.event)
  const matched = matchGroups(opts.groups, opts.toolName)
  let payloadJson: string
  try {
    payloadJson = JSON.stringify({
      hook_event_name: opts.event,
      ...(opts.toolName != null ? { tool_name: opts.toolName } : {}),
      ...opts.payload,
    })
  } catch {
    payloadJson = "{}"
  }

  for (const group of matched) {
    for (const handler of group.hooks) {
      if (!isCommandHandler(handler)) continue // webhook / unknown ⇒ inert
      const outcome = await runCommand(handler, payloadJson, opts.spawn, defaultTimeoutMs)
      if (blocking && outcome.blocked) {
        return { deny: true, reason: outcome.reason }
      }
    }
  }
  return { deny: false }
}
