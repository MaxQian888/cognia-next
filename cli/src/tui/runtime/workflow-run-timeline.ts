/**
 * Pure markdown builder for the closing transcript cell of a TUI workflow run.
 * Reuses `formatRunDuration` (workflow-doc) and `stepStatusIcon` (workflow-run-fold)
 * so glyphs/durations match the rest of the `/workflow` surface — no duplication.
 */
import type { RunStatus, WorkflowRow } from "@/types/workflow/visual"
import { formatRunDuration } from "./workflow-doc"
import { stepStatusIcon, type RunStepView, type RunUsageTotals } from "./workflow-run-fold"
import { formatTokens } from "../format/usage"

function stepLine(s: RunStepView): string {
  const iter = s.iterations && s.iterations > 1 ? ` ×${s.iterations}` : ""
  const dur = s.durationMs !== undefined ? ` · ${formatRunDuration(s.durationMs)}` : ""
  const err = s.status === "failed" && s.error ? ` — ${s.error}` : ""
  return `- ${stepStatusIcon(s.status)} ${s.label}${iter}${dur}${err}`
}

/** `15.2k tokens · $0.0042` (cost omitted when no step reported a price). */
export function usageLine(usage: RunUsageTotals): string {
  const cost = usage.costUsd !== undefined ? ` · $${usage.costUsd.toFixed(4)}` : ""
  return `${formatTokens(usage.totalTokens)} tokens${cost}`
}

/**
 * `5 steps · 3 ok · 1 failed · 1 skipped[ · 15.2k tokens · $0.0042]` — the
 * run-level summary. Shared by the closing timeline cell and the live panel
 * footer so the two never drift.
 */
export function buildRunSummaryLine(steps: RunStepView[], usage?: RunUsageTotals): string {
  const ok = steps.filter((s) => s.status === "succeeded").length
  const failed = steps.filter((s) => s.status === "failed").length
  const skipped = steps.filter((s) => s.status === "skipped").length
  let summary = `${steps.length} steps · ${ok} ok · ${failed} failed · ${skipped} skipped`
  if (usage) summary += ` · ${usageLine(usage)}`
  return summary
}

export function buildRunTimeline(
  wf: Pick<WorkflowRow, "name">,
  steps: RunStepView[],
  status: RunStatus,
  usage?: RunUsageTotals
): string {
  const lines: string[] = [`# Workflow run · ${wf.name} — ${status}`, ""]
  if (!steps.length) {
    lines.push("_No steps recorded._")
    return lines.join("\n")
  }
  for (const s of steps) lines.push(stepLine(s))
  // Fold the run's token/cost total into the summary line so the spend of a run
  // is visible at a glance, the way the desktop Runs panel aggregates it.
  lines.push("", buildRunSummaryLine(steps, usage))
  return lines.join("\n")
}
