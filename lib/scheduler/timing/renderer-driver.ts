/**
 * Renderer timing driver — the web / Capacitor timing source.
 *
 * Extracted verbatim from the previous in-class timer logic of
 * `task-scheduler.ts`: drift-resistant `setInterval` polling for long delays
 * with a precise `setTimeout` for the final stretch, plus multi-tab leader
 * election (only the leader tab fires). Behavior is unchanged — this is the
 * fallback whenever the Rust alarm daemon is unavailable (browser, mobile).
 */

import { loggers } from "@/lib/logging"

import type { LeaderAwareTimingDriver, TaskDueCallback } from "@/types/scheduler"

import { isLeaderTab, onLeaderChange, startLeaderElection, stopLeaderElection } from "../tab-lock"

const log = loggers.scheduler

/**
 * For long delays (> 60s) we poll with `setInterval` to avoid background-tab
 * `setTimeout` throttling/drift, then switch to a precise `setTimeout` for the
 * final stretch. For short delays we use a direct `setTimeout`.
 */
const DRIFT_THRESHOLD_MS = 60_000

type ArmedEntry = {
  handle: ReturnType<typeof setTimeout>
  /** True while the entry is the coarse polling interval (vs a final timeout). */
  isInterval: boolean
  /** The armed fire instant (epoch ms) — reported as the scheduled slot. */
  fireAtMs: number
}

export class RendererTimingDriver implements LeaderAwareTimingDriver {
  readonly supportsLeaderElection = true as const

  private timers = new Map<string, ArmedEntry>()
  private dueCb: TaskDueCallback | null = null
  private started = false

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await startLeaderElection()
  }

  stop(): void {
    this.started = false
    for (const entry of this.timers.values()) {
      this.clearHandle(entry)
    }
    this.timers.clear()
    stopLeaderElection()
  }

  onDue(cb: TaskDueCallback): void {
    this.dueCb = cb
  }

  isLeader(): boolean {
    return isLeaderTab()
  }

  onLeaderChange(cb: (isLeader: boolean) => void): () => void {
    return onLeaderChange(cb)
  }

  arm(taskId: string, fireAtMs: number): void {
    this.disarm(taskId)
    const delay = fireAtMs - Date.now()

    if (delay <= 0) {
      // Overdue — fire on the next tick (async, like the old fire-and-forget
      // immediate path) rather than synchronously, to avoid re-entrancy during
      // a bulk re-arm.
      const handle = setTimeout(() => {
        this.timers.delete(taskId)
        this.fire(taskId, fireAtMs)
      }, 0)
      this.timers.set(taskId, { handle, isInterval: false, fireAtMs })
      return
    }

    if (delay > DRIFT_THRESHOLD_MS) {
      const targetTime = fireAtMs
      const interval = setInterval(() => {
        const remaining = targetTime - Date.now()
        if (remaining <= 0) {
          this.clearEntry(taskId)
          this.fire(taskId, fireAtMs)
        } else if (remaining <= DRIFT_THRESHOLD_MS) {
          // Switch to a precise setTimeout for the final stretch.
          this.clearEntry(taskId)
          const finalTimer = setTimeout(() => {
            this.timers.delete(taskId)
            this.fire(taskId, fireAtMs)
          }, remaining)
          this.timers.set(taskId, { handle: finalTimer, isInterval: false, fireAtMs })
        }
      }, DRIFT_THRESHOLD_MS)
      this.timers.set(taskId, { handle: interval, isInterval: true, fireAtMs })
      return
    }

    const handle = setTimeout(() => {
      this.timers.delete(taskId)
      this.fire(taskId, fireAtMs)
    }, delay)
    this.timers.set(taskId, { handle, isInterval: false, fireAtMs })
    log.debug(`Armed task ${taskId} in ${Math.round(delay / 1000)}s`)
  }

  disarm(taskId: string): void {
    const entry = this.timers.get(taskId)
    if (entry) {
      this.clearHandle(entry)
      this.timers.delete(taskId)
    }
  }

  /** Clear the handle for an armed entry without removing it from the map. */
  private clearEntry(taskId: string): void {
    const entry = this.timers.get(taskId)
    if (entry) {
      this.clearHandle(entry)
      this.timers.delete(taskId)
    }
  }

  private clearHandle(entry: ArmedEntry): void {
    if (entry.isInterval) {
      clearInterval(entry.handle)
    } else {
      clearTimeout(entry.handle)
    }
  }

  private fire(taskId: string, fireAtMs: number): void {
    this.dueCb?.(taskId, fireAtMs)
  }
}
