import { deleteGoalEventsForGoals, pruneGoalEvents } from "@/lib/db/goals"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { Goal, GoalEvent } from "@/types/goal"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull `/goal` console rows (`chatGoals`) from the desktop so the mobile
 * companion's Goals view can render progress offline. Read-mostly mirror —
 * goals are authored/driven on the desktop; the phone only displays them.
 *
 * A goal tombstone also removes the goal's mirrored events
 * ({@link deleteGoalRows}): every host path that deletes events deletes their
 * goal and tombstones it (`deleteGoal`, `deleteGoalsForSession`, the session
 * delete cascade), so the event log needs no tombstones of its own.
 */
export function syncGoals(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<Goal>(
    {
      table: "goals",
      getTable: () => getDb().chatGoals,
      applyDeletes: deleteGoalRows,
    },
    transport,
    cursor
  )
}

/** Drop tombstoned goals together with their events, in one transaction. */
export async function deleteGoalRows(
  ids: string[],
  assertCurrent: () => void = () => {}
): Promise<void> {
  if (ids.length === 0) return
  assertCurrent()
  const db = getDb()
  await db.transaction("rw", db.chatGoals, db.chatGoalEvents, async () => {
    await deleteGoalEventsForGoals(ids)
    await db.chatGoals.bulkDelete(ids)
  })
}

/**
 * A goal event as it crosses the wire.
 *
 * Everything the Activity tab, the Overview's loop and judge sections, the
 * console's judge notes and `/goal status` render crosses unchanged: those
 * payloads carry the redacted objective and the config the `goals` row
 * already sends, plus the judge's verdicts and verifier summaries about it.
 * `judge_parse_failed.raw` does not: it is the judge model's unparsed output,
 * stored for host-side debugging, rendered nowhere, and of unbounded length,
 * so it is emptied. Nothing else is dropped, and nothing is added.
 */
export function projectGoalEventForSync(event: GoalEvent): GoalEvent {
  if (event.payload.kind !== "judge_parse_failed") return event
  return { ...event, payload: { ...event.payload, raw: "" } }
}

/**
 * Pull the goal event log (`chatGoalEvents`, wire name `goalEvents`) so a
 * paired phone's goal detail (Activity, Overview), its console's judge notes
 * and `/goal status` read the same history the desktop does.
 *
 * Paged on the host by `ts` with the event id as the tie-breaker (an event is
 * appended once and never edited). The host keeps the newest
 * `EVENTS_PER_GOAL_CAP` events per goal without tombstones, so the mirror
 * trims each goal a page touched to the same cap. A deleted goal's events go
 * with the goal's tombstone ({@link syncGoals}).
 */
export function syncGoalEvents(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<GoalEvent>(
    {
      table: "goalEvents",
      getTable: () => getDb().chatGoalEvents,
      applyRows: applyGoalEventRows,
    },
    transport,
    cursor
  )
}

/** Upsert a slice of events (re-applying one is a no-op), then trim each goal to the cap. */
export async function applyGoalEventRows(
  rows: GoalEvent[],
  assertCurrent: () => void = () => {}
): Promise<void> {
  if (rows.length === 0) return
  assertCurrent()
  await getDb().chatGoalEvents.bulkPut(rows)
  assertCurrent()
  await pruneGoalEvents(rows.map((row) => row.goalId))
}
