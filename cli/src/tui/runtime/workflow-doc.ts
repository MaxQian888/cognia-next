/**
 * Pure markdown builders for the `/workflow inspect` and `/workflow runs` views.
 *
 * The CLI lacks the desktop's live `useLiveQuery` Runs panel, so these render a
 * scrollable snapshot through the existing `document` overlay instead of a
 * one-line notice. Pure + injectable time formatter ⇒ fully unit-tested; the
 * controller just fetches the rows and opens the overlay.
 */
import type { RunStatus, WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"

/** How many recent runs the inspect view summarizes inline. */
const INSPECT_RUN_LIMIT = 8
/** How many runs the dedicated runs view lists. */
const RUNS_LIMIT = 20

/** Default absolute-time formatter (injectable so tests stay deterministic). */
function defaultFmtTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19)
}

/** Human-readable run duration from a started/completed pair. */
export function formatRunDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "—"
  if (durationMs < 1000) return `${durationMs}ms`
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`
  const m = Math.floor(durationMs / 60000)
  const s = Math.round((durationMs % 60000) / 1000)
  return `${m}m ${s}s`
}

/** A glyph for each run status. */
export function runStatusIcon(status: RunStatus): string {
  switch (status) {
    case "succeeded":
      return "✓"
    case "failed":
      return "✗"
    case "cancelled":
      return "⊘"
    case "paused":
      return "⏸"
    case "waiting":
      return "…"
    case "pending":
      return "·"
    case "running":
    default:
      return "⏳"
  }
}

function durationOf(run: WorkflowRunRow): number | undefined {
  return run.completedAt !== undefined ? run.completedAt - run.startedAt : undefined
}

/** One bullet line per run: `✓ succeeded · 2.3s · 2026-06-11 09:00:00`. */
function runLine(run: WorkflowRunRow, fmtTime: (ms: number) => string): string {
  const dur = formatRunDuration(durationOf(run))
  const when = fmtTime(run.startedAt)
  const fail =
    run.status === "failed" && run.error
      ? ` — ${run.error.nodeId ? `node \`${run.error.nodeId}\`: ` : ""}${run.error.message}`
      : ""
  return `- ${runStatusIcon(run.status)} ${run.status} · ${dur} · ${when}${fail}`
}

/** Full inspect document: header, settings, node list, recent-run summary. */
export function buildWorkflowDocument(
  wf: WorkflowRow,
  runs: WorkflowRunRow[],
  fmtTime: (ms: number) => string = defaultFmtTime
): string {
  const lines: string[] = []
  lines.push(`# ${wf.name}`, "")
  lines.push(wf.description?.trim() ? wf.description.trim() : "_No description._", "")

  const concurrency = wf.settings?.maxConcurrency ?? 1
  lines.push(
    `**Nodes:** ${wf.nodes?.length ?? 0} · **Edges:** ${wf.edges?.length ?? 0} · ` +
      `**Error policy:** ${wf.settings?.errorPolicy ?? "stop"} · ` +
      `**Timeout:** ${wf.settings?.timeoutMs ?? 0}ms · **Max concurrency:** ${concurrency}`,
    ""
  )

  lines.push("## Nodes", "")
  if (!wf.nodes?.length) {
    lines.push("_No nodes._", "")
  } else {
    for (const n of wf.nodes) {
      const label = n.data?.label ? ` · ${n.data.label}` : ""
      lines.push(`- \`${n.id}\` — **${n.type}**${label}`)
    }
    lines.push("")
  }

  lines.push(`## Recent runs`, "")
  if (!runs.length) {
    lines.push("_No runs yet._")
  } else {
    for (const r of runs.slice(0, INSPECT_RUN_LIMIT)) lines.push(runLine(r, fmtTime))
    if (runs.length > INSPECT_RUN_LIMIT) {
      lines.push("", `_…and ${runs.length - INSPECT_RUN_LIMIT} more (use \`/workflow runs\`)._`)
    }
  }

  return lines.join("\n")
}

/** Dedicated runs document: a longer, run-focused list. */
export function buildRunsDocument(
  wf: WorkflowRow,
  runs: WorkflowRunRow[],
  fmtTime: (ms: number) => string = defaultFmtTime
): string {
  const lines: string[] = []
  lines.push(`# Runs · ${wf.name}`, "")
  if (!runs.length) {
    lines.push("_No runs recorded yet._")
    return lines.join("\n")
  }
  lines.push(`${runs.length} run${runs.length === 1 ? "" : "s"} recorded.`, "")
  for (const r of runs.slice(0, RUNS_LIMIT)) lines.push(runLine(r, fmtTime))
  if (runs.length > RUNS_LIMIT) {
    lines.push("", `_…and ${runs.length - RUNS_LIMIT} older runs._`)
  }
  return lines.join("\n")
}
