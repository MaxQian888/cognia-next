/**
 * Per-subagent LIVE output store for the CLI TUI.
 *
 * The `dispatch_agent` / `Task` handler ({@link handleCliDispatchAgent}) runs each
 * subagent over the live sidecar but, until now, threw away everything streamed
 * mid-run — only the final text was returned to the model. The `/agents` panel
 * could therefore show a running subagent's status + elapsed, but never *what it
 * was doing*. This module is the missing seam: a process-global, owner-scoped
 * registry that accumulates each subagent's streamed text / reasoning / tool
 * activity so the TUI can open a dedicated "agent run page" and watch it live —
 * mirroring Claude Code's subagent transcript.
 *
 * It is fed by `subagent-runner`'s new `onEvent` hook (the SAME
 * {@link CaptureStreamEvent} stream the main turn already parses), so it adds no
 * extra provider round-trips.
 *
 * Cross-session isolation mirrors {@link subagent-background-tasks}: every entry
 * carries the owning chat `sessionId`, and `get`/`list` filter by it so a second
 * session (or a post-`/clear` session, which gets a fresh id) can never read
 * another session's subagent output even though the registry is process-global.
 */
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

import { summarizeToolCall } from "../tui/format/tools"

/** A subagent's lifecycle state — same union the panel/journal use. */
export type SubagentLiveStatus = "running" | "done" | "error" | "interrupted"

/** One tool the subagent invoked, tracked from `tool-call` → `tool-result`. */
export interface SubagentLiveTool {
  /** The originating `tool_use` block id, when the SDK supplied one. */
  id?: string
  name: string
  status: "running" | "done" | "error"
}

/**
 * One chronological slice of a subagent's run — the run page renders these in
 * order so the transcript reads like the conversation actually happened
 * (thinking → tool call → more thinking → reply), instead of three disjoint
 * buckets. Consecutive same-kind text/thinking deltas merge into one segment.
 */
export type SubagentTimelineSegment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool"
      /** The originating `tool_use` block id, when the SDK supplied one. */
      id?: string
      name: string
      /** One-line input summary (`summarizeToolCall`), truncated for display. */
      summary: string
      status: "running" | "done" | "error"
    }

/** A live (or recently-settled) subagent run's accumulated output. */
export interface SubagentLiveEntry {
  /** Stable key the panel row + run-page reference (`live-…` or the bg `runId`). */
  liveId: string
  /** The subagent id (e.g. `general-purpose`). */
  name: string
  /** The task prompt (truncated for display). */
  task: string
  /** The chat session that started the run — the cross-session isolation key. */
  sessionId: string
  status: SubagentLiveStatus
  startedAt: number
  settledAt?: number
  /** Accumulated assistant text (bounded — keeps the tail). */
  text: string
  /** Accumulated reasoning (bounded — keeps the tail). */
  thinking: string
  tools: SubagentLiveTool[]
  /** Chronological transcript segments (bounded — keeps the tail). */
  timeline: SubagentTimelineSegment[]
  /** Total tool calls seen — monotonic, survives the `tools` array cap. */
  toolUseCount: number
  /** Rough character volume streamed through the run (text + thinking + tool
   * I/O) — the live token estimate before the exact end-of-turn usage lands. */
  approxChars: number
  /** Exact token spend from the end-of-turn `usage` event, once seen. */
  usageTokens?: number
  /** Bumped on every mutation — the run-page poller diffs this to detect change. */
  version: number
}

/**
 * The run's token count to display: the exact end-of-turn usage when it has
 * landed, else a live estimate (~4 chars/token) from the streamed volume so the
 * number grows while the agent works (Claude Code's live counter).
 */
export function liveTokenCount(entry: Pick<SubagentLiveEntry, "approxChars" | "usageTokens">): {
  tokens: number
  exact: boolean
} {
  if (entry.usageTokens !== undefined) return { tokens: entry.usageTokens, exact: true }
  return { tokens: Math.round(entry.approxChars / 4), exact: false }
}

/** What {@link startLiveSubagent} needs to seed an entry. */
export interface StartLiveSubagentMeta {
  /** Reuse a caller-owned id (background runs pass their `runId`); else minted. */
  liveId?: string
  name: string
  task: string
  sessionId: string
  /** Defaults to `Date.now()`. */
  startedAt?: number
}

