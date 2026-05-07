/**
 * Promise timeout wrapper for distill agents.
 *
 * The five sub-agents (`KnowledgeAgent`, `StyleAgent`, `PlaybookAgent`,
 * `Synthesizer`, `Evaluator`) each make at least one LLM round-trip — and
 * a hung provider call could otherwise pin the orchestrator forever. We
 * wrap each agent in `withTimeout` so a single slow agent triggers a
 * deterministic `TimeoutError` and the orchestrator can record it in
 * `partialFailures` without aborting the rest of the run.
 *
 * Pure utility — no Dexie / no logger. Tests drive deterministic clocks
 * via vitest's fake timers.
 */

export const DEFAULT_AGENT_TIMEOUT_MS = 90_000

/**
 * Custom error class so callers can distinguish a timeout from a real
 * provider error via `instanceof TimeoutError`.
 */
export class TimeoutError extends Error {
  constructor(
    public readonly label: string,
    public readonly timeoutMs: number
  ) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = "TimeoutError"
  }
}

/**
 * Race `promise` against a timeout. Resolves with the original value when
 * the promise settles in time; rejects with `TimeoutError` otherwise.
 *
 * Note: there's no way to *cancel* the original promise from JS — we just
 * stop waiting on it. The underlying provider call may keep running in
 * the background. That's intentional: aborting an LLM mid-flight loses
 * the partial response without saving any tokens.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

/**
 * Convenience wrapper: run a labeled async function under a timeout, and
 * if it throws (timeout or otherwise), return the caller-supplied
 * fallback value plus the error message — without re-throwing.
 *
 * The orchestrator uses this to keep the pipeline marching even when one
 * agent dies; the only agent allowed to abort the whole run is the
 * Synthesizer (no synth ⇒ no drafts ⇒ no useful output).
 */
export async function withTimeoutOrFallback<T>(
  fn: () => Promise<T>,
  label: string,
  options: {
    timeoutMs?: number
    fallback: T
    onError?: (label: string, message: string) => void
  }
): Promise<{ value: T; error: string | null }> {
  try {
    const value = await withTimeout(fn(), options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS, label)
    return { value, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    options.onError?.(label, message)
    return { value: options.fallback, error: message }
  }
}
