/**
 * Issue activity trail — Dexie table `issueEvents` (schema v170).
 *
 * Append-only, and shaped exactly like the three event tables that came
 * before it (`chatGoalEvents`, `agentPlanEvents`, `loopEvents`):
 * `{ id, <fk>, kind, ts, payload }` with the index string
 * `"&id, <fk>, [<fk>+ts], kind, ts"`. There is no shared generic `EventLog<T>`
 * in this repo — it is a copied pattern, deliberately, so each domain keeps a
 * discriminated payload the UI can render without runtime checks.
 *
 * Comments live here too (`kind: "commented"`) rather than in a table of their
 * own, so the issue detail panel renders one merged activity+comment timeline.
 * Comments are append-only, matching `AgentTaskComment`.
 *
 * Cascade-delete is the CRUD layer's job (`deleteIssueEvents`), never a Dexie
 * hook — same rule `lib/db/goals.ts` and `lib/db/plans.ts` follow.
 */

import type { IssueEvent, IssueEventPayload } from "@/types/issues"
import { getDb } from "./schema"

export interface AppendIssueEventInput {
  issueId: string
  payload: IssueEventPayload
  /**
   * Unix epoch ms. Normally omit it and let the module assign one — see
   * `nextEventTs`. Passed explicitly only by tests that need fixed values.
   */
  ts?: number
}

/**
 * Last timestamp this process handed out.
 *
 * `Date.now()` has millisecond resolution, which is NOT enough to order an
 * activity trail: creating an issue and labelling it, or any multi-field edit,
 * routinely produces several events inside one millisecond. Equal `ts` values
 * make the `[issueId+ts]` index fall back to primary-key order, and the
 * primary key is a random UUID — so the timeline came back shuffled.
 *
 * Auto-assigned timestamps are therefore forced strictly increasing. The skew
 * is at most a few milliseconds under burst and self-corrects as soon as the
 * wall clock catches up.
 */
let lastAssignedTs = 0

function nextEventTs(explicit?: number): number {
  if (explicit !== undefined) {
    // Honour injected values verbatim (tests depend on it), but let them raise
    // the watermark so a later auto-assigned event still sorts after them.
    if (explicit > lastAssignedTs) lastAssignedTs = explicit
    return explicit
  }
  const ts = Math.max(Date.now(), lastAssignedTs + 1)
  lastAssignedTs = ts
  return ts
}

/** Test-only: reset the monotonic watermark between cases. */
export function __resetIssueEventClockForTesting(): void {
  lastAssignedTs = 0
}

/**
 * Append one entry. `kind` is derived from the payload rather than passed
 * separately, so the indexed column can never disagree with the payload's
 * discriminator.
 */
export async function appendIssueEvent(input: AppendIssueEventInput): Promise<IssueEvent> {
  const event: IssueEvent = {
    id: crypto.randomUUID(),
    issueId: input.issueId,
    kind: input.payload.kind,
    ts: nextEventTs(input.ts),
    payload: input.payload,
  }
  await getDb().issueEvents.add(event)
  return event
}

/** Append several entries in one write (a multi-field edit produces several). */
export async function appendIssueEvents(
  inputs: readonly AppendIssueEventInput[]
): Promise<IssueEvent[]> {
  if (inputs.length === 0) return []
  const events = inputs.map((input) => ({
    id: crypto.randomUUID(),
    issueId: input.issueId,
    kind: input.payload.kind,
    ts: nextEventTs(input.ts),
    payload: input.payload,
  }))
  await getDb().issueEvents.bulkAdd(events)
  return events
}

export interface ListIssueEventsQuery {
  issueId: string
  /** Newest first when true (the detail panel's default). */
  descending?: boolean
  limit?: number
}

export async function listIssueEvents(query: ListIssueEventsQuery): Promise<IssueEvent[]> {
  const db = getDb()
  const collection = db.issueEvents
    .where("[issueId+ts]")
    .between([query.issueId, Number.NEGATIVE_INFINITY], [query.issueId, Number.POSITIVE_INFINITY])

  const rows = await (query.descending ? collection.reverse() : collection).toArray()
  return query.limit === undefined ? rows : rows.slice(0, query.limit)
}

/** Just the comments, oldest first — for the comment composer's thread. */
export async function listIssueComments(issueId: string): Promise<IssueEvent[]> {
  const rows = await listIssueEvents({ issueId })
  return rows.filter((event) => event.kind === "commented")
}

/** Cascade target for `deleteIssue`. */
export async function deleteIssueEvents(issueId: string): Promise<void> {
  await getDb().issueEvents.where("issueId").equals(issueId).delete()
}

/** Cascade target for deleting a whole issue-project. */
export async function deleteIssueEventsForIssues(issueIds: readonly string[]): Promise<void> {
  if (issueIds.length === 0) return
  await getDb()
    .issueEvents.where("issueId")
    .anyOf([...issueIds])
    .delete()
}
