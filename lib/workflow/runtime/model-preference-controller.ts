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
      state = opts.cheapModel
        ? { preferCheap: true, modelHint: opts.cheapModel }
        : { preferCheap: true }
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
