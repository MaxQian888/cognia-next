/**
 * Project a completed workflow run into a portable A2UI app.
 *
 * Reuses the run-detail analytics primitives (`aggregateRunUsage`,
 * `computeStepBreakdown`) so the generated page mirrors exactly what the
 * in-app run inspector shows — header + KPIs + step table + duration chart +
 * token-burn chart + per-step outputs + error — but as a shareable A2UI tree.
 *
 * Pure + deterministic: no clock/random, ids come from `PageAssembler`.
 */

import { createAppMessages, type GeneratedApp } from "@/lib/a2ui/app-generator"
import { aggregateRunUsage, formatCostUsd, formatTokens } from "@/lib/workflow/runs/usage-aggregate"
import { computeStepBreakdown } from "@/lib/workflow/runs/step-breakdown"
import type { A2UIChartDataPoint, A2UITableColumn } from "@/types/a2ui/schema"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

import { PageAssembler } from "./builders"
import type { ExecutionPageLabels, WorkflowRunPageSource } from "./types"

/** Human-readable duration ("1.2s", "3m 4s", "—"). */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  return `${minutes}m ${seconds}s`
}

/** Map a run status to a Badge variant. */
function statusVariant(
  status: WorkflowRunRow["status"]
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed" || status === "cancelled") return "destructive"
  if (status === "succeeded") return "default"
  return "secondary"
}

/** Stable JSON stringify with truncation, for embedding outputs as text. */
export function stringifyOutput(value: unknown, maxChars = 1200): string {
  let text: string
  if (value === undefined) return ""
  if (typeof value === "string") {
    text = value
  } else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** End timestamp for a run: explicit completion, else latest event ts. */
function resolveRunEnd(run: WorkflowRunRow, events: WorkflowRunEventRow[]): number | undefined {
  if (run.completedAt !== undefined) return run.completedAt
  let end: number | undefined
  for (const e of events) if (end === undefined || e.ts > end) end = e.ts
  return end
}

/** Extract per-step outputs from `step_completed` events, in event order. */
function collectStepOutputs(
  events: WorkflowRunEventRow[]
): Array<{ stepId: string; output: unknown }> {
  const out: Array<{ stepId: string; output: unknown }> = []
  for (const e of events) {
    if (e.type !== "step_completed" || !e.stepId) continue
    const payload = e.payload as { output?: unknown } | undefined
    if (payload && "output" in payload && payload.output !== undefined) {
      out.push({ stepId: e.stepId, output: payload.output })
    }
  }
  return out
}

/**
 * Build a `GeneratedApp` visualizing one workflow run. The returned app id is
 * derived from the run id so the same run always maps to the same surface.
 */
export function buildWorkflowRunPage(
  source: WorkflowRunPageSource,
  labels: ExecutionPageLabels
): GeneratedApp {
  const { run, events } = source
  const workflow = run.workflowSnapshot
  const name = source.workflowName ?? workflow.name ?? labels.untitled
  const title = run.title?.trim() || name

  const usage = aggregateRunUsage(events)
  const end = resolveRunEnd(run, events)
  const breakdown = computeStepBreakdown(workflow, events, run.completedAt, run.startedAt)
  const durationMs = end !== undefined ? end - run.startedAt : undefined

  const a = new PageAssembler()
  const sections: string[] = []

  // ── Header: title + status badge + meta caption ──────────────────────────
  const headerTitle = a.text(title, { variant: "heading2" })
  const headerBadge = a.badge(run.status, statusVariant(run.status))
  const headerRow = a.row([headerTitle, headerBadge], { align: "center", justify: "between" })
  const metaParts = [
    `${labels.trigger}: ${run.triggerKind}`,
    `${labels.duration}: ${formatDurationMs(durationMs)}`,
  ]
  const headerMeta = a.text(metaParts.join("  ·  "), { variant: "caption" })
  sections.push(a.card({ childrenIds: [a.column([headerRow, headerMeta], { gap: 1 })] }))

  // ── KPI row ──────────────────────────────────────────────────────────────
  const succeeded = breakdown.rows.filter((r) => r.status === "succeeded").length
  const failed = breakdown.rows.filter((r) => r.status === "failed").length
  const kpis = [
    a.kpi(labels.steps, String(breakdown.rows.length)),
    a.kpi(labels.succeeded, String(succeeded)),
    a.kpi(labels.failed, String(failed)),
    a.kpi(labels.tokens, formatTokens(usage.totalTokens)),
    a.kpi(labels.cost, formatCostUsd(usage.totalCostUsd)),
  ]
  sections.push(a.row(kpis, { gap: 2, wrap: true }))

  // ── Step breakdown table ──────────────────────────────────────────────────
  if (breakdown.rows.length > 0) {
    const columns: A2UITableColumn[] = [
      { key: "step", header: labels.stepBreakdown },
      { key: "status", header: labels.status },
      { key: "duration", header: labels.duration, align: "right" },
      { key: "tokens", header: labels.tokens, align: "right", type: "number" },
      { key: "cost", header: labels.cost, align: "right" },
    ]
    const data = breakdown.rows.map((r) => ({
      step: r.label,
      status: r.status,
      duration: formatDurationMs(r.durationMs),
      tokens: r.usage ? formatTokens(r.usage.totalTokens) : "—",
      cost: r.usage ? formatCostUsd(r.usage.costUsd) : "—",
    }))
    sections.push(a.table(columns, data, { title: labels.stepBreakdown }))

    // ── Duration bar chart ──────────────────────────────────────────────────
    const durationData: A2UIChartDataPoint[] = breakdown.rows.map((r) => ({
      name: r.label,
      value: Math.round(r.durationMs),
    }))
    sections.push(
      a.chart("bar", durationData, { title: labels.stepDuration, height: 240, showGrid: true })
    )

    // ── Token-burn cumulative area chart (only when tokens were spent) ─────────
    if (usage.totalTokens > 0) {
      let cumulative = 0
      const burnData: A2UIChartDataPoint[] = breakdown.rows.map((r) => {
        cumulative += r.usage?.totalTokens ?? 0
        return { name: r.label, value: cumulative }
      })
      sections.push(
        a.chart("area", burnData, { title: labels.tokenBurn, height: 200, showGrid: true })
      )
    }
  }

  // ── Per-step outputs ───────────────────────────────────────────────────────
  const outputs = collectStepOutputs(events)
  if (outputs.length > 0) {
    const labelByStep = new Map(breakdown.rows.map((r) => [r.stepId, r.label]))
    const outputCards = outputs.map(({ stepId, output }) => {
      const text = a.text(stringifyOutput(output), { variant: "code" })
      return a.card({ title: labelByStep.get(stepId) ?? stepId, childrenIds: [text] })
    })
    const heading = a.text(labels.outputs, { variant: "heading3" })
    sections.push(a.column([heading, ...outputCards], { gap: 2 }))
  }

  // ── Error alert ────────────────────────────────────────────────────────────
  if (run.error) {
    const msg = run.error.code ? `[${run.error.code}] ${run.error.message}` : run.error.message
    sections.push(a.alert({ title: labels.error, message: msg, variant: "error" }))
  }

  a.root(sections)

  const id = `wfrun-page-${run.id}`
  return {
    id,
    name: title,
    description: `${labels.steps}: ${breakdown.rows.length} · ${labels.tokens}: ${formatTokens(usage.totalTokens)}`,
    components: a.components,
    dataModel: {},
    messages: createAppMessages(id, title, a.components, {}),
  }
}
