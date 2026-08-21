// Visual-workflow runs → pet events. Observes the newest run row and maps its
// status to the radar: running→workflowRun, succeeded→success, failed→error.
// Tracks the (id, status) pair so an in-place status flip on the same run is
// detected. Dexie observation is injectable for testing.

import Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"
import type { PetEmit } from "../pet-event-bus"
import type { RowObserver } from "./goal-source"

/** Pure mapping from a run status to a pet emit (or null when ignored). */
export function runStatusToEmit(
  status: RunStatus
): { kind: "workflowRun" | "success" | "error"; xp: number } | null {
  switch (status) {
    case "running":
      return { kind: "workflowRun", xp: 0 }
    case "succeeded":
      return { kind: "success", xp: 6 }
    case "failed":
      return { kind: "error", xp: 0 }
    default:
      return null
  }
}

/* istanbul ignore next -- thin Dexie liveQuery wrapper, exercised at runtime */
const defaultObserver: RowObserver<WorkflowRunRow> = (onRows) => {
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const sub = Dexie.liveQuery(() =>
    getDb().workflowRuns.orderBy("startedAt").reverse().limit(1).toArray()
  ).subscribe({ next: onRows })
  return () => sub.unsubscribe()
}

export function wireWorkflowSource(
  emit: PetEmit,
  observe: RowObserver<WorkflowRunRow> = defaultObserver
): () => void {
  let last: { id: string; status: RunStatus } | null = null
  let started = false
  return observe((rows) => {
    const row = rows[0]
    if (!row) return
    if (last && last.id === row.id && last.status === row.status) return
    last = { id: row.id, status: row.status }
    if (!started) {
      started = true
      return
    }
    const mapped = runStatusToEmit(row.status)
    if (mapped)
      emit({ source: "workflow", kind: mapped.kind, xp: mapped.xp, meta: { runId: row.id } })
  })
}
