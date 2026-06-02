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

  async start(): Promise<void> {
    if (this.unlisten) return
    this.unlisten = await listenTaskDue((event) => {
      const fireAtMs = this.armedAt.get(event.taskId) ?? event.firedAtMs
      this.armedAt.delete(event.taskId)
      this.dueCb?.(event.taskId, fireAtMs)
    })
  }

  stop(): void {
    this.unlisten?.()
    this.unlisten = null
    this.armedAt.clear()
  }

  onDue(cb: TaskDueCallback): void {
    this.dueCb = cb
  }

  arm(taskId: string, fireAtMs: number): void {
    this.armedAt.set(taskId, fireAtMs)
    void armTask(taskId, fireAtMs)
  }

  disarm(taskId: string): void {
    this.armedAt.delete(taskId)
    void disarmTask(taskId)
  }
}