// Keep at most this much text/thinking per entry (chars), keeping the tail — a
// runaway subagent can't blow up TUI memory, and the tail is what the user is
// watching anyway.
const TEXT_CAP = 200_000
// Keep at most this many tool rows per entry (most recent wins).
const TOOLS_CAP = 200
// Retain at most this many SETTLED entries; running entries are never evicted.
const SETTLED_KEEP = 50
// Truncate the displayed task to keep rows/headers compact.
const TASK_CAP = 200
// Keep at most this many timeline segments per entry (oldest dropped first).
const TIMELINE_CAP = 400
// Keep at most this much text across an entry's timeline segments (chars) —
// bounded independently of the aggregate `text`/`thinking` caps.
const TIMELINE_TEXT_CAP = 240_000
// Truncate a tool segment's input summary for display.
const TOOL_SUMMARY_CAP = 120

const entries = new Map<string, SubagentLiveEntry>()

function mintLiveId(): string {
  try {
    return `live-${crypto.randomUUID().slice(0, 8)}`
  } catch {
    return `live-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  }
}

/** Append `delta` to `base`, keeping only the trailing {@link TEXT_CAP} chars. */
function appendBounded(base: string, delta: string): string {
  const next = base + delta
  return next.length > TEXT_CAP ? next.slice(next.length - TEXT_CAP) : next
}

/** Rough character volume of a tool result, for the live token estimate. */
function approxResultChars(result: unknown): number {
  if (typeof result === "string") return result.length
  if (result == null) return 0
  try {
    return JSON.stringify(result)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * Append a text/thinking delta to the timeline: extend the trailing segment
 * when it has the same kind, else start a new one; then trim the timeline from
 * the front to its segment/char caps.
 */
function appendTimelineDelta(
  timeline: SubagentTimelineSegment[],
  kind: "text" | "thinking",
  delta: string
): void {
  const last = timeline[timeline.length - 1]
  if (last && last.kind === kind) last.text += delta
  else timeline.push({ kind, text: delta })
  trimTimeline(timeline)
}

/** Drop the oldest timeline segments past the segment/char caps. */
function trimTimeline(timeline: SubagentTimelineSegment[]): void {
  if (timeline.length > TIMELINE_CAP) timeline.splice(0, timeline.length - TIMELINE_CAP)
  let chars = 0
  for (const seg of timeline) if (seg.kind !== "tool") chars += seg.text.length
  let drop = 0
  while (chars > TIMELINE_TEXT_CAP && drop < timeline.length - 1) {
    const seg = timeline[drop]
    if (seg.kind !== "tool") chars -= seg.text.length
    drop++
  }
  if (drop > 0) timeline.splice(0, drop)
}

/**
 * Begin tracking a subagent run and return its live id. Background runs pass
 * their existing `runId` as `meta.liveId` so the panel sees ONE row (the live
 * entry and the journal record share the key); foreground runs get a minted id.
 */
export function startLiveSubagent(meta: StartLiveSubagentMeta): string {
  const liveId = meta.liveId ?? mintLiveId()
  entries.set(liveId, {
    liveId,
    name: meta.name,
    task: meta.task.length > TASK_CAP ? meta.task.slice(0, TASK_CAP) : meta.task,
    sessionId: meta.sessionId,
    status: "running",
    startedAt: meta.startedAt ?? Date.now(),
    text: "",
    thinking: "",
    tools: [],
    timeline: [],
    toolUseCount: 0,
    approxChars: 0,
    version: 0,
  })
  return liveId
}

/**
 * Fold one {@link CaptureStreamEvent} into the entry. No-op for an unknown id
 * (the run was evicted or never started) and for events that carry no display
 * state (`usage` / `compact`). Bumps `version` only when something changed.
 */
export function applyLiveSubagentEvent(liveId: string, event: CaptureStreamEvent): void {
  const entry = entries.get(liveId)
  if (!entry) return

  switch (event.type) {
    case "text-delta":
      if (!event.delta) return
      entry.text = appendBounded(entry.text, event.delta)
      appendTimelineDelta(entry.timeline, "text", event.delta)
      entry.approxChars += event.delta.length
      break
    case "thinking-delta":
      if (!event.delta) return
      entry.thinking = appendBounded(entry.thinking, event.delta)
      appendTimelineDelta(entry.timeline, "thinking", event.delta)
      entry.approxChars += event.delta.length
      break
    case "tool-call": {
      entry.tools.push({
        ...(event.id ? { id: event.id } : {}),
        name: event.toolName,
        status: "running",
      })
      // Cap from the front so the most recent tools survive.
      if (entry.tools.length > TOOLS_CAP) entry.tools.splice(0, entry.tools.length - TOOLS_CAP)
      const summary = summarizeToolCall(event.toolName, event.input)
      entry.timeline.push({
        kind: "tool",
        ...(event.id ? { id: event.id } : {}),
        name: event.toolName,
        summary:
          summary.length > TOOL_SUMMARY_CAP
            ? summary.slice(0, TOOL_SUMMARY_CAP - 1) + "…"
            : summary,
        status: "running",
      })
      trimTimeline(entry.timeline)
      entry.toolUseCount++
      entry.approxChars += summary.length
      break
    }
    case "tool-result": {
      // Resolve by id when known; otherwise the most recent still-running tool
      // with a matching name (best-effort for channels that omit ids).
      const next: SubagentLiveTool["status"] = event.isError ? "error" : "done"
      const target =
        (event.id ? entry.tools.find((t) => t.id === event.id) : undefined) ??
        [...entry.tools].reverse().find((t) => t.status === "running" && t.name === event.toolName)
      const seg =
        (event.id
          ? entry.timeline.find((s) => s.kind === "tool" && s.id === event.id)
          : undefined) ??
        [...entry.timeline]
          .reverse()
          .find((s) => s.kind === "tool" && s.status === "running" && s.name === event.toolName)
      if (!target && !seg) return
      if (target) target.status = next
      if (seg && seg.kind === "tool") seg.status = next
      // Count the result volume toward the live token estimate — tool results
      // dominate a research agent's input tokens, so this is what makes the
      // live counter track reality instead of the (tiny) reply text.
      entry.approxChars += approxResultChars(event.result)
      break
    }
    // Exact end-of-turn token spend — replaces the running estimate.
    case "usage": {
      const u = event.usage
      entry.usageTokens =
        (u.inputTokens ?? 0) +
        (u.outputTokens ?? 0) +
        (u.cacheCreationInputTokens ?? 0) +
        (u.cacheReadInputTokens ?? 0)
      break
    }
    // `compact` carries no run-page state — ignore without a version bump.
    default:
      return
  }
  entry.version++
}

/**
 * Mark a run settled. Any tool left "running" (the stream ended mid-tool, or was
 * interrupted) is resolved to `done`/`error` to match the terminal state, then
 * settled entries beyond the retention cap are evicted.
 */
export function settleLiveSubagent(liveId: string, status: SubagentLiveStatus): void {
  const entry = entries.get(liveId)
  if (!entry) return
  entry.status = status
  entry.settledAt = Date.now()
  const toolEnd: SubagentLiveTool["status"] = status === "error" ? "error" : "done"
  for (const tool of entry.tools) if (tool.status === "running") tool.status = toolEnd
  for (const seg of entry.timeline)
    if (seg.kind === "tool" && seg.status === "running") seg.status = toolEnd
  entry.version++
  evictSettled()
}

/**
 * Read one entry, scoped to `owner` when supplied: a run started by a different
 * session reads as `undefined` (the run page then shows "no live output").
 */
export function getLiveSubagent(liveId: string, owner?: string): SubagentLiveEntry | undefined {
  const entry = entries.get(liveId)
  if (!entry) return undefined
  if (owner !== undefined && entry.sessionId !== owner) return undefined
  return entry
}

/** List entries, scoped to `owner` when supplied (newest first). */
export function listLiveSubagents(owner?: string): SubagentLiveEntry[] {
  return [...entries.values()]
    .filter((e) => owner === undefined || e.sessionId === owner)
    .sort((a, b) => b.startedAt - a.startedAt)
}

function evictSettled(): void {
  const settled = [...entries.values()]
    .filter((e) => e.status !== "running")
    .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0))
  for (let i = 0; i < settled.length - SETTLED_KEEP; i++) {
    entries.delete(settled[i].liveId)
  }
}

export function __clearLiveSubagentsForTesting(): void {
  entries.clear()
}
