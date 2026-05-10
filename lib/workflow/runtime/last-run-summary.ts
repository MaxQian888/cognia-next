/**
 * Per-step "last run" summaries derived from `workflowRunEvents`. Powers the
 * canvas node footer ("Ran 12s ago · 1.4s") and the inspector's run history
 * tab badge.
 *
 * The derivation is a pure function over an event list so we can unit-test
 * it without Dexie. The hook below wraps it in a `liveQuery` that streams
 * across every run of a workflow.
 *
 * Distinct from `run-status-bridge.ts`, which only tracks the single
 * most-recent run's live state. This module aggregates across history so
 * users see the *previous* run's outcome on each node when they reopen the
 * editor.
 */

"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

/** One step's outcome from its most recent terminal event. */
export type LastRunStatus = "succeeded" | "failed" | "skipped"

export interface LastRunSummary {
  status: LastRunStatus
  /** Wall-clock when the step started (last attempt). May be 0 if missing. */
  startedAt: number
  /** Wall-clock when the step ended (terminal event). */
  finishedAt: number
  /** finishedAt - startedAt; 0 when startedAt is missing. */
  durationMs: number
  /** First line of the failure message, if status is "failed". */
  errorMessage?: string
  /** Number of retry attempts collapsed into this entry. */
  attempt: number
}

const TERMINAL_TYPES = new Set<string>(["step_completed", "step_failed", "step_skipped"])

function statusFromType(type: string): LastRunStatus | null {
  switch (type) {
    case "step_completed":
      return "succeeded"
    case "step_failed":
      return "failed"
    case "step_skipped":
      return "skipped"
    default:
      return null
  }
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const obj = payload as Record<string, unknown>
  const msg = obj.message ?? obj.error
  if (typeof msg === "string") return msg.split("\n")[0]
  if (msg && typeof msg === "object") {
    const inner = (msg as Record<string, unknown>).message
    if (typeof inner === "string") return inner.split("\n")[0]
  }
  return undefined
}

/**
 * Derive per-step summaries from a chronological sequence of events.
 * Called by tests with a hand-built array; the hook below feeds it
 * Dexie-fetched rows.
 *
 * Algorithm:
 *   1. Sort by ts.
 *   2. Track per-stepId: latest start ts + retry count.
 *   3. On terminal event: emit a summary keyed by stepId. Subsequent
 *      terminal events overwrite (so the *latest* run wins).
 */
export function deriveLastRunSummary(
  events: ReadonlyArray<WorkflowRunEventRow>
): Record<string, LastRunSummary> {
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  const startedAt: Record<string, number> = {}
  const attempts: Record<string, number> = {}
  const out: Record<string, LastRunSummary> = {}
  for (const ev of sorted) {
    if (!ev.stepId) continue
    if (ev.type === "step_started") {
      startedAt[ev.stepId] = ev.ts
      attempts[ev.stepId] = (attempts[ev.stepId] ?? 0) + 1
      continue
    }
    const status = statusFromType(ev.type)
    if (!status) continue
    const start = startedAt[ev.stepId] ?? 0
    out[ev.stepId] = {
      status,
      startedAt: start,
      finishedAt: ev.ts,
      durationMs: start > 0 ? Math.max(0, ev.ts - start) : 0,
      errorMessage: status === "failed" ? extractErrorMessage(ev.payload) : undefined,
      attempt: attempts[ev.stepId] ?? 1,
    }
    // Reset only the start tracker so a re-attempt (which fires another
    // `step_started`) measures duration correctly. `attempts` keeps counting
    // so the final emitted summary shows total attempts for this step.
    delete startedAt[ev.stepId]
  }
  return out
}

/**
 * Live hook that aggregates `step_completed/failed/skipped` events across
 * **every run** of a workflow and returns the latest summary per stepId.
 * Returns an empty object until the first row settles.
 */
export function useLastRunSummaryByStep(
  workflowId: string | undefined
): Record<string, LastRunSummary> {
  const map = useLiveQuery(
    async () => {
      if (!workflowId) return {} as Record<string, LastRunSummary>
      const db = getDb()
      const runs = await db.workflowRuns.where("workflowId").equals(workflowId).toArray()
      // Pull events for every run in chronological order — older runs first
      // so newer events overwrite. This matches `deriveLastRunSummary`'s
      // "latest wins" behaviour without any per-event sort overhead.
      runs.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      const all: WorkflowRunEventRow[] = []
      for (const run of runs) {
        const events = await db.workflowRunEvents
          .where("[runId+ts]")
          .between([run.id, 0], [run.id, Number.MAX_SAFE_INTEGER])
          .toArray()
        all.push(...events)
      }
      return deriveLastRunSummary(all)
    },
    [workflowId],
    {} as Record<string, LastRunSummary>
  )
  return map ?? ({} as Record<string, LastRunSummary>)
}
