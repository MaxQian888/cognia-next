/**
 * Rust alarm-daemon timing driver — the Tauri desktop timing source.
 *
 * Delegates timing to the in-process Rust alarm daemon
 * (`src-tauri/src/scheduler/daemon.rs`) so tasks fire while the window is
 * minimized to the tray (renderer timers are throttled on hidden webviews).
 * There is no leader election: the single native process is the sole authority.
 *
 * The daemon's `scheduler:task-due` event only signals "this id is due now"; to
 * keep the *scheduled slot* stable (important for interval cadence) we report
 * the originally-armed instant, tracked locally per task id.
 */

import type { SchedulerTimingDriver, TaskDueCallback } from "@/types/scheduler"

import { armTask, disarmTask, listenTaskDue } from "../daemon-bridge"

export class RustDaemonTimingDriver implements SchedulerTimingDriver {
  readonly supportsLeaderElection = false as const

  /** Armed instants by task id, so a fire reports the intended slot, not "now". */
  private armedAt = new Map<string, number>()
  private dueCb: TaskDueCallback | null = null
  private unlisten: (() => void) | null = null
  private startPromise: Promise<void> | null = null
  /** Preserve IPC mutation order per task (arm → re-arm/disarm). */
  private mutationQueues = new Map<string, Promise<void>>()
  /** Invalidates callbacks and async subscriptions from an earlier lifecycle. */
  private lifecycleVersion = 0

  async start(): Promise<void> {
    if (this.unlisten) return
    if (this.startPromise) return this.startPromise

    const version = ++this.lifecycleVersion
    const startPromise = (async () => {
      const unlisten = await listenTaskDue((event) => {
        if (version !== this.lifecycleVersion) return
        const fireAtMs = this.armedAt.get(event.taskId) ?? event.firedAtMs
        this.armedAt.delete(event.taskId)
        this.dueCb?.(event.taskId, fireAtMs)
      })

      if (version !== this.lifecycleVersion) {
        unlisten()
        return
      }
      this.unlisten = unlisten
    })()
    this.startPromise = startPromise
    try {
      await startPromise
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null
      }
    }
  }

  stop(): void {
    this.lifecycleVersion += 1
    this.unlisten?.()
    this.unlisten = null
    for (const taskId of Array.from(this.armedAt.keys())) {
      void this.disarm(taskId)
    }
  }

  onDue(cb: TaskDueCallback): void {
    this.dueCb = cb
  }

  arm(taskId: string, fireAtMs: number): Promise<void> {
    this.armedAt.set(taskId, fireAtMs)
    return this.enqueueMutation(taskId, () => armTask(taskId, fireAtMs))
  }

  disarm(taskId: string): Promise<void> {
    this.armedAt.delete(taskId)
    return this.enqueueMutation(taskId, () => disarmTask(taskId))
  }

  private enqueueMutation(taskId: string, mutation: () => Promise<void>): Promise<void> {
    const previous = this.mutationQueues.get(taskId) ?? Promise.resolve()
    const tracked = previous
      .catch(() => undefined)
      .then(mutation)
      .finally(() => {
        if (this.mutationQueues.get(taskId) === tracked) {
          this.mutationQueues.delete(taskId)
        }
      })
    this.mutationQueues.set(taskId, tracked)
    return tracked
  }
}
