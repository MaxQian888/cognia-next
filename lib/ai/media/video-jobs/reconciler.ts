/**
 * Background checker for video jobs (ADR-0205).
 *
 * One window polls: the reconciler takes a Web Lock and only works while it
 * holds it, so several open windows do not each ask the provider about the
 * same job. The lock is released when its window closes, and the next window
 * waiting on it takes over. Without Web Locks every window polls; the
 * status-guarded claim in the store still lets only one of them download.
 *
 * Shaped like the connector heartbeat sweep: one timer, the due jobs checked
 * together with `Promise.allSettled`, and an overlap guard so a slow tick is
 * skipped rather than stacked.
 */

import type { VideoJobEngine } from "./engine"
import type { MediaJobStore } from "./store"

export const VIDEO_JOB_LOCK_NAME = "cognia-video-job-reconciler"
const VIDEO_JOB_SWEEP_INTERVAL_MS = 5_000

interface LockManagerLike {
  request(
    name: string,
    options: { signal: AbortSignal },
    callback: () => Promise<void>
  ): Promise<unknown>
}

export interface VideoJobReconcilerOptions {
  /** Read on every tick, so a host installed later is picked up. */
  engine(): VideoJobEngine
  store(): MediaJobStore
  now?: () => number
  intervalMs?: number
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
  /** Web Locks; `null` runs without an election. Defaults to `navigator.locks`. */
  locks?: LockManagerLike | null
  onError?: (error: unknown) => void
}

export interface VideoJobReconcilerHandle {
  dispose(): void
}

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null
  const locks = (navigator as { locks?: LockManagerLike }).locks
  return locks && typeof locks.request === "function" ? locks : null
}

export function startVideoJobReconciler(
  options: VideoJobReconcilerOptions
): VideoJobReconcilerHandle {
  const now = options.now ?? Date.now
  const intervalMs = options.intervalMs ?? VIDEO_JOB_SWEEP_INTERVAL_MS
  const scheduler = options.scheduler ?? {
    setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  }
  const locks = options.locks === undefined ? defaultLocks() : options.locks
  const report = options.onError ?? (() => undefined)
  const abort = new AbortController()
  let timer: unknown = null
  let sweeping = false

  /**
   * A job left `downloading` was interrupted mid-download (its window closed).
   * Put it back to `generating` so it is checked again: a still-valid result
   * URL is downloaded again, an expired one settles `result_expired`.
   */
  async function recoverInterrupted(): Promise<void> {
    const store = options.store()
    const at = now()
    for (const row of await store.listByStatus("downloading")) {
      await store.transition(row.id, "downloading", "generating", {
        nextPollAt: at,
        updatedAt: at,
      })
    }
  }

  async function sweep(): Promise<void> {
    const due = await options.store().listDue("generating", now())
    if (due.length === 0) return
    const engine = options.engine()
    const results = await Promise.allSettled(due.map((row) => engine.poll(row.id)))
    for (const result of results) if (result.status === "rejected") report(result.reason)
  }

  const tick = () => {
    if (abort.signal.aborted || sweeping) return
    sweeping = true
    void sweep()
      .catch(report)
      .finally(() => {
        sweeping = false
      })
  }

  async function lead(): Promise<void> {
    if (abort.signal.aborted) return
    await recoverInterrupted().catch(report)
    tick()
    timer = scheduler.setInterval(tick, intervalMs)
  }

  if (locks) {
    locks
      .request(VIDEO_JOB_LOCK_NAME, { signal: abort.signal }, async () => {
        await lead()
        // Hold the lock until this window stops the reconciler.
        await new Promise<void>((resolve) => {
          if (abort.signal.aborted) resolve()
          else abort.signal.addEventListener("abort", () => resolve(), { once: true })
        })
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return
        report(error)
      })
  } else {
    void lead()
  }

  return {
    dispose() {
      if (abort.signal.aborted) return
      abort.abort()
      if (timer !== null) scheduler.clearInterval(timer)
    },
  }
}
