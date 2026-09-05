/**
 * Subscription glue between the durable `workflowRunEvents` stream and the TUI
 // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
 // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
 // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
 * run panel. The default `subscribe` wraps Dexie `Dexie.liveQuery(listRunEvents)` —
 * the same seam the desktop Runs panel and the IM progress runner use. Tests
 * inject a synchronous emitter. Folding is delegated to `foldRunEvents`.
 *
 * Failure to subscribe (liveQuery unavailable in some host) degrades silently:
 * the run still completes; the panel simply never populates.
 */
import Dexie, { type Subscription } from "dexie"
import { listRunEvents } from "@/lib/workflow/runtime/event-log"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"
import { foldRunEvents, type RunFoldState, type RunStepView } from "./workflow-run-fold"

export type RunWatchSubscribe = (
  runId: string,
  next: (events: WorkflowRunEventRow[]) => void
) => () => void

export interface RunWatchDeps {
  runId: string
  initial: RunStepView[]
  /** Receives the folded state plus the raw events that produced it (the latter
   * lets the step inspector surface per-step logs/output without a fresh read). */
  onState: (s: RunFoldState, events: WorkflowRunEventRow[]) => void
  /** Test seam; defaults to Dexie liveQuery over listRunEvents. */
  subscribe?: RunWatchSubscribe
}

function defaultSubscribe(
  runId: string,
  next: (events: WorkflowRunEventRow[]) => void
): () => void {
  const sub: Subscription = Dexie.liveQuery(() => listRunEvents(runId)).subscribe({
    next,
    error: () => {},
  })
  return () => sub.unsubscribe()
}

export function startRunWatch(deps: RunWatchDeps): { stop: () => void } {
  const subscribe = deps.subscribe ?? defaultSubscribe
  let unsub: (() => void) | null = null
  let stopped = false
  try {
    unsub = subscribe(deps.runId, (events) => {
      if (stopped) return
      try {
        deps.onState(foldRunEvents(deps.initial, events), events)
      } catch {
        // a malformed event / render must never crash the run
      }
    })
  } catch {
    // liveQuery unavailable — degrade to Footer-only progress
  }
  return {
    stop() {
      if (stopped) return
      stopped = true
      try {
        unsub?.()
      } catch {
        // ignore unsubscribe errors
      } finally {
        unsub = null
      }
    },
  }
}
