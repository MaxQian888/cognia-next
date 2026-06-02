"use client"

/**
 * Shared accessor for a workflow's most-recent per-step outputs.
 *
 * Reads `step_completed` event payloads (`{ output }`) from the run event log,
 * keyed by step id. Two consumers:
 *   • the expression editor preview/autocomplete — wants the latest *successful*
 *     run so it never resolves against half-finished data (`anyStatus: false`);
 *   • the inspector NDV data tabs + `runSingleNode` — want the latest run
 *     regardless of status so failed/partial runs still surface data
 *     (`anyStatus: true`).
 *
 * Extracted from the previously-private copy inside `expression-field.tsx`.
 */

import { getDb } from "@/lib/db/index"
import { useGatedLiveQuery } from "./use-gated-live-query"

export interface LatestRunOutputsOptions {
  /** Use the latest run of any status (default false = latest succeeded run). */
  anyStatus?: boolean
}

/**
 * Non-hook async accessor. Returns `{}` when the workflow has no matching run.
 */
export async function getLatestRunOutputs(
  workflowId: string | undefined,
  options?: LatestRunOutputsOptions
): Promise<Record<string, unknown>> {
  if (!workflowId) return {}
  const db = getDb()
  const rows = await db.workflowRuns
    .where("[workflowId+startedAt]")
    .between([workflowId, 0], [workflowId, Number.POSITIVE_INFINITY])
    .reverse()
    .limit(options?.anyStatus ? 1 : 5)
    .toArray()
  const run = options?.anyStatus ? rows[0] : rows.find((r) => r.status === "succeeded")
  if (!run) return {}
  const events = await db.workflowRunEvents
    .where("[runId+ts]")
    .between([run.id, 0], [run.id, Number.POSITIVE_INFINITY])
    .toArray()
  const out: Record<string, unknown> = {}
  for (const ev of events) {
    if (ev.type === "step_completed" && ev.stepId) {
      const payload = ev.payload as { output?: unknown } | undefined
      if (payload && "output" in payload) out[ev.stepId] = payload.output
    }
  }
  return out
}

/**
 * Live hook wrapper. `enabled` gates the Dexie liveQuery (paused while dragging
 * / in reduced performance tiers) — same semantics as the previous local copy.
 */
export function useLatestRunOutputs(
  workflowId: string | undefined,
  enabled: boolean,
  options?: LatestRunOutputsOptions
): Record<string, unknown> {
  const anyStatus = options?.anyStatus ?? false
  return useGatedLiveQuery<Record<string, unknown>>(
    () => getLatestRunOutputs(workflowId, { anyStatus }),
    [workflowId, anyStatus],
    {} as Record<string, unknown>,
    enabled
  )
}
