/**
 * Pure 60-second sliding-window rate counter (LiteLLM local-counter style).
 *
 * Tracks per-provider request/token events so the routing engine can
 * deprioritize a provider that is already at its configured RPM/TPM ceiling
 * BEFORE issuing the call. Reactive: events are recorded post-turn by
 * `recordProviderOutcome`, so the window reflects the trailing minute, not a
 * pre-call estimate. Single-user volumes are tiny, so a plain pruned event
 * array beats minute-bucket coarseness. Clock is injected for deterministic
 * tests.
 */

export interface RateEvent {
  /** Epoch ms the request completed. */
  ts: number
  /** Total tokens the request used (0 when usage is unknown). */
  tokens: number
}

export const RATE_WINDOW_MS = 60_000

/**
 * Append one event and prune everything older than the window.
 * Returns a NEW array (callers store it immutably in zustand).
 */
export function recordRate(events: readonly RateEvent[], tokens: number, now: number): RateEvent[] {
  const cutoff = now - RATE_WINDOW_MS
  const next = events.filter((e) => e.ts > cutoff)
  next.push({ ts: now, tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0 })
  return next
}

/** Requests + tokens observed in the trailing window. */
export function currentRate(
  events: readonly RateEvent[],
  now: number
): { rpm: number; tpm: number } {
  const cutoff = now - RATE_WINDOW_MS
  let rpm = 0
  let tpm = 0
  for (const e of events) {
    if (e.ts > cutoff) {
      rpm++
      tpm += e.tokens
    }
  }
  return { rpm, tpm }
}
