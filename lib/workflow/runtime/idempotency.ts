/**
 * Inngest-style step memoization cache. Each `(runId, stepId)` pair maps to
 * its successful output, so a crashed-and-resumed run replays nothing. The
 * cache is built per-run from the durable Dexie event log on the orchestrator's
 * boot path; subsequent step completions feed it incrementally.
 */

import { listRunEvents } from "./event-log"

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
        const output = (e.payload as { output?: unknown } | undefined)?.output
        cache.set(e.stepId, output)
      }
    }
    return cache
  }
}
