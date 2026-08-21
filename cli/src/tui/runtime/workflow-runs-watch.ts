/**
 * Live subscription over a workflow's run history, mirroring `workflow-run-watch`
 * but for the run-LIST (used by an auto-refreshing `/workflow inspect`). The
 // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
 // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
 // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
 * default `subscribe` wraps Dexie `Dexie.liveQuery(listWorkflowRuns)`; tests inject a
 * synchronous emitter. Failure to subscribe degrades silently — the overlay
 * simply shows its first (static) snapshot.
 */
import Dexie, { type Subscription } from "dexie"
import { listWorkflowRuns } from "@/lib/db/workflows"
import type { WorkflowRunRow } from "@/types/workflow/visual"

export type RunsWatchSubscribe = (
  workflowId: string,
  next: (runs: WorkflowRunRow[]) => void
) => () => void

export interface RunsWatchDeps {
  workflowId: string
  onRuns: (runs: WorkflowRunRow[]) => void
  /** Test seam; defaults to Dexie liveQuery over listWorkflowRuns. */
  subscribe?: RunsWatchSubscribe
}

function defaultSubscribe(workflowId: string, next: (runs: WorkflowRunRow[]) => void): () => void {
  const sub: Subscription = Dexie.liveQuery(() => listWorkflowRuns({ workflowId })).subscribe({
    next,
    error: () => {},
  })
  return () => sub.unsubscribe()
}

export function startRunsWatch(deps: RunsWatchDeps): { stop: () => void } {
  const subscribe = deps.subscribe ?? defaultSubscribe
  let unsub: (() => void) | null = null
  try {
    unsub = subscribe(deps.workflowId, (runs) => {
      try {
        deps.onRuns(runs)
      } catch {
        // a render error must never crash the run-list watch
      }
    })
  } catch {
    // liveQuery unavailable — keep the static snapshot
  }
  return {
    stop() {
      try {
        unsub?.()
      } catch {
        // ignore unsubscribe errors
      }
    },
  }
}
