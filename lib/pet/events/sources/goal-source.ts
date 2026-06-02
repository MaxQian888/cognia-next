// /goal milestones → pet events. Observes the newest goal-event row and maps a
// completed turn to "goalProgress" and a goal exit to "goalComplete" (the biggest
// single XP award — finishing a goal is the pet's proudest moment).
//
// The Dexie observation is injectable so the mapping logic is unit-tested with a
// plain fake; the default observer uses Dexie's `liveQuery`.

import { liveQuery } from "dexie"
import { getDb } from "@/lib/db/schema"
import type { GoalEvent } from "@/types/goal"
import type { PetEmit } from "../pet-event-bus"

export type RowObserver<T> = (onRows: (rows: T[]) => void) => () => void

/** Pure mapping from a goal-event kind to a pet emit (or null when ignored). */
export function goalEventToEmit(
  kind: string
): { kind: "goalComplete" | "goalProgress"; xp: number } | null {
  if (kind === "exit_triggered") return { kind: "goalComplete", xp: 25 }
  if (kind === "turn_completed") return { kind: "goalProgress", xp: 5 }
  return null
}

/* istanbul ignore next -- thin Dexie liveQuery wrapper, exercised at runtime */
const defaultObserver: RowObserver<GoalEvent> = (onRows) => {
  const sub = liveQuery(() =>
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
    if (!row || row.id === lastId) return
    lastId = row.id
    if (!started) {
      // Ignore whatever was already newest when we attached.
      started = true
      return
    }
    const mapped = goalEventToEmit(row.kind)
    if (mapped)
      emit({ source: "goal", kind: mapped.kind, xp: mapped.xp, meta: { goalId: row.goalId } })
  })
}
