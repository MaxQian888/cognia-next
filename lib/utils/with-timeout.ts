/**
 * Promise timeout wrapper — generic async utility used by any subsystem
 * that needs deterministic deadlines around opaque work.
 *
 * Original home: `lib/twin/distill/with-timeout.ts` (twin distill agents
 * wrap LLM round-trips so a hung provider call can't pin the
 * orchestrator). PR-B promoted this to `lib/utils/` so the plugin
 * runtime (loader teardown, IPC handler invocation) can reuse the
 * exact same helper without crossing twin's bounded context. Twin's
 * old path now re-exports from here for backward compatibility.
 *
 * Pure utility — no Dexie / no logger. Tests drive deterministic
 * clocks via jest's fake timers.
 */

/**
 * Default budget for twin's distill agents (90s). Twin's orchestrator
 * keeps reading this name; the constant lives here so the twin
 * re-export can stay one line.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 90_000

/**
 * Custom error class so callers can distinguish a timeout from a real
 * error via `instanceof TimeoutError`.
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
 * Race `promise` against a timeout. Resolves with the original value
 * when the promise settles in time; rejects with `TimeoutError`
 * otherwise.
 *
 * Note: there's no way to *cancel* the original promise from JS — we
 * just stop waiting on it. The underlying work may keep running in
 * the background. For LLM calls that's intentional (aborting
 * mid-flight loses the partial response without saving any tokens);
 * for plugin teardown the host treats the abandoned cleanup as a
 * dirty teardown and records it via `recordSilentFailure`.
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
 * Convenience wrapper: run a labeled async function under a timeout,
 * and if it throws (timeout or otherwise), return the caller-supplied
 * fallback value plus the error message — without re-throwing.
 *
 * Twin's distill orchestrator uses this to keep the pipeline marching
 * even when one agent dies; the only agent allowed to abort the whole
 * run is the Synthesizer (no synth ⇒ no drafts ⇒ no useful output).
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
