/**
 * Cascade detection — "these N failures are one incident, not N incidents".
 *
 * Extracted from `components/error/recent-errors-panel.tsx`, which has used
 * this exact rule (3 errors inside 5 seconds) since it shipped. The panel now
 * imports it back, so the error page and the diagnostic router agree on what a
 * cascade is instead of each carrying its own threshold.
 *
 * This matters most for the router: a sidecar crash produces a burst of
 * failures across every in-flight session, and surfacing each one separately
 * turns a single event into a wall of toasts.
 */

/** Three inside the window. Below that it reads as coincidence, not a cascade. */
export const CASCADE_THRESHOLD = 3

/** Errors from one incident land within a few hundred ms; 5s is generous. */
export const CASCADE_WINDOW_MS = 5000

/**
 * True when `timestamps` (epoch ms) contain at least {@link CASCADE_THRESHOLD}
 * entries spanning no more than {@link CASCADE_WINDOW_MS}.
 *
 * Non-finite values are dropped rather than treated as 0 — a single unparseable
 * timestamp would otherwise stretch the span to ~55 years and mask every real
 * cascade.
 */
export function isCascadingAt(timestamps: readonly number[]): boolean {
  const finite = timestamps.filter((value) => Number.isFinite(value))
  if (finite.length < CASCADE_THRESHOLD) return false
  return Math.max(...finite) - Math.min(...finite) <= CASCADE_WINDOW_MS
}

/** Convenience for callers holding ISO-8601 strings (the log ring). */
export function isCascadingIso(timestamps: readonly string[]): boolean {
  return isCascadingAt(timestamps.map((value) => Date.parse(value)))
}
