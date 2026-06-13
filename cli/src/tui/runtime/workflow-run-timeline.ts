/**
 * Pure markdown builder for the closing transcript cell of a TUI workflow run.
 * Reuses `formatRunDuration` (workflow-doc) and `stepStatusIcon` (workflow-run-fold)
 * so glyphs/durations match the rest of the `/workflow` surface — no duplication.
 */
import type { RunStatus, WorkflowRow } from "@/types/workflow/visual"
import { formatRunDuration } from "./workflow-doc"
import { stepStatusIcon, type RunStepView } from "./workflow-run-fold"

function stepLine(s: RunStepView): string {
  const dur = s.durationMs !== undefined ? ` · ${formatRunDuration(s.durationMs)}` : ""
  const err = s.status === "failed" && s.error ? ` — ${s.error}` : ""
  return `- ${stepStatusIcon(s.status)} ${s.label}${dur}${err}`
}

export function buildRunTimeline(
  wf: Pick<WorkflowRow, "name">,
  steps: RunStepView[],
  status: RunStatus
): string {
  const lines: string[] = [`# Workflow run · ${wf.name} — ${status}`, ""]
  if (!steps.length) {
    lines.push("_No steps recorded._")
    return lines.join("\n")
  }
  for (const s of steps) lines.push(stepLine(s))
  const ok = steps.filter((s) => s.status === "succeeded").length
  const failed = steps.filter((s) => s.status === "failed").length
  const skipped = steps.filter((s) => s.status === "skipped").length
  lines.push("", `${steps.length} steps · ${ok} ok · ${failed} failed · ${skipped} skipped`)
  return lines.join("\n")
}
