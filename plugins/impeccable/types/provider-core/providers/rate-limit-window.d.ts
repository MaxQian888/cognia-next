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
interface RateEvent {
  /** Epoch ms the request completed. */
  ts: number
  /** Total tokens the request used (0 when usage is unknown). */
  tokens: number
}
declare const RATE_WINDOW_MS = 60000
/**
 * Append one event and prune everything older than the window.
 * Returns a NEW array (callers store it immutably in zustand).
 */
declare function recordRate(events: readonly RateEvent[], tokens: number, now: number): RateEvent[]
/** Requests + tokens observed in the trailing window. */
declare function currentRate(
  events: readonly RateEvent[],
  now: number
): {
  rpm: number
  tpm: number
}

export { RATE_WINDOW_MS, type RateEvent, currentRate, recordRate }
