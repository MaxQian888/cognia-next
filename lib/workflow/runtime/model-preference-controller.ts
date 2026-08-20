/**
 * Run-scoped model preference signal. Producers (BudgetGuard handoff_to_background)
 * call `downshift()` to indicate cost-sensitive mode; node executors read `get()`
 * before invoking `executeAgent` and use `modelHint` when set.
 *
 * Downshift is one-way per run — there is no `upshift()`. The signal lives only
 * for the run's lifetime; new runs start fresh.
 */

export interface ModelPreferenceState {
  preferCheap: boolean
  modelHint?: string
}

export interface ModelPreferenceController {
  get(): ModelPreferenceState
  downshift(): void
  subscribe(fn: (state: ModelPreferenceState) => void): () => void
}

export interface ModelPreferenceControllerOptions {
  /** Model id to recommend after downshift (e.g., "claude-haiku-4-5-20251001"). */
  cheapModel?: string
  /**
   * Resolve the cheap lane lazily, at downshift time.
   *
   * Preferred over `cheapModel` for every real caller: the cheap lane depends
   * on the user's enabled providers and routing aliases, which a controller
   * constructed at run start has no business snapshotting — and one of the two
   * construction sites is synchronous, so it cannot await the catalog either.
   * Returning `undefined` is a valid answer and leaves the controller in the
   * `preferCheap`-only state, which is exactly the historical behaviour.
   */
  resolveCheapModel?: () => string | undefined
}

export function createModelPreferenceController(
  opts: ModelPreferenceControllerOptions = {}
): ModelPreferenceController {
  let state: ModelPreferenceState = { preferCheap: false }
  const listeners = new Set<(state: ModelPreferenceState) => void>()

  return {
    get: () => ({ ...state }),
    downshift: () => {
      if (state.preferCheap) return
      // Resolved here rather than at construction: the answer depends on live
      // settings, and a resolver that throws must not take the run with it —
      // a downshift that fails to find a lane still means "prefer cheap".
      let hint = opts.cheapModel
      if (!hint && opts.resolveCheapModel) {
        try {
          hint = opts.resolveCheapModel()
        } catch {
          hint = undefined
        }
      }
      state = hint ? { preferCheap: true, modelHint: hint } : { preferCheap: true }
      for (const fn of listeners) {
        try {
          fn({ ...state })
        } catch (err) {
          console.warn("ModelPreferenceController listener threw:", err)
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
