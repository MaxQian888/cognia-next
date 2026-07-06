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
import { liveTokenCount, type SubagentLiveEntry } from "../../agent/subagent-live-output"
import { bareToolName } from "../markdown/diff"
import { toolDisplayName } from "../format/tools"
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
  /** Total tool calls the run has made (live rows only). */
  toolUses?: number
  /** Token spend — exact once the run's usage lands, else a live estimate. */
  tokens?: number
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

/** Project one live-output entry into its panel row (shared by build + refresh). */
function liveEntryRow(entry: SubagentLiveEntry, bgRunIds: Set<string>): AgentPanelRow {
  const isBackground = bgRunIds.has(entry.liveId)
  const { tokens } = liveTokenCount(entry)
  return {
    id: isBackground ? `bg:${entry.liveId}` : `live:${entry.liveId}`,
    kind: isBackground ? "background" : "inflight",
    name: entry.name,
    task: entry.task,
    status: entry.status,
    startedAt: entry.startedAt,
    liveId: entry.liveId,
    ...(isBackground ? { runId: entry.liveId } : {}),
    ...(entry.text ? { output: entry.text } : {}),
    toolUses: entry.toolUseCount,
    tokens,
  }
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
    rows.push(liveEntryRow(entry, bgRunIds))
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

/**
 * Live-update an already-open panel's rows without re-reading the journal:
 * rebuild every row backed by the live-output store (status / tokens / tool
 * count move while the panel is open), keep journal-only rows as-is (their
 * status corrected from the live background registry when it disagrees), and
 * drop stale in-turn tool-cell fallback rows once live entries exist.
 */
export function refreshAgentPanelRows(
  prev: AgentPanelRow[],
  live: SubagentLiveEntry[],
  backgroundRuns: CliBackgroundRunInfo[]
): AgentPanelRow[] {
  const bgRunIds = new Set<string>(backgroundRuns.map((r) => r.runId))
  for (const row of prev) if (row.runId) bgRunIds.add(row.runId)

  const liveRows = live.map((entry) => liveEntryRow(entry, bgRunIds))
  const liveIds = new Set(liveRows.map((r) => r.id))
  const runStatus = new Map(backgroundRuns.map((r) => [r.runId, r.status]))
  const hasLiveRunning = live.some((e) => e.status === "running")

  const kept = prev
    .filter((row) => !liveIds.has(row.id))
    .filter((row) => !(hasLiveRunning && row.id.startsWith("inflight:")))
    .map((row) => {
      const next = row.runId ? runStatus.get(row.runId) : undefined
      return next && next !== row.status ? { ...row, status: next } : row
    })

  return [...liveRows, ...kept].sort(compareRows)
}

/** Compact token count: `842`, `115.0k`, `2.3M` (Claude Code's tree format). */
export function formatTokenCount(tokens: number): string {
  const n = Math.max(0, Math.round(tokens))
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Verb buckets for the live activity phrase, keyed by bare tool name. */
const ACTIVITY_BUCKETS: Array<{
  names: Set<string>
  phrase: (n: number) => string
}> = [
  {
    names: new Set(["grep", "search", "content_search", "glob", "find", "codegraph_search"]),
    phrase: (n) => `searching for ${n} pattern${n === 1 ? "" : "s"}`,
  },
  {
    names: new Set(["read", "notebookread"]),
    phrase: (n) => `reading ${n} file${n === 1 ? "" : "s"}`,
  },
  {
    names: new Set([
      "edit",
      "write",
      "multi_edit",
      "multiedit",
      "str_replace",
      "apply_patch",
      "notebookedit",
      "file_append",
    ]),
    phrase: (n) => `editing ${n} file${n === 1 ? "" : "s"}`,
  },
  {
    names: new Set(["bash", "shell", "shell_execute_advanced", "bash_output"]),
    phrase: (n) => `running ${n} command${n === 1 ? "" : "s"}`,
  },
  {
    names: new Set(["webfetch", "web_fetch", "fetch", "websearch", "web_search"]),
    phrase: (n) => `fetching ${n} page${n === 1 ? "" : "s"}`,
  },
]

/**
 * One-line "what is it doing right now" phrase for a live run — Claude Code's
 * `Searching for 3 patterns, reading 6 files…` activity line. Groups the
 * currently-running tools into verb buckets; with none running it falls back to
 * the tail of the timeline (thinking / responding / working).
 */
export function liveAgentActivity(entry: SubagentLiveEntry): string {
  const running = entry.tools.filter((t) => t.status === "running")
  if (running.length === 0) {
    const last = entry.timeline[entry.timeline.length - 1]
    if (!last) return "Starting…"
    if (last.kind === "thinking") return "Thinking…"
    if (last.kind === "text") return "Responding…"
    return "Working…"
  }
  const counts = new Map<number, number>()
  const other: string[] = []
  for (const tool of running) {
    const bare = bareToolName(tool.name).toLowerCase()
    const idx = ACTIVITY_BUCKETS.findIndex((b) => b.names.has(bare))
    if (idx >= 0) counts.set(idx, (counts.get(idx) ?? 0) + 1)
    else other.push(toolDisplayName(tool.name))
  }
  const parts = ACTIVITY_BUCKETS.flatMap((bucket, idx) => {
    const n = counts.get(idx)
    return n ? [bucket.phrase(n)] : []
  })
  if (other.length > 0) {
    parts.push(other.length === 1 ? `using ${other[0]}` : `using ${other.length} tools`)
  }
  const joined = parts.join(", ")
  return joined.charAt(0).toUpperCase() + joined.slice(1) + "…"
}

/** One agent's two display lines in the live "Running N agents…" tree. */
export interface LiveAgentTreeRow {
  liveId: string
  name: string
  task: string
  /** `10 tool uses · 115.0k tokens` — the dimmed suffix after the name. */
  stats: string
  /** `Searching for 3 patterns, reading 6 files…` */
  activity: string
}

/**
 * Rows for the Claude-Code-style running-agents tree pinned above the composer.
 * Running entries only, oldest first (dispatch order — the tree stays stable
 * while counters move).
 */
export function buildLiveAgentTreeRows(entries: SubagentLiveEntry[]): LiveAgentTreeRow[] {
  return entries
    .filter((e) => e.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((entry) => {
      const { tokens } = liveTokenCount(entry)
      const uses = entry.toolUseCount
      return {
        liveId: entry.liveId,
        name: entry.name,
        task: entry.task,
        stats: `${uses} tool use${uses === 1 ? "" : "s"} · ${formatTokenCount(tokens)} tokens`,
        activity: liveAgentActivity(entry),
      }
    })
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

/** The dimmed metadata suffix after a row's name: origin · elapsed · tools · tokens. */
export function agentRowHint(row: AgentPanelRow, now: number): string {
  const parts: string[] = [row.kind === "inflight" ? "in-turn" : "background"]
  if (row.startedAt !== undefined) parts.push(formatElapsed(now - row.startedAt))
  if (row.toolUses !== undefined && row.toolUses > 0) parts.push(`${row.toolUses} tools`)
  if (row.tokens !== undefined && row.tokens > 0)
    parts.push(`↓ ${formatTokenCount(row.tokens)} tok`)
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
