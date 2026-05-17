/**
 * Dynamic concurrency limit for the workflow orchestrator's ready-set scheduler.
 *
 * Orchestrator reads `get()` each scheduling tick to decide how many tasks may
 * be in flight. Producers (BudgetGuard onCritical: reduce_concurrency, the team
 * synthesizer when opening an HITL gate) call `reduceTo(n)` to lower the cap.
 *
 * The cap is monotone non-increasing — production callers cannot raise it back
 * up. This avoids a race where a budget-triggered downshift gets immediately
 * undone by another producer.
 */

export interface ConcurrencyController {
  get(): number
  /** Lower the cap to `n`. No-op when `n >= current`. */
  reduceTo(n: number): void
  /** Fire `fn(newValue)` on each successful reduction. Returns unsubscribe. */
  subscribe(fn: (n: number) => void): () => void
}

export function createConcurrencyController(initial: number): ConcurrencyController {
  if (!Number.isInteger(initial)) {
    throw new Error(`createConcurrencyController: initial must be an integer, got ${initial}`)
  }
  if (initial < 0) {
    throw new Error(`createConcurrencyController: initial must be non-negative, got ${initial}`)
  }
  let current = initial
  const listeners = new Set<(n: number) => void>()
  return {
    get: () => current,
    reduceTo: (n: number) => {
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`reduceTo: n must be a non-negative integer, got ${n}`)
      }
      if (n >= current) return
      current = n
      for (const fn of listeners) {
        try {
          fn(current)
        } catch (err) {
          console.warn("ConcurrencyController listener threw:", err)
        }
      }
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
