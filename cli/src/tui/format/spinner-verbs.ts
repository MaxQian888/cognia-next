/**
 * Playful "working" verbs the footer cycles through while a turn runs — the
 * Claude Code / OpenCode touch that makes a busy spinner feel alive instead of a
 * static "working". Pure: the verb for a given tick is a deterministic function
 * of the tick, so the animated `WorkingIndicator` owns the only timer and this
 * stays trivially testable.
 */

/** The rotation. `Working` leads so the very first frame reads plainly. */
export const SPINNER_VERBS: readonly string[] = [
  "Working",
  "Pondering",
  "Clauding",
  "Brewing",
  "Conjuring",
  "Computing",
  "Crunching",
  "Synthesizing",
  "Noodling",
  "Tinkering",
  "Percolating",
  "Mulling",
  "Cogitating",
  "Wrangling",
  "Assembling",
  "Forging",
  "Distilling",
  "Channeling",
  "Untangling",
  "Spelunking",
  "Marinating",
  "Orchestrating",
  "Calibrating",
  "Scheming",
]

/** The verb for a given animation tick, wrapping the list. Negative ticks wrap
 * safely too (defensive — the ticker only ever counts up). */
export function spinnerVerb(tick: number, verbs: readonly string[] = SPINNER_VERBS): string {
  if (verbs.length === 0) return "Working"
  const i = ((Math.trunc(tick) % verbs.length) + verbs.length) % verbs.length
  return verbs[i]
}
