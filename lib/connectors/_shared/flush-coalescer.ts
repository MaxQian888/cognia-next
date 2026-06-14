/**
 * In-flight flush coalescer — the shared "one flush at a time, collapse a burst
 * into a single follow-up" guard used by both the live-activity dispatcher
 * (`lib/connectors/activity/turn-activity-dispatcher.ts`) and the workflow
 * progress runner (`lib/connectors/a2ui-bridge/workflow-progress-runner.ts`).
 *
 * Both previously reimplemented the identical control flow:
 *
 *   if (flushing) { flushQueued = true; <merge payload>; return }
 *   flushing = true
 *   try { await run(payload) }
 *   finally {
 *     flushing = false
 *     if (flushQueued) { flushQueued = false; queue a microtask to run again }
 *   }
 *
 * The microtask requeue (`Promise.resolve().then(...)`) is load-bearing: it
 * yields the event loop so a Dexie write settles before the next flush, and the
 * connector test suites drain on that exact scheduling. This helper preserves it
 * verbatim.
 *
 * Payload semantics: a run carries a `TPayload`. While a run is in flight, any
 * `schedule(next)` coalesces `next` into the queued payload via `merge`, seeded
 * from the CURRENTLY-RUNNING payload on the first coalesce of a chain. That
 * "seed from the running payload" rule is what lets the activity dispatcher
 * freeze its `now` at the value the chain started with (the requeue reuses the
 * running flush's `now`, not the queued event's) — preserving the original
 * behavior exactly. For a payload-less consumer (the workflow runner), pass
 * `void`/`undefined` and the default identity merge.
 */
export class FlushCoalescer<TPayload> {
  private running = false
  private queued = false
  private queuedPayload: TPayload | undefined
  private currentPayload: TPayload | undefined

  constructor(
    private readonly run: (payload: TPayload) => Promise<void>,
    /**
     * Combine the accumulated payload (seeded from the running payload on the
     * first coalesce) with the incoming one. Defaults to last-wins.
     */
    private readonly merge: (prev: TPayload | undefined, next: TPayload) => TPayload = (_p, n) => n
  ) {}

  /** True while a run is in flight. */
  get busy(): boolean {
    return this.running
  }

  /**
   * Schedule a flush. Runs immediately when idle; otherwise coalesces into the
   * single queued follow-up. The returned promise resolves once THIS call's
   * synchronous bookkeeping (or, when it ran immediately, its `run`) settles —
   * callers fire-and-forget it exactly like the original `void this.flush(...)`.
   */
  async schedule(payload: TPayload): Promise<void> {
    if (this.running) {
      this.queuedPayload = this.merge(
        this.queued ? this.queuedPayload : this.currentPayload,
        payload
      )
      this.queued = true
      return
    }
    this.running = true
    this.currentPayload = payload
    try {
      await this.run(payload)
    } finally {
      this.running = false
      if (this.queued) {
        this.queued = false
        const next = this.queuedPayload as TPayload
        this.queuedPayload = undefined
        this.currentPayload = undefined
        void Promise.resolve().then(() => this.schedule(next))
      } else {
        this.currentPayload = undefined
      }
    }
  }
}
