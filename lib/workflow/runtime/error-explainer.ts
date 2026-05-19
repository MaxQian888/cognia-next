/**
 * Workflow error/validation explainer — used by the copilot's diagnostic
 * tools (`wf_explain_validation`, `wf_explain_last_run`) to translate
 * machine-shape errors into stable, human-readable summaries with a
 * jump-to node id so the agent can suggest concrete fixes.
 *
 * Pure functions (no Dexie, no React), trivially unit-testable.
 */

import type { NodeValidationResult } from "@/lib/workflow/nodes/validate-params"
import type { LastRunSummary } from "@/lib/workflow/runtime/last-run-summary"

export type ExplainedSeverity = "error" | "warning" | "info"

/**
 * One explained validation issue, scoped to a single node. `fields` lists
 * the offending param paths so the agent can fix them in one batch.
 */
export interface ExplainedValidation {
  nodeId: string
  nodeLabel: string
  nodeKind: string
  severity: ExplainedSeverity
  message: string
  fields: string[]
  /** True when the issue blocks a workflow run. */
  blocking: boolean
  /** Suggested next action — empty if no actionable advice applies. */
  suggestion: string
  /** The node the editor should focus when the user clicks "jump to". */
  jumpToNodeId: string
}

/**
 * Aggregated explanation of the most recent workflow run. `failedStep`
 * is set only when at least one step ended in `"failed"`; otherwise the
 * report mirrors the run's overall state ("succeeded" or "no run yet").
 */
export interface ExplainedLastRun {
  /** "no-run" when no terminal event has fired for this workflow. */
  status: "no-run" | "succeeded" | "partial" | "failed"
  failedStepId?: string
  failedStepLabel?: string
  errorSummary?: string
  suggestion?: string
  jumpToNodeId?: string
  /** Per-step counts so the agent can give a quick verbal recap. */
  counts: { succeeded: number; failed: number; skipped: number }
}

interface NodeRef {
  id: string
  label: string
  kind: string
}

/**
 * Translate a `validationByStepId` map into explained issues. Nodes
 * without entries (or with empty `fields`) are skipped — the goal is to
 * surface ONLY problems the agent can act on.
 */
export function explainValidation(
  validationByStepId: Record<string, NodeValidationResult>,
  nodes: ReadonlyArray<NodeRef>
): ExplainedValidation[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: ExplainedValidation[] = []
  for (const [nodeId, result] of Object.entries(validationByStepId)) {
    if (!result || !result.hasErrors) continue
    const node = byId.get(nodeId)
    const label = node?.label ?? nodeId
    const kind = node?.kind ?? "unknown"
    const fieldKeys = Object.keys(result.fields)
    const message =
      result.summary.length > 0
        ? result.summary.join("; ")
        : fieldKeys.length > 0
          ? `Invalid params: ${fieldKeys.join(", ")}`
          : "Validation failed"
    out.push({
      nodeId,
      nodeLabel: label,
      nodeKind: kind,
      severity: "error",
      message,
      fields: fieldKeys,
      blocking: true,
      suggestion: suggestionFor(fieldKeys, kind),
      jumpToNodeId: nodeId,
    })
  }
  return out
}

/**
 * Translate a `lastRunByStepId` map into a single high-level summary.
 * Picks the most-recent failed step (by `finishedAt`) as the focal
 * point; when nothing failed, reports `"succeeded"`.
 */
export function explainLastRun(
  lastRunByStepId: Record<string, LastRunSummary>,
  nodes: ReadonlyArray<NodeRef>
): ExplainedLastRun {
  const entries = Object.entries(lastRunByStepId)
  if (entries.length === 0) {
    return { status: "no-run", counts: { succeeded: 0, failed: 0, skipped: 0 } }
  }
  const counts = { succeeded: 0, failed: 0, skipped: 0 }
  let mostRecentFailed: { id: string; summary: LastRunSummary } | null = null
  for (const [id, summary] of entries) {
    counts[summary.status]++
    if (summary.status === "failed") {
      if (!mostRecentFailed || summary.finishedAt > mostRecentFailed.summary.finishedAt) {
        mostRecentFailed = { id, summary }
      }
    }
  }
  if (!mostRecentFailed) {
    return {
      status: counts.succeeded > 0 ? "succeeded" : "no-run",
      counts,
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const node = byId.get(mostRecentFailed.id)
  const label = node?.label ?? mostRecentFailed.id
  const errorMessage = mostRecentFailed.summary.errorMessage ?? "Step failed"
  return {
    status: counts.succeeded > 0 ? "partial" : "failed",
    failedStepId: mostRecentFailed.id,
    failedStepLabel: label,
    errorSummary: errorMessage,
    suggestion: suggestionForRunError(errorMessage),
    jumpToNodeId: mostRecentFailed.id,
    counts,
  }
}

/**
 * Best-effort suggestion text driven by the validation field key. The
 * agent receives this as plain English; it's allowed to rewrite the
 * suggestion in the user's locale before surfacing.
 */
function suggestionFor(fieldKeys: string[], kind: string): string {
  if (fieldKeys.includes("cron")) {
    return `Set a valid cron expression on '${kind}' (5 or 6 fields).`
  }
  if (fieldKeys.includes("url") || fieldKeys.includes("webhookUrl")) {
    return `Provide a fully-qualified https:// URL for '${kind}'.`
  }
  if (fieldKeys.some((k) => /id$/i.test(k))) {
    return `Reference a real id — call wf_list_characters / wf_list_twins / wf_list_connectors first.`
  }
  if (fieldKeys.length > 0) {
    return `Fix the field${fieldKeys.length === 1 ? "" : "s"}: ${fieldKeys.join(", ")}.`
  }
  return ""
}

/**
 * Heuristic suggestion from a step's error message. We only recognise
 * a few common patterns; the agent always has the raw `errorSummary`
 * to fall back on.
 */
function suggestionForRunError(errorMessage: string): string {
  const lower = errorMessage.toLowerCase()
  if (lower.includes("timeout")) {
    return "Increase the step timeout or split the workload across nodes."
  }
  if (lower.includes("unauthorized") || lower.includes("401")) {
    return "Refresh the credentials this step relies on (keyring / OAuth)."
  }
  if (lower.includes("not found") || lower.includes("404")) {
    return "Verify the referenced id exists — re-run the matching wf_list_* tool."
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "Throttle the upstream call — add a delay node or batch the work."
  }
  return ""
}
