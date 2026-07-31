/**
 * Export helpers for workflow runs. The CSV/JSON serializers are pure (unit
 * tested); the `download*` wrappers trigger a browser download, reusing the
 * Blob-anchor pattern from `lib/workflow/editor/workflow-json.ts`.
 */

import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

function safeFileName(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, "_") || "workflow"
}

/** Quote a CSV cell when it contains a comma, quote, or newline. */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

const CSV_HEADERS = [
  "id",
  "status",
  "triggerKind",
  "startedAt",
  "completedAt",
  "durationMs",
  "error",
] as const

/** Serialize runs to CSV (newest order preserved from the caller). */
export function runsToCsv(runs: readonly WorkflowRunRow[]): string {
  const lines = [CSV_HEADERS.join(",")]
  for (const run of runs) {
    const duration = run.completedAt !== undefined ? String(run.completedAt - run.startedAt) : ""
    const row = [
      run.id,
      run.status,
      run.triggerKind,
      new Date(run.startedAt).toISOString(),
      run.completedAt !== undefined ? new Date(run.completedAt).toISOString() : "",
      duration,
      run.error?.message ?? "",
    ]
    lines.push(row.map((c) => csvCell(c)).join(","))
  }
  return lines.join("\n")
}

function triggerDownload(content: string, fileName: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Download the given runs as a CSV file. */
export function downloadRunsCsv(runs: readonly WorkflowRunRow[], workflowName: string): void {
  triggerDownload(runsToCsv(runs), `${safeFileName(workflowName)}-runs.csv`, "text/csv")
}

/** Download the given runs as pretty-printed JSON. */
export function downloadRunsJson(runs: readonly WorkflowRunRow[], workflowName: string): void {
  triggerDownload(
    JSON.stringify(runs, null, 2),
    `${safeFileName(workflowName)}-runs.json`,
    "application/json"
  )
}

/**
 * Download a single run's full envelope (run row + complete event log) as JSON.
 * Powers the run-detail "Export" action.
 */
export function downloadRunExport(
  run: WorkflowRunRow,
  events: readonly WorkflowRunEventRow[],
  workflowName: string
): void {
  const payload = { version: 1 as const, run, events }
  triggerDownload(
    JSON.stringify(payload, null, 2),
    `${safeFileName(workflowName)}-run-${safeFileName(run.id)}.json`,
    "application/json"
  )
}
