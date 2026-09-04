/**
 * Step memoization for any durable runtime, not just the visual workflow
 * orchestrator.
 *
 * The rule an Inngest-style durable handler depends on is small: a step that
 * already completed must never run twice, even when the process that ran it
 * died and the handler is re-entered from the top. That needs exactly two
 * things, a `(runId, stepId) -> output` map and a way to rebuild the map from
 * whatever durable log the runtime already writes.
 *
 * The second half is why this module takes the completions as an argument
 * instead of reading a table. The workflow orchestrator's log is
 * `workflowRunEvents`. A Bot run's log is `executionRunEvents`. Both can
 * project onto {@link DurableStepCompletion}, and neither has to know the
 * other exists.
 */

/**
 * One replayed step completion. `loopId` and `iterationIndex` are present only
 * for a step that ran inside a loop container: those hydrate under their
 * per-iteration key ONLY, because a child id that cache-hit at the top level
 * would skip every later iteration of the same body.
 */
export interface DurableStepCompletion {
  stepId: string
  output: unknown
  loopId?: string
  iterationIndex?: number
}

/**
 * Cache key for a child step executed inside a loop-container iteration.
 * `(runId, stepId)` becomes `(runId, loopId, iterationIndex, stepId)` so a
 * resumed run replays only the iterations that never completed.
 */
export function iterationCacheKey(loopId: string, iterationIndex: number, stepId: string): string {
  return `${loopId}#${iterationIndex}#${stepId}`
}

export class StepMemoCache {
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
   * Fill the cache from replayed completions. Returns `this` so a caller can
   * write `new StepMemoCache().hydrateFrom(...)` in one expression.
   *
   * Writes go through `set`, so a subclass that redirects storage (a prefixed
   * view, say) hydrates into the same place its reads come from.
   */
  hydrateFrom(completions: Iterable<DurableStepCompletion>): this {
    for (const completion of completions) {
      if (typeof completion.loopId === "string" && typeof completion.iterationIndex === "number") {
        this.set(
          iterationCacheKey(completion.loopId, completion.iterationIndex, completion.stepId),
          completion.output
        )
      } else {
        this.set(completion.stepId, completion.output)
      }
    }
    return this
  }
}
