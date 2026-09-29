/**
 * The activity trail as the two inspectors list it (desktop panel, mobile
 * sheet): one row per trail entry, except that consecutive `run_failed`
 * entries collapse into one row with a count.
 *
 * A run that keeps failing — an engine refusing on every retry, a wakeup
 * re-dispatching into the same wall — otherwise buries every other entry
 * under identical lines. The newest failure is the one kept, because its
 * error is the current one; the count says how many it stands for. Any other
 * entry in between breaks the run, so nothing that happened between two
 * failures is hidden.
 */

import type { IssueEvent } from "@/types/issues"

export interface IssueActivityRow {
  event: IssueEvent
  /** How many consecutive entries of the same collapsible kind this row stands for. 1 = itself. */
  repeats: number
}

const COLLAPSIBLE: ReadonlySet<IssueEvent["kind"]> = new Set(["run_failed"])

/** `events` in display order (either direction works: only adjacency matters). */
export function collapseActivity(events: readonly IssueEvent[]): IssueActivityRow[] {
  const rows: IssueActivityRow[] = []
  for (const event of events) {
    const previous = rows[rows.length - 1]
    if (previous && COLLAPSIBLE.has(event.kind) && previous.event.kind === event.kind) {
      previous.repeats += 1
      continue
    }
    rows.push({ event, repeats: 1 })
  }
  return rows
}
