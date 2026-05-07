/**
 * Boot-time resume controller.
 *
 * On app start, asks the Rust mirror for every in-flight run via
 * `workflow_reload_in_flight_runs`. Each row carries the frozen workflow
 * snapshot the orchestrator needs to continue from where the crashed run
 * left off; the IdempotencyCache (hydrated from the durable Dexie event log)
 * skips already-completed steps automatically.
 *
 * In web mode the Rust call is a no-op stub, so `reloadInFlightRuns()`
 * returns `[]` and the controller exits quickly.
 */

import { runWorkflow } from "./orchestrator"
import { reloadInFlightRuns } from "./tauri-bridge"
import type { InFlightRunRow, TriggerEvent, VisualWorkflow } from "@/types/workflow/visual"

export interface ResumeResult {
  attempted: number
  succeeded: number
  failed: number
  skipped: number
}

/**
 * Replay every in-flight run from the Rust mirror. Returns a summary so the
 * boot UI can surface a toast like "Resumed 2 workflow runs".
 */
export async function resumeInFlightRuns(): Promise<ResumeResult> {
  const rows = await reloadInFlightRuns()
  const result: ResumeResult = {
    attempted: rows.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  }
  for (const row of rows) {
    try {
      const outcome = await replayRow(row)
      if (outcome === "succeeded") result.succeeded += 1
      else if (outcome === "failed") result.failed += 1
      else result.skipped += 1
    } catch (err) {
      console.error("workflow resume controller: replay threw", {
        runId: row.runId,
        error: err instanceof Error ? err.message : String(err),
      })
      result.failed += 1
    }
  }
  return result
}

type ReplayOutcome = "succeeded" | "failed" | "skipped"

async function replayRow(row: InFlightRunRow): Promise<ReplayOutcome> {
  const snapshot = row.snapshot as VisualWorkflow | undefined
  if (!snapshot || typeof snapshot !== "object" || !snapshot.id) {
    console.warn(`workflow resume controller: row ${row.runId} has no usable snapshot; skipping`)
    return "skipped"
  }
  const trigger: TriggerEvent = {
    workflowId: snapshot.id,
    kind: "trigger.manual",
    payload: { resumedFrom: row.runId },
    originAt: row.startedAt,
  }
  const result = await runWorkflow({ workflow: snapshot, trigger, runId: row.runId })
  return result.status === "succeeded" ? "succeeded" : "failed"
}
