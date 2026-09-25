// /goal milestones → pet events. Observes the newest goal-event row and maps a
// completed turn to "goalProgress" and a goal the judge declared done to
// "goalComplete" (the biggest single XP award — finishing a goal is the pet's
// proudest moment).
//
// Not every `exit_triggered` row finishes a goal: the turn driver also logs one
// for the resumable pauses (`judge_failed_too_many`, `needs_approval` → `paused`)
// and for the stops and limits. Only `judge_done` is rewarded; see
// `goalEventToEmit`.
//
// The Dexie observation is injectable so the mapping logic is unit-tested with a
// plain fake; the default observer uses Dexie's `liveQuery`.

import Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import type { GoalEvent, GoalEventPayload } from "@/types/goal"
import type { PetEmit } from "../pet-event-bus"

export type RowObserver<T> = (onRows: (rows: T[]) => void) => () => void

/**
 * Pure mapping from a goal-event payload to a pet emit (or null when ignored).
 *
 * `exit_triggered` becomes "goalComplete" only for `judge_done`, the one exit
 * that means the objective was met. It lands the goal in `completed`, a terminal
 * status, so a goal pays the completion award at most once, however many times
 * it was paused and resumed.
 *
 * Every other exit deliberately emits nothing rather than a smaller award:
 * - The paused exits (`judge_failed_too_many`, `needs_approval`) are a failure
 *   or a blocker. Paying for them would reward every pause → resume cycle.
 * - The terminal non-success exits (`user_stopped`, `preempted`, the turn,
 *   budget and cost limits, `timed_out`) end the goal without meeting it.
 *   "goalComplete" celebrates ("Victory!", a congratulation, the goal-count
 *   achievement), which would be wrong for a goal that was stopped or ran out.
 * - The turns before any exit already paid "goalProgress" each.
 * - The zero-XP radar kinds don't fit. "waiting" and "error" are resting visual
 *   states, not transient ones, and the goal side has no event that would clear
 *   them, so the pet would stay stuck in them.
 */
export function goalEventToEmit(
  payload: GoalEventPayload
): { kind: "goalComplete" | "goalProgress"; xp: number } | null {
  if (payload.kind === "exit_triggered") {
    return payload.exit === "judge_done" ? { kind: "goalComplete", xp: 25 } : null
  }
  if (payload.kind === "turn_completed") return { kind: "goalProgress", xp: 5 }
  return null
}

/* istanbul ignore next -- thin Dexie liveQuery wrapper, exercised at runtime */
const defaultObserver: RowObserver<GoalEvent> = (onRows) => {
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const sub = Dexie.liveQuery(() =>
    getDb().chatGoalEvents.orderBy("ts").reverse().limit(1).toArray()
  ).subscribe({ next: onRows })
  return () => sub.unsubscribe()
}

export function wireGoalSource(
  emit: PetEmit,
  observe: RowObserver<GoalEvent> = defaultObserver
): () => void {
  let lastId: string | null = null
  let started = false
  return observe((rows) => {
    const row = rows[0]
    if (!started) {
      // Ignore whatever was already newest when we attached. The baseline is
      // taken on the FIRST callback even when the table is empty: returning
      // before marking it would make the first real row the baseline, and a
      // brand-new user's first goal progress would never reach the pet.
      started = true
      lastId = row?.id ?? null
      return
    }
    if (!row || row.id === lastId) return
    lastId = row.id
    const mapped = goalEventToEmit(row.payload)
    if (mapped)
      emit({ source: "goal", kind: mapped.kind, xp: mapped.xp, meta: { goalId: row.goalId } })
  })
}
