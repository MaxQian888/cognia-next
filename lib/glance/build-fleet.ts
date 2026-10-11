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
} from "./snapshot"

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

/** Project the island state. Rows keep the island's priority order. */
export function buildFleetSlice(island: IslandState | null, now: number): GlanceFleetSlice {
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
  }
}
