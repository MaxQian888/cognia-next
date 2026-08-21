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
 * Does a `matcher` apply to `target`?
 *
 * The canonical rule lives in `sidecar/dispatch/agent-hooks.mjs`; this is a port
 * of it, pinned by the shared table in `hooks/matcher-conformance.json`.
 *
 * This rail used to disagree with the other two: it split on commas ONLY (so
 * `"Bash|Edit"` never took the literal path) and then fell back to an ANCHORED
 * regex, so an author's `"^Notebook"` matched `NotebookEdit` on the desktop and
 * silently matched nothing here.
 *
 *   - `""` / `"*"` → match everything
 *   - `[A-Za-z0-9_-, |]` only → exact set, split on `[|,]`, alternatives trimmed
 *   - anything else → unanchored regex; an invalid regex matches nothing
 *
 * `narrow` tightens the exact-set alphabet to `[A-Za-z0-9_|]` for the events
 * whose target is a path or free text rather than a tool name.
 */
export function matcherMatches(matcher: string, target: string, narrow = false): boolean {
  const m = matcher.trim()
  if (m === "" || m === "*") return true
  const exactPattern = narrow ? /^[A-Za-z0-9_|]+$/ : /^[A-Za-z0-9_\-, |]+$/
  if (exactPattern.test(m)) {
    const separator = narrow ? /\|/ : /[|,]/
    return m.split(separator).some((alt) => alt.trim() === target)
  }
  try {
    return new RegExp(m).test(target)
  } catch {
    return false
  }
}

/** Events whose matcher target is a path / free text rather than a tool name. */
const NARROW_EXACT_SET_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  "FileChanged",
  "StopFailure",
])

/**
 * Test a group's `agents` selector against the turn's agent identity. Absent
 * selector matches everything, so every pre-existing config is untouched; a
 * present selector matches the `agentKind` OR the `agentRef`.
 *
 * An unidentified turn never matches a present selector — a hook that asked to
 * be narrowed must not fire on a turn whose agent we cannot name.
 */
export function agentsMatch(
  selector: string | undefined,
  identity?: { agentKind?: string; agentRef?: string }
): boolean {
  if (selector == null) return true
  const sel = selector.trim()
  if (sel === "" || sel === "*") return true
  return [identity?.agentKind, identity?.agentRef]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .some((target) => matcherMatches(sel, target))
}

/**
 * Select the groups that apply to an event. A group with no `matcher` matches
 * everything. A group WITH a matcher only applies when a `toolName` is present
 * and the matcher matches it — so for non-tool events (no `toolName`), only
 * null-matcher groups apply. The `agents` selector is orthogonal and applies to
 * EVERY event, including the ones with no tool name.
 */
export function matchGroups(
  groups: HookGroup[],
  toolName?: string,
  opts?: { event?: HookEvent; identity?: { agentKind?: string; agentRef?: string } }
): HookGroup[] {
  const narrow = opts?.event != null && NARROW_EXACT_SET_EVENTS.has(opts.event)
  return groups.filter((g) => {
    if (!agentsMatch(g.agents, opts?.identity)) return false
    if (g.matcher == null || g.matcher === "") return true
    if (toolName == null) return false
    return matcherMatches(g.matcher, toolName, narrow)
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
  /**
   * Which agent this event came from. Matched by a group's `agents` selector
   * and forwarded to the hook script as `agent_kind` / `agent_ref`, exactly as
   * the desktop rails emit them.
   */
  identity?: { agentKind?: string; agentRef?: string }
}): Promise<{ deny: boolean; reason?: string }> {
  const defaultTimeoutMs = opts.timeoutMsDefault ?? DEFAULT_TIMEOUT_MS
  const blocking = BLOCKING_EVENTS.has(opts.event)
  const matched = matchGroups(opts.groups, opts.toolName, {
    event: opts.event,
    identity: opts.identity,
  })
  let payloadJson: string
  try {
    payloadJson = JSON.stringify({
      hook_event_name: opts.event,
      ...(opts.toolName != null ? { tool_name: opts.toolName } : {}),
      ...(opts.identity?.agentKind ? { agent_kind: opts.identity.agentKind } : {}),
      ...(opts.identity?.agentRef ? { agent_ref: opts.identity.agentRef } : {}),
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
