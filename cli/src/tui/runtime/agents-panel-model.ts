/**
 * Pure presentation model for the interactive `/agents` panel (default Ctrl+B).
 * Merges the two things a user wants to see at a glance — the sub-agents
 * dispatched *this turn* (still running) and the *background* sub-agent runs
 * (live + settled/interrupted from the journal) — into one ordered row list.
 *
 * Ink-free + I/O-free: the controller fetches the three sources and feeds them
 * here, so the merge/sort logic unit-tests without a render. Mirrors
 * `mcp-panel-model` / `skill-panel-model`.
 */
import type {
  BackgroundTaskJournalRecord,
  BackgroundTaskStatus,
} from "@/lib/background-tasks/registry-core"

import type { CliBackgroundRunInfo } from "../../agent/subagent-background-tasks"
import type { SubagentLiveEntry } from "../../agent/subagent-live-output"
import type { InflightSubagentRow } from "../format/subagent"

/** A row's lifecycle state — identical union to {@link BackgroundTaskStatus}. */
export type AgentRowStatus = BackgroundTaskStatus

/** One row in the agents panel. */
export interface AgentPanelRow {
  /** Stable id (`inflight:<callKey>` or `bg:<runId>`). */
  id: string
  kind: "inflight" | "background"
  name: string
  task: string
  status: AgentRowStatus
  startedAt?: number
  /** Set for background rows — the journal run id used to collect output. */
  runId?: string
  /** Set when a live-output entry exists — Enter/click opens the live run page. */
  liveId?: string
  /** Settled background output (result text or error), for the detail view. */
  output?: string
}

export interface AgentPanelSources {
  /** In-turn sub-agent dispatches still running (from `state.inflight.tools`). */
  inflight: InflightSubagentRow[]
  /** Per-subagent live-output entries (in-process, owner-scoped) — the primary
   * source: each carries streamed text + a `liveId` the run page subscribes to. */
  live: SubagentLiveEntry[]
  /** Live background runs in THIS process (authoritative for "running"). */
  backgroundRuns: CliBackgroundRunInfo[]
  /** Journaled background records (host=cli) — carry prompt + settled output. */
  journalRecords: BackgroundTaskJournalRecord[]
}

/** Running first, then interrupted/error, then done; ties broken by newest. */
const STATUS_WEIGHT: Record<AgentRowStatus, number> = {
  running: 0,
  interrupted: 1,
  error: 2,
  done: 3,
}

function compareRows(a: AgentPanelRow, b: AgentPanelRow): number {
  // In-turn dispatches are the most "now" — always above background rows.
  const kindRank = (r: AgentPanelRow) => (r.kind === "inflight" ? 0 : 1)
  if (kindRank(a) !== kindRank(b)) return kindRank(a) - kindRank(b)
  if (STATUS_WEIGHT[a.status] !== STATUS_WEIGHT[b.status])
    return STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status]
  return (b.startedAt ?? 0) - (a.startedAt ?? 0)
}

/**
 * Build the panel rows. The live-output store is the primary source — each entry
 * carries streamed text and a `liveId` the run page subscribes to. Background
 * rows the live store didn't (or no longer) captures come from the journal (which
 * carries the prompt + settled output) and the live registry (authoritative for
 * which runs are still running). The coarse in-turn tool-cell rows are a fallback
 * for any dispatch channel that bypasses the live store.
 */
export function buildAgentPanelRows({
  inflight,
  live,
  backgroundRuns,
  journalRecords,
}: AgentPanelSources): AgentPanelRow[] {
  const rows: AgentPanelRow[] = []

  // The runIds that are background runs — a live entry sharing one is classified
  // "background" (the dispatch reused its runId as the live id); the rest are
  // in-turn foreground dispatches.
  const bgRunIds = new Set<string>([
    ...backgroundRuns.map((r) => r.runId),
    ...journalRecords.filter((r) => r.host === "cli").map((r) => r.runId),
  ])

  // 1. Live entries — primary, openable to the live run page.
  const liveIds = new Set<string>()
  for (const entry of live) {
    liveIds.add(entry.liveId)
    const isBackground = bgRunIds.has(entry.liveId)
    rows.push({
      id: isBackground ? `bg:${entry.liveId}` : `live:${entry.liveId}`,
      kind: isBackground ? "background" : "inflight",
      name: entry.name,
      task: entry.task,
      status: entry.status,
      startedAt: entry.startedAt,
      liveId: entry.liveId,
      ...(isBackground ? { runId: entry.liveId } : {}),
      ...(entry.text ? { output: entry.text } : {}),
    })
  }

  // 2. Journal records (settled background) the live store no longer holds.
  const liveRunning = new Set(
    backgroundRuns.filter((r) => r.status === "running").map((r) => r.runId)
  )
  const seen = new Set<string>(liveIds)
  for (const rec of journalRecords) {
    if (rec.host !== "cli") continue
    if (seen.has(rec.runId)) continue
    seen.add(rec.runId)
    rows.push({
      id: `bg:${rec.runId}`,
      kind: "background",
      name: rec.subagentId,
      task: rec.prompt,
      // The live registry wins for this process — the journal may still read
      // "running" for a run that just settled, or vice-versa.
      status: liveRunning.has(rec.runId) ? "running" : rec.status,
      startedAt: rec.startedAt,
      runId: rec.runId,
      ...((rec.resultText ?? rec.error) ? { output: rec.resultText ?? rec.error } : {}),
    })
  }

  // 3. Live registry runs neither the live store nor the journal captured yet.
  for (const run of backgroundRuns) {
    if (seen.has(run.runId)) continue
    rows.push({
      id: `bg:${run.runId}`,
      kind: "background",
      name: run.subagentId,
      task: "",
      status: run.status,
      startedAt: run.startedAt,
      runId: run.runId,
    })
  }

  // 4. In-turn tool-cell fallback — only when nothing is running in the live
  //    store, so a channel that bypasses it (no live entry) is still surfaced
  //    without duplicating the per-subagent live rows above.
  if (!live.some((e) => e.status === "running")) {
    for (const row of inflight) {
      rows.push({
        id: `inflight:${row.callKey}`,
        kind: "inflight",
        name: row.name,
        task: row.task,
        status: "running",
      })
    }
  }

  return rows.sort(compareRows)
}

/** The leading status bullet: glyph + theme token for the component to colour. */
export interface AgentBadge {
  glyph: string
  token: "success" | "muted" | "danger" | "warning" | "accent"
}

export function agentRowBadge(status: AgentRowStatus): AgentBadge {
  switch (status) {
    case "running":
      return { glyph: "◆", token: "accent" }
    case "done":
      return { glyph: "●", token: "success" }
    case "error":
      return { glyph: "✗", token: "danger" }
    case "interrupted":
      return { glyph: "!", token: "warning" }
  }
}

/** Compact elapsed text from a millisecond span: `12s`, `3m 4s`, `1h 2m`. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** The dimmed metadata suffix after a row's name: origin · elapsed. */
export function agentRowHint(row: AgentPanelRow, now: number): string {
  const parts: string[] = [row.kind === "inflight" ? "in-turn" : "background"]
  if (row.startedAt !== undefined) parts.push(formatElapsed(now - row.startedAt))
  return parts.join(" · ")
}

/** Counts for the panel header: total / running / settled. */
export function agentSummary(rows: AgentPanelRow[]): {
  total: number
  running: number
  settled: number
} {
  const running = rows.filter((r) => r.status === "running").length
  return { total: rows.length, running, settled: rows.length - running }
}

export const AGENTS_PANEL_FOOTER = "↑/↓ / click · enter view output · esc close"
