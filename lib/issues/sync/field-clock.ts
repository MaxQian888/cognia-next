/**
 * When did a person last change each synced field? (spec 2026-09-06, D2)
 *
 * The trail already records every edit with its time and its actor, so the
 * per-field clock the last-writer-wins rule needs is derived here instead of
 * being a column that every writer would have to remember to bump. Events
 * written by the sync engine itself (actor id `sync:<provider>`) do not
 * count: those are the remote's changes landing, not a local decision.
 */

import type { IssueEvent, IssueEventKind, IssueSyncField } from "@/types/issues"
import { isSyncActor } from "@/types/issues"

const EVENT_FIELD: Partial<Record<IssueEventKind, IssueSyncField>> = {
  title_changed: "title",
  description_changed: "description",
  status_changed: "status",
  priority_changed: "priority",
  assigned: "assignee",
  unassigned: "assignee",
  reassigned: "assignee",
  label_added: "labels",
  label_removed: "labels",
  due_date_changed: "dueDate",
  estimate_changed: "estimate",
  cycle_changed: "cycle",
}

/** The synced field an event kind edits, if any. */
export function syncFieldOfEvent(kind: IssueEventKind): IssueSyncField | undefined {
  return EVENT_FIELD[kind]
}

/**
 * Latest LOCAL change per field strictly after `since`. A `created` event is
 * not a field change: a fresh local issue has nothing to argue with yet.
 */
export function lastLocalChangeAt(
  events: readonly IssueEvent[],
  since: number
): Map<IssueSyncField, number> {
  const out = new Map<IssueSyncField, number>()
  for (const event of events) {
    if (event.ts <= since) continue
    const field = EVENT_FIELD[event.kind]
    if (!field) continue
    const by = (event.payload as { by?: Parameters<typeof isSyncActor>[0] }).by
    if (isSyncActor(by)) continue
    const previous = out.get(field) ?? 0
    if (event.ts > previous) out.set(field, event.ts)
  }
  return out
}
