/**
 * Generic async mutex — serializes value-returning, error-propagating
 * critical sections.
 *
 * Why this exists: `lib/connectors/outbound-runner.ts:ConversationLane`
 * already chains work with the `tail = tail.then(...)` pattern, but it
 * SWALLOWS errors (`.catch(() => {})`) and returns no value — correct for
 * a fire-and-forget delivery lane, wrong for a lock whose caller must see
 * the result and the error. The plugin Dexie schema bump
 * (`lib/plugin/dexie/bridge.ts`) needs both: a failed `version().stores()`
 * must propagate to `enablePlugin`, yet one caller's failure must not stall
 * the next caller's turn.
 *
 * `runExclusive` returns the body's resolved value (or rejects with its
 * error) to THE CALLER, while the internal `tail` advances regardless of
 * outcome so the chain never deadlocks on a rejection.
 *
 * Pure utility — no clock, no Dexie, no logger.
 */

export interface Mutex {
  /**
   * Run `fn` once all previously-enqueued sections have settled. Resolves
   * with `fn`'s value or rejects with its error. A rejection here does NOT
   * break the queue for subsequent callers.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
  /** True while a section is queued or running (best-effort introspection). */
  isLocked(): boolean
}

export function createMutex(): Mutex {
  // `tail` always resolves — we attach a swallowing continuation so a
  // rejected section can't poison the chain for the next caller.
  let tail: Promise<void> = Promise.resolve()
  let depth = 0

  return {
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      depth++
      // The caller's result: start `fn` only after the prior tail settles,
      // then carry `fn`'s outcome straight back to this caller.
      const run = tail.then(() => fn())
      // Advance the shared tail, swallowing this section's outcome so the
      // next caller waits for completion but never inherits the error.
      tail = run.then(
        () => undefined,
        () => undefined
      )
      // Decrement once this section settles, regardless of outcome.
      void tail.then(() => {
        depth--
      })
      return run
    },
    isLocked(): boolean {
      return depth > 0
    },
  }
}
