/**
 * A chat fusion run as its answer message and its progress card show it
 * (ADR-0188 B3).
 *
 * Built from the run row and its journal only: counts, reasons, phase names,
 * money. Nothing a model wrote is in either, so the summary can travel on a
 * message's metadata without carrying any output of its own.
 */

import type { RouterFusionRunSummary } from "@cognia/agent-config-types"
import { runTimelineOf } from "@cognia/router-fusion"

import type { FusionRunEventRow, FusionRunRow } from "./types"

export function fusionRunSummaryOf(
  run: FusionRunRow,
  events: readonly FusionRunEventRow[]
): RouterFusionRunSummary {
  const completed = [...events].reverse().find((event) => event.type === "answer.completed")
  const quality = completed?.payload.quality_status
  return {
    runId: run.runId,
    // Only cascade and panel runs are chat fusion runs; a direct run never
    // reaches this summary, and says so rather than pretending.
    mode: run.mode === "panel" ? "panel" : "cascade",
    actionId: run.actionId,
    ruleId: run.ruleId,
    status: run.status,
    qualityStatus: typeof quality === "string" ? quality : null,
    roles: { ...run.roleDeployments },
    capMicrousd: run.budget.capMicrousd,
    spentMicrousd: run.budget.spentMicrousd,
    modelCalls: run.budget.modelCalls,
    costStatus: run.costStatus,
    errorCode: run.error?.code ?? null,
    timeline: runTimelineOf(
      events.map((event) => ({ type: event.type, payload: event.payload, at: event.createdAt }))
    ),
  }
}
