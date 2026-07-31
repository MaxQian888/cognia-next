/**
 * Live subscription over a workflow's run history, mirroring `workflow-run-watch`
 * but for the run-LIST (used by an auto-refreshing `/workflow inspect`). The
 * default `subscribe` wraps Dexie `liveQuery(listWorkflowRuns)`; tests inject a
 * synchronous emitter. Failure to subscribe degrades silently — the overlay
 * simply shows its first (static) snapshot.
 */
import { liveQuery, type Subscription } from "dexie"
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
  const sub: Subscription = liveQuery(() => listWorkflowRuns({ workflowId })).subscribe({
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
