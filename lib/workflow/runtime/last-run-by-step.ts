/**
 * `useLastRunByStep` — dexie live-query hook returning a `Map<stepId, ts>`
 * of the most recent `step_completed` (or terminal) event per step across
 * every run of `workflowId`.
 *
 * Rendered as a "last run X min ago" badge on the canvas node so users can
 * tell at a glance which steps actually fire. The hook is purely
 * client-side and reuses the same Dexie liveQuery the run timeline uses;
 * it adds a small reduce on the events stream rather than a new index.
 *
 * Returns an empty Map until the first events row settles.
 */

"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"

const TERMINAL_TYPES = new Set(["step_completed", "step_failed", "step_skipped"])

export function useLastRunByStep(workflowId: string | undefined): Map<string, number> {
  const map = useLiveQuery(
    async () => {
      if (!workflowId) return new Map<string, number>()
      const db = getDb()
      // Pull all runs for this workflow then their event windows. We could
      // index this differently but the run history is bounded (Phase 5
      // capped run-event volume per workflow); a simple scan is fine for
      // the editor sidebar's badge use.
      const runs = await db.workflowRuns.where("workflowId").equals(workflowId).toArray()
      const result = new Map<string, number>()
      for (const run of runs) {
        const events = await db.workflowRunEvents
          .where("[runId+ts]")
          .between([run.id, 0], [run.id, Number.MAX_SAFE_INTEGER])
          .toArray()
        for (const e of events) {
          if (!e.stepId) continue
          if (!TERMINAL_TYPES.has(e.type)) continue
          const prior = result.get(e.stepId)
          if (prior === undefined || e.ts > prior) {
            result.set(e.stepId, e.ts)
          }
        }
      }
      return result
    },
    [workflowId],
    new Map<string, number>()
  )
  return map ?? new Map<string, number>()
}
