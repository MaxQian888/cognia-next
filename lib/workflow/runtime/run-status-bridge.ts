/**
 * Live run-status bridge — subscribes to `workflowRunEvents` for the
 * currently-edited workflow and pushes each step's status into the editor
 * store. The canvas uses this to draw a green/red/spinning ring on each
 * node as a run progresses.
 *
 * The bridge is a passive observer: it does NOT initiate runs and it does
 * NOT mutate the run timeline. It just reads the durable event log and
 * derives the latest per-step status.
 */

import { useEffect } from "react"
import { liveQuery, type Subscription } from "dexie"
import type { EditorStore, NodeRunStatus } from "@/lib/workflow/editor/store"
import { getDb } from "@/lib/db/index"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

interface BridgeOptions {
  workflowId: string
  store: EditorStore
}

/**
 * Convert a sequence of run events for a single run into the latest per-step
 * status. Later events for the same stepId override earlier ones. Run-level
 * events (run_started / run_completed) are ignored — we only care about per-
 * step state.
 */
export function deriveRunStatusFromEvents(
  events: WorkflowRunEventRow[]
): Record<string, NodeRunStatus> {
  // Iterate in chronological order so later events win.
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  const out: Record<string, NodeRunStatus> = {}
  for (const ev of sorted) {
    if (!ev.stepId) continue
    switch (ev.type) {
      case "step_started":
        out[ev.stepId] = "running"
        break
      case "step_completed":
        out[ev.stepId] = "succeeded"
        break
      case "step_failed":
        out[ev.stepId] = "failed"
        break
      case "step_skipped":
        out[ev.stepId] = "skipped"
        break
      default:
        // run_log / run_progress and run-level events don't change a step's
        // visual state; ignore.
        break
    }
  }
  return out
}

/**
 * Start the live subscription. Returns an unsubscribe function. The caller is
 * responsible for invoking it on unmount.
 *
 * The subscription tracks the most-recent run for the workflow (highest
 * `createdAt`); older runs' events do not affect the canvas. When a new run
 * starts, the previous run's state is cleared so the user sees fresh rings.
 */
export function startRunStatusBridge(opts: BridgeOptions): () => void {
  const { workflowId, store } = opts
  let lastRunId: string | null = null
  let eventsSubscription: Subscription | null = null

  function unsubscribeEvents() {
    if (eventsSubscription) {
      eventsSubscription.unsubscribe()
      eventsSubscription = null
    }
  }

  const runsObservable = liveQuery(async () => {
    // The schema indexes `[workflowId+startedAt]` (see lib/db/schema.ts v22).
    // Using a different field here would silently throw inside the live query
    // and the bridge would never emit — the canvas rings would stay grey
    // even mid-run. Keep this in lockstep with the schema.
    const rows = await getDb()
      .workflowRuns.where("[workflowId+startedAt]")
      .between([workflowId, 0], [workflowId, Number.POSITIVE_INFINITY])
      .reverse()
      .limit(1)
      .toArray()
    return rows[0] ?? null
  })

  const runsSubscription = runsObservable.subscribe({
    next(latestRun) {
      if (!latestRun) {
        // Transient `null` emissions can happen mid-`put()` (Dexie liveQuery
        // re-runs the query before the write fully commits — most reliably
        // seen under fake-indexeddb). Treat empty emissions as "nothing
        // changed" so a same-id update doesn't double-clear the canvas
        // rings. If the user genuinely deletes the only run mid-edit, the
        // stale rings stay until they navigate away — acceptable, since
        // this is a best-effort visual hint.
        return
      }
      if (latestRun.id === lastRunId) return
      // New run — reset and start tracking it.
      lastRunId = latestRun.id
      store.getState().clearRunStatus()
      unsubscribeEvents()
      const eventsObservable = liveQuery(async () => {
        return getDb()
          .workflowRunEvents.where("[runId+ts]")
          .between([latestRun.id, 0], [latestRun.id, Number.POSITIVE_INFINITY])
          .toArray()
      })
      eventsSubscription = eventsObservable.subscribe({
        next(events) {
          const next = deriveRunStatusFromEvents(events)
          store.getState().setRunStatusBatch(next)
        },
        error() {
          // Swallow — the bridge is best-effort and shouldn't crash the editor.
        },
      })
    },
    error() {
      // Same: swallow.
    },
  })

  return () => {
    runsSubscription.unsubscribe()
    unsubscribeEvents()
  }
}

/**
 * React hook wrapper. Mount inside the canvas component for the lifetime of
 * the editor; unmounts automatically clean up.
 */
export function useRunStatusBridge(workflowId: string, store: EditorStore): void {
  useEffect(() => {
    if (!workflowId) return undefined
    return startRunStatusBridge({ workflowId, store })
  }, [workflowId, store])
}
