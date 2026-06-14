/**
 * Debounced, stale-guarded loader for the composer's async `@` mention sources
 * (skills/agents). Pure of React: the `Input` effect drives it, but the timer +
 * generation logic lives here so it's unit-testable with fake timers.
 *
 * Guarantees:
 *   - rapid `request(key)` calls within the debounce window coalesce to ONE
 *     underlying `load` (for the latest key);
 *   - a slow `load` whose result lands after a newer request is dropped
 *     (monotonic generation counter);
 *   - `loading` flips true the moment a request is scheduled and false when its
 *     result settles, so the popup can show a `loading…` affordance immediately.
 */
import type { MentionCandidate } from "./types"

export const MENTION_DEBOUNCE_MS = 150

export interface MentionLoadResult {
  loading: boolean
  candidates: MentionCandidate[]
}

export interface MentionLoader {
  /** Schedule a (debounced) load for `key`; emits loading=true now, then the
   * result (loading=false) when the latest load settles. */
  request(key: string, onResult: (r: MentionLoadResult) => void): void
  /** Drop any pending timer + in-flight load (bumps the generation). */
  cancel(): void
}

/**
 * Build a loader over `load(key) → candidates`. `debounceMs` defaults to
 * {@link MENTION_DEBOUNCE_MS}.
 */
export function createMentionLoader(
  load: (key: string) => Promise<MentionCandidate[]>,
  debounceMs = MENTION_DEBOUNCE_MS
): MentionLoader {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    request(key, onResult) {
      clearTimer()
      const gen = ++generation
      onResult({ loading: true, candidates: [] })
      timer = setTimeout(() => {
        timer = null
        void load(key)
          .then((candidates) => {
            if (gen === generation) onResult({ loading: false, candidates })
          })
          .catch(() => {
            if (gen === generation) onResult({ loading: false, candidates: [] })
          })
      }, debounceMs)
    },
    cancel() {
      clearTimer()
      generation++
    },
  }
}
