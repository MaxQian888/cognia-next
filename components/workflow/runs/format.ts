/**
 * Display helpers shared by every Runs UI surface. Pure functions with no
 * React dependency so the orchestrator can also use them in toast strings.
 */

import type { WorkflowRunRow } from "@/types/workflow/visual"

export function formatRunStartedAt(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return "—"
  // Use a locale-aware short form. The user's locale is whatever the
  // browser picked; for the runs list we don't pull from next-intl since
  // the result is just informational text.
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function formatRunDuration(
  run: Pick<WorkflowRunRow, "startedAt" | "completedAt" | "status">
): string {
  if (run.status === "running" || run.status === "waiting" || run.status === "paused") {
    return "running"
  }
  if (typeof run.completedAt !== "number") return "—"
  return formatDurationMs(run.completedAt - run.startedAt)
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${ms} ms`
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(totalSec < 10 ? 2 : 1)} s`
  const minutes = Math.floor(totalSec / 60)
  const seconds = Math.round(totalSec % 60)
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return `${hours}h ${remMin}m`
}
