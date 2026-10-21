/**
 * The plugin contract's share of `lib/workflow/runtime/concurrency-controller.ts`, which re-exports these.
 */
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
