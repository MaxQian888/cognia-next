/**
 * Feeds the unified log buffer from the sources nothing was consuming before.
 *
 * `external-agent://{stdout,stderr,exit,state-change}` are emitted by
 * `runtime/external/node-backend.ts` and, until now, had ZERO subscribers — an
 * agent that failed to spawn left no trace the user could look at. This module
 * is the consumer; it pushes into the coalescer, never straight into dispatch.
 *
 * Pure except for the subscriptions: the clock is injected so the mapping
 * unit-tests deterministically.
 */
import {
  onExternalAgentExit,
  onExternalAgentStateChange,
  onExternalAgentStderr,
  onExternalAgentStdout,
  type ExternalAgentExitEvent,
  type ExternalAgentStateChangeEvent,
  type ExternalAgentStderrEvent,
  type ExternalAgentStdoutEvent,
} from "../../runtime/external/native-shim"
import { classifyAgentStderr, toLogLines } from "./log-model"
import type { LogInput } from "../state/types"

export interface LogIngestSubscriptions {
  onStdout: (cb: (e: ExternalAgentStdoutEvent) => void) => Promise<() => void>
  onStderr: (cb: (e: ExternalAgentStderrEvent) => void) => Promise<() => void>
  onStateChange: (cb: (e: ExternalAgentStateChangeEvent) => void) => Promise<() => void>
  onExit: (cb: (e: ExternalAgentExitEvent) => void) => Promise<() => void>
}

const realSubscriptions: LogIngestSubscriptions = {
  onStdout: onExternalAgentStdout,
  onStderr: onExternalAgentStderr,
  onStateChange: onExternalAgentStateChange,
  onExit: onExternalAgentExit,
}

export interface LogIngestDeps {
  /** Where captured lines go — wired to the coalescer's `push`. */
  emit: (entry: LogInput) => void
  /** Injected clock; the reducer must stay clock-free, so `ts` is stamped here. */
  now: () => number
  subs?: LogIngestSubscriptions
  /**
   * Capture external-agent STDOUT. Defaults to FALSE, deliberately: for ACP
   * backends stdout is the JSON-RPC protocol channel carrying the whole
   * prompt/response traffic, so capturing it would both drown the panel and
   * copy conversation content into a diagnostics buffer.
   */
  captureStdout?: boolean
}

/**
 * Start ingesting. Returns a dispose function that is safe to call before the
 * (async) subscriptions have resolved and safe to call twice.
 */
export function startLogIngest(deps: LogIngestDeps): () => void {
  const subs = deps.subs ?? realSubscriptions
  let disposed = false
  const offs: Array<() => void> = []

  // The subscribe helpers are async. If dispose runs before one settles, the
  // unsubscribe would be lost and a dead handler would keep pushing forever —
  // so a late arrival unsubscribes itself. The catch matters too: a non-CLI
  // host can reject, and an unhandled rejection would take the TUI down.
  const track = (p: Promise<() => void>) => {
    void p
      .then((off) => {
        if (disposed) off()
        else offs.push(off)
      })
      .catch(() => undefined)
  }

  const emitLines = (data: string, make: (line: string) => LogInput) => {
    for (const line of toLogLines(data)) deps.emit(make(line))
  }

  track(
    subs.onStderr((e) =>
      emitLines(e.data, (line) => ({
        ts: deps.now(),
        level: classifyAgentStderr(line),
        channel: "agent",
        origin: e.agentId,
        message: line,
      }))
    )
  )

  if (deps.captureStdout) {
    track(
      subs.onStdout((e) =>
        emitLines(e.data, (line) => ({
          ts: deps.now(),
          level: "debug",
          channel: "agent",
          origin: e.agentId,
          message: line,
        }))
      )
    )
  }

  track(
    subs.onStateChange((e) =>
      deps.emit({
        ts: deps.now(),
        level: e.state === "Failed" ? "error" : "info",
        channel: "agent",
        origin: e.agentId,
        message: `agent ${e.agentId} → ${e.state}`,
      })
    )
  )

  track(
    subs.onExit((e) =>
      deps.emit({
        ts: deps.now(),
        level: e.code === 0 ? "info" : "error",
        channel: "agent",
        origin: e.agentId,
        message: `agent ${e.agentId} exited with code ${e.code}${e.signal ? ` (${e.signal})` : ""}`,
      })
    )
  )

  return () => {
    disposed = true
    while (offs.length > 0) offs.pop()?.()
  }
}

/** The sidecar-died line, shared with `useAgentSession`'s existing handler. */
export function sidecarExitedLog(now: number): LogInput {
  return {
    ts: now,
    level: "error",
    channel: "sidecar",
    message: "Agent backend stopped (sidecar exited).",
  }
}

/** A turn error, tagged with the classifier's category as its origin. */
export function turnErrorLog(now: number, message: string, category?: string): LogInput {
  return {
    ts: now,
    level: "error",
    channel: "system",
    ...(category ? { origin: category } : {}),
    message,
  }
}

/** Privacy-safe turn lifecycle entry. It records progress without copying the
 * prompt or response into the diagnostics buffer. */
export function turnLifecycleLog(
  now: number,
  phase: "started" | "completed" | "interrupted",
  origin?: string
): LogInput {
  return {
    ts: now,
    level: phase === "interrupted" ? "warn" : "info",
    channel: "system",
    ...(origin ? { origin } : {}),
    message: `turn ${phase}`,
  }
}
