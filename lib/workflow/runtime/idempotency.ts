/**
 * Inngest-style step memoization cache. Each `(runId, stepId)` pair maps to
 * its successful output, so a crashed-and-resumed run replays nothing. The
 * cache is built per-run from the durable Dexie event log on the orchestrator's
 * boot path; subsequent step completions feed it incrementally.
 */

import { listRunEvents } from "./event-log"

/**
 * Cache key for a child step executed inside a loop-container iteration —
 * `(runId, stepId)` becomes `(runId, loopId, iterationIndex, stepId)` so a
 * resumed run replays only the iterations that never completed.
 */
export function iterationCacheKey(loopId: string, iterationIndex: number, stepId: string): string {
  return `${loopId}#${iterationIndex}#${stepId}`
}

export class IdempotencyCache {
  private cache = new Map<string, unknown>()

  has(stepId: string): boolean {
    return this.cache.has(stepId)
  }

  get(stepId: string): unknown {
    return this.cache.get(stepId)
  }

  set(stepId: string, output: unknown): void {
    this.cache.set(stepId, output)
  }

  clear(): void {
    this.cache.clear()
  }

  /**
   * Hydrate from an existing run's event log. Used by the orchestrator on
   * boot to find where a crashed run should resume.
   */
  static async hydrate(runId: string): Promise<IdempotencyCache> {
    const cache = new IdempotencyCache()
    const events = await listRunEvents(runId)
    for (const e of events) {
      if (e.type === "step_completed" && e.stepId) {
        const payload = e.payload as
          | { output?: unknown; loopId?: string; iterationIndex?: number }
          | undefined
        // Loop-body completions hydrate under their per-iteration key ONLY —
        // a child id must never cache-hit at the top level.
        if (
          payload &&
          typeof payload.loopId === "string" &&
          typeof payload.iterationIndex === "number"
        ) {
          cache.set(
            iterationCacheKey(payload.loopId, payload.iterationIndex, e.stepId),
            payload.output
          )
        } else {
          cache.set(e.stepId, payload?.output)
        }
      }
    }
    return cache
  }
}
