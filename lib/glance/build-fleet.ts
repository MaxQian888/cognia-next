/**
 * Fleet slice: a read-only summary of the island projection (ADR-0225 §1).
 *
 * The island is the desktop's Agent Fleet surface and the only place an
 * approval, an answer or a per-task stop happens. This slice copies what the
 * island already decided is safe to hover (a redacted title, a coarse status,
 * timestamps) and deliberately drops the rest: no permission request, no
 * question text, no capabilities. A glance module that cannot act on a task
 * cannot drift into duplicating the island's controls.
 */

import type { IslandRowProjection, IslandRowStatus, IslandState } from "@/lib/island/types"

import {
  GLANCE_FLEET_MAX_ROWS,
  type GlanceFleetRow,
  type GlanceFleetSlice,
  type GlanceFleetState,
  type GlanceFleetWorkflows,
} from "./snapshot"

/** Longest workflow name a slice carries. */
export const GLANCE_WORKFLOW_NAME_MAX = 80

export const NO_RUNNING_WORKFLOWS: GlanceFleetWorkflows = { running: 0, latest: null }

/** The fields of a `workflowRuns` row this summary reads. */
export interface RunningWorkflowInput {
  workflowId: string
  startedAt: number
}

/**
 * Summarize the running workflow runs: how many, and the newest one by start
 * time, named by its workflow (falling back to the id when the workflow row
 * is gone, as the runs page does).
 */
export function summarizeRunningWorkflows(
  runs: readonly RunningWorkflowInput[],
  names: ReadonlyMap<string, string>
): GlanceFleetWorkflows {
  if (runs.length === 0) return NO_RUNNING_WORKFLOWS
  let latest = runs[0]
  for (const run of runs) if (run.startedAt > latest.startedAt) latest = run
  const name = (names.get(latest.workflowId) ?? latest.workflowId).trim()
  return {
    running: runs.length,
    latest: {
      workflowId: latest.workflowId,
      name:
        name.length > GLANCE_WORKFLOW_NAME_MAX
          ? `${name.slice(0, GLANCE_WORKFLOW_NAME_MAX - 1)}…`
          : name,
      startedAt: latest.startedAt,
    },
  }
}

const STATE_OF: Record<IslandRowStatus, GlanceFleetState> = {
  blocked: "awaiting",
  failed: "failed",
  working: "working",
  done: "done",
  idle: "idle",
  stale: "stale",
}

function rowOf(row: IslandRowProjection): GlanceFleetRow {
  return {
    id: row.id,
    title: row.title,
    agent: row.agent ?? null,
    agentLabel: row.agentLabel ?? null,
    state: row.stale ? "stale" : STATE_OF[row.status],
    statusKey: row.statusKey ?? null,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    waitingSince: row.waitingSince ?? null,
  }
}

/**
 * Project the island state. Rows keep the island's priority order. A host
 * with no island (a phone) passes null and gets an empty row list; running
 * workflows are summarized either way.
 */
export function buildFleetSlice(
  island: IslandState | null,
  now: number,
  workflows: GlanceFleetWorkflows = NO_RUNNING_WORKFLOWS
): GlanceFleetSlice {
  const rows = (island?.rows ?? []).map(rowOf)
  const counts = { working: 0, awaiting: 0, failed: 0 }
  for (const row of rows) {
    if (row.state === "working") counts.working += 1
    else if (row.state === "awaiting") counts.awaiting += 1
    else if (row.state === "failed") counts.failed += 1
  }
  return {
    updatedAt: island?.generatedAt || now,
    counts,
    total: rows.length,
    rows: rows.slice(0, GLANCE_FLEET_MAX_ROWS),
    workflows,
  }
}
