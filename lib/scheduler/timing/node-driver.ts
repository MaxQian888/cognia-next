/**
 * Node timing driver — the headless brain's timing source
 * (`cognia-agent serve`, ADR-0059 T-A10).
 *
 * The brain is a single long-lived Node process: there is no second tab to
 * elect a leader against and no background-tab throttling to defend
 * against, so neither the renderer driver's tab-lock nor its 60-second drift
 * poll applies. This driver is the smallest correct thing for that host —
 * one `setTimeout` per armed task, `unref`'d so a pending alarm never keeps
 * the process alive on shutdown, and long delays are chunked so a fire time
 * beyond the 32-bit `setTimeout` ceiling (~24.8 days) is still honoured.
 *
 * `supportsLeaderElection` is `false`: like the Rust daemon, this process is
 * the sole timing authority for its own `CogniaSchedulerDB`. Selection lives
 * in `task-scheduler.ts` (`platform === "headless"`), and the choice is
 * pinned by `task-scheduler.test.ts`.
 */

import { loggers } from "@cognia/logging"

import type { SchedulerTimingDriver, TaskDueCallback } from "@/types/scheduler"

const log = loggers.scheduler

/** Largest delay a single `setTimeout` honours (2^31 - 1 ms). */
export const MAX_TIMEOUT_MS = 2_147_483_647

type ArmedEntry = {
  handle: ReturnType<typeof setTimeout>
  fireAtMs: number
}

type TimerHandle = ReturnType<typeof setTimeout>

/** Timer primitives — injectable for deterministic tests. */
export interface NodeTimerHost {
  setTimeout: (callback: () => void, ms: number) => TimerHandle
  clearTimeout: (handle: TimerHandle) => void
  now: () => number
}

const defaultTimerHost: NodeTimerHost = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  now: () => Date.now(),
}

export class NodeTimingDriver implements SchedulerTimingDriver {
  readonly supportsLeaderElection = false as const

  private timers = new Map<string, ArmedEntry>()
  private dueCb: TaskDueCallback | null = null
  private started = false
  private readonly host: NodeTimerHost

  constructor(host: Partial<NodeTimerHost> = {}) {
    this.host = { ...defaultTimerHost, ...host }
  }

  async start(): Promise<void> {
    this.started = true
  }

  stop(): void {
    this.started = false
    for (const entry of this.timers.values()) this.host.clearTimeout(entry.handle)
    this.timers.clear()
  }

  onDue(cb: TaskDueCallback): void {
    this.dueCb = cb
  }

  arm(taskId: string, fireAtMs: number): void {
    this.disarm(taskId)
    this.schedule(taskId, fireAtMs)
  }

  disarm(taskId: string): void {
    const entry = this.timers.get(taskId)
    if (!entry) return
    this.host.clearTimeout(entry.handle)
    this.timers.delete(taskId)
  }

  /** Number of armed tasks (diagnostics / tests). */
  get armedCount(): number {
    return this.timers.size
  }

  private schedule(taskId: string, fireAtMs: number): void {
    const delay = fireAtMs - this.host.now()
    // Beyond the 32-bit ceiling: sleep one maximal chunk and re-evaluate. The
    // recomputation on wake also absorbs clock adjustments during long sleeps.
    const chunk = Math.max(0, Math.min(delay, MAX_TIMEOUT_MS))
    const handle = this.host.setTimeout(() => {
      const current = this.timers.get(taskId)
      // A re-arm/disarm since scheduling replaced or removed this entry.
      if (!current || current.handle !== handle) return
      if (this.host.now() < fireAtMs) {
        this.schedule(taskId, fireAtMs)
        return
      }
      this.timers.delete(taskId)
      this.dueCb?.(taskId, fireAtMs)
    }, chunk)
    unref(handle)
    this.timers.set(taskId, { handle, fireAtMs })
    if (delay > 0) log.debug(`Armed task ${taskId} in ${Math.round(delay / 1000)}s (node driver)`)
  }
}

/** `unref` exists on Node timer handles only; browsers return a number. */
function unref(handle: TimerHandle): void {
  const maybe = handle as unknown as { unref?: () => void }
  if (typeof maybe?.unref === "function") maybe.unref()
}
