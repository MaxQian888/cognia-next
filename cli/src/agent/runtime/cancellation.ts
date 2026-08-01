/**
 * One cancellation path for every way a headless turn can end early.
 *
 * `AbortSignal`, `SIGINT`, `SIGTERM`, the wall-clock deadline, the idle-stream
 * deadline, an RPC `turn.cancel`, and a tool cancellation all converge here and
 * produce the SAME shutdown: pending approvals and elicitations resolve as
 * DENY, dispatchers unsubscribe, tool hosts stop, sidecars and external agents
 * close, and the session lease is released.
 *
 * Two properties are load-bearing:
 *
 * - **Deny, never hang.** An outstanding approval whose waiter is abandoned is
 *   how a cancelled run leaves an orphan process holding a lease forever. The
 *   only safe resolution for a request nobody can answer is `deny`.
 * - **Every teardown runs.** Cleanups execute in reverse registration order and
 *   a throwing cleanup never prevents the rest — a sidecar that fails to close
 *   must not strand the lease behind it.
 */

import type { AgentStructuredError } from "@cognia/agent-config-types/agent-run-result"

export type CancelReason =
  | "abort"
  | "sigint"
  | "sigterm"
  | "timeout"
  | "idle-timeout"
  | "rpc-cancel"
  | "tool-cancel"
  | "shutdown"

/** Map a cancellation cause onto the structured error the caller reports. */
export function errorForCancelReason(reason: CancelReason, detail?: string): AgentStructuredError {
  switch (reason) {
    case "timeout":
      return { code: "timeout", message: detail ?? "the turn exceeded its wall-clock deadline" }
    case "idle-timeout":
      return { code: "idle_timeout", message: detail ?? "the provider stream stalled" }
    case "sigterm":
    case "shutdown":
      return { code: "interrupted", message: detail ?? "the process was asked to terminate" }
    default:
      return { code: "cancelled", message: detail ?? "the turn was cancelled" }
  }
}

export interface CancellationState {
  readonly cancelled: boolean
  readonly reason: CancelReason | null
  readonly detail: string | null
}

export interface TurnCancellation extends CancellationState {
  /** Signal to hand to the capture layer, provider SDKs and backoff sleeps. */
  readonly signal: AbortSignal
  /** Cancel the turn. Idempotent — the FIRST reason wins and is reported. */
  cancel(reason: CancelReason, detail?: string): void
  /**
   * Register a teardown step. Returns an unregister function so a step that
   * completes normally does not run twice.
   */
  onCleanup(cleanup: () => void | Promise<void>): () => void
  /**
   * Register a pending approval/elicitation waiter. On cancellation every
   * registered waiter is resolved as DENY before teardown runs.
   */
  onPendingRequest(deny: () => void): () => void
  /** Run every teardown step, then clear timers and signal handlers. */
  finalize(): Promise<void>
  /** The structured error for this cancellation, or null if it never fired. */
  toError(): AgentStructuredError | null
}

export interface CancellationOptions {
  /** Caller-supplied signal (SDK `AbortSignal`, RPC lifetime, parent turn). */
  signal?: AbortSignal
  /** Wall-clock deadline for the whole turn (`--timeout`). */
  timeoutMs?: number
  /**
   * Stalled-stream deadline (`--idle-timeout`). Distinct from `timeoutMs` on
   * purpose: a long, healthy turn must not be killed, but a turn whose stream
   * has produced nothing for this long is wedged.
   */
  idleTimeoutMs?: number
  /** Install SIGINT/SIGTERM handlers. Off in tests and in-process SDK use. */
  handleSignals?: boolean
  /** Injected process for signal wiring; defaults to the real one. */
  proc?: Pick<NodeJS.Process, "on" | "off">
}

/**
 * Create the cancellation scope for one turn.
 *
 * The idle timer is armed lazily and reset by `noteActivity()`, so it measures
 * silence rather than duration.
 */
export function createTurnCancellation(options: CancellationOptions = {}): TurnCancellation & {
  /** Reset the idle deadline. Call on every stream event. */
  noteActivity(): void
} {
  const controller = new AbortController()
  const cleanups: Array<() => void | Promise<void>> = []
  const pending: Array<() => void> = []
  const proc = options.proc ?? process

  let reason: CancelReason | null = null
  let detail: string | null = null
  let finalized = false
  let wallTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimers = (): void => {
    if (wallTimer) clearTimeout(wallTimer)
    if (idleTimer) clearTimeout(idleTimer)
    wallTimer = null
    idleTimer = null
  }

  const cancel = (next: CancelReason, nextDetail?: string): void => {
    // First cause wins: a SIGINT that arrives while a timeout is tearing down
    // must not rewrite the reported reason out from under the result.
    if (reason !== null) return
    reason = next
    detail = nextDetail ?? null
    clearTimers()
    // Deny every waiter BEFORE aborting, so nothing is still parked on a
    // promise when the transport goes away.
    for (const deny of pending.splice(0)) {
      try {
        deny()
      } catch {
        // A waiter that throws on denial must not block the others.
      }
    }
    controller.abort(errorForCancelReason(next, nextDetail ?? undefined).message)
  }

  const onSigint = (): void => cancel("sigint")
  const onSigterm = (): void => cancel("sigterm")

  if (options.signal) {
    if (options.signal.aborted) cancel("abort")
    else options.signal.addEventListener("abort", () => cancel("abort"), { once: true })
  }
  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    wallTimer = setTimeout(() => cancel("timeout"), options.timeoutMs)
    wallTimer.unref?.()
  }
  if (options.handleSignals) {
    proc.on("SIGINT", onSigint)
    proc.on("SIGTERM", onSigterm)
  }

  const armIdle = (): void => {
    if (options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => cancel("idle-timeout"), options.idleTimeoutMs)
    idleTimer.unref?.()
  }
  armIdle()

  return {
    get cancelled() {
      return reason !== null
    },
    get reason() {
      return reason
    },
    get detail() {
      return detail
    },
    signal: controller.signal,
    cancel,
    noteActivity: armIdle,
    onCleanup(cleanup) {
      cleanups.push(cleanup)
      return () => {
        const index = cleanups.indexOf(cleanup)
        if (index !== -1) cleanups.splice(index, 1)
      }
    },
    onPendingRequest(deny) {
      pending.push(deny)
      return () => {
        const index = pending.indexOf(deny)
        if (index !== -1) pending.splice(index, 1)
      }
    },
    async finalize() {
      if (finalized) return
      finalized = true
      clearTimers()
      if (options.handleSignals) {
        proc.off("SIGINT", onSigint)
        proc.off("SIGTERM", onSigterm)
      }
      // Any waiter still parked at normal completion is also denied — a turn
      // that ends with an unanswered approval must not leave it dangling.
      for (const deny of pending.splice(0)) {
        try {
          deny()
        } catch {
          // best-effort
        }
      }
      // Reverse order: the last thing set up is the first thing torn down.
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          await cleanup()
        } catch {
          // One failing teardown must never strand the rest (the lease is last).
        }
      }
    },
    toError() {
      return reason === null ? null : errorForCancelReason(reason, detail ?? undefined)
    },
  }
}
