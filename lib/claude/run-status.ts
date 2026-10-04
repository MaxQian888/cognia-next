/**
 * Pure helpers for the web run-status layer (`<RunStatusBar>`) — the transient
 * "what's happening right now" surface pinned above the composer, the web
 * analogue of the CLI's `BottomStatus`. No React, no I/O — every export is a
 * pure function so the timing, formatting, and tool-line derivation are unit
 * tested in isolation.
 */
import type { UIMessage } from "ai"

export type RunStatus = "idle" | "streaming" | "awaiting_approval" | "error"

/**
 * Per-session turn clock. The elapsed timer measures *active* work — it pauses
 * while the turn is blocked on an approval (Codex's honest-timer behaviour),
 * so a 5-minute approval wait never reads as "working for 5m".
 */
export interface RunTiming {
  /** Epoch ms the current turn entered "streaming" (null when idle/error). */
  startedAt: number | null
  /** Epoch ms the turn paused for approval (null when not paused). */
  pausedAt: number | null
  /** Accumulated paused (awaiting-approval) ms banked across this turn. */
  pausedAccumMs: number
}

export const IDLE_TIMING: RunTiming = { startedAt: null, pausedAt: null, pausedAccumMs: 0 }

/**
 * Next turn clock for a status transition. Derives resume-vs-fresh from the
 * prior timing alone (a non-null `pausedAt` means we were blocked on approval),
 * so callers don't have to thread the previous status.
 *
 *  - → streaming : resume from a pause (bank the paused span) / start a fresh
 *                  clock when none is running / no-op when already running.
 *  - → awaiting_approval : start (or keep) the pause stopwatch.
 *  - → idle / error : clear the clock.
 */
export function nextRunTiming(prev: RunTiming, next: RunStatus, now: number): RunTiming {
  if (next === "streaming") {
    if (prev.pausedAt != null) {
      return {
        startedAt: prev.startedAt ?? now,
        pausedAt: null,
        pausedAccumMs: prev.pausedAccumMs + Math.max(0, now - prev.pausedAt),
      }
    }
    if (prev.startedAt == null) return { startedAt: now, pausedAt: null, pausedAccumMs: 0 }
    return prev
  }
  if (next === "awaiting_approval") {
    if (prev.startedAt == null) return { startedAt: now, pausedAt: now, pausedAccumMs: 0 }
    if (prev.pausedAt != null) return prev
    return { ...prev, pausedAt: now }
  }
  return IDLE_TIMING
}

/**
 * Active elapsed ms for the current turn, or null when no turn is running.
 * Subtracts banked pause time, and — while currently paused — the open pause
 * span too, so the displayed timer freezes during an approval wait.
 */
export function activeElapsedMs(timing: RunTiming, status: RunStatus, now: number): number | null {
  if (timing.startedAt == null) return null
  let ms = now - timing.startedAt - timing.pausedAccumMs
  if (status === "awaiting_approval" && timing.pausedAt != null) {
    ms -= Math.max(0, now - timing.pausedAt)
  }
  return Math.max(0, ms)
}

/** Compact elapsed string (`47s`, `4m 07s`, `1h 02m 09s`) — mirrors the CLI. */
export function formatRunElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor((ms ?? 0) / 1000))
  if (!Number.isFinite(totalSec)) return "0s"
  if (totalSec < 60) return `${totalSec}s`
  const s = totalSec % 60
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m ${String(s).padStart(2, "0")}s`
  const m = totalMin % 60
  const h = Math.floor(totalMin / 60)
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`
}

// ── Finished-turn duration ──────────────────────────────────────────────────

/** Per-tool timing keyed by `toolCallId`, as the chat-store slice keeps it. */
type ToolTimestampLookup = Readonly<Record<string, { startedAt: number; endedAt?: number }>>

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function positiveMs(value: unknown): number | null {
  const ms = finiteMs(value)
  return ms != null && ms > 0 ? ms : null
}

function metadataOf(message: UIMessage): Record<string, unknown> {
  const meta = (message as { metadata?: unknown }).metadata
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}
}

/**
 * How long the most recent *finished* turn took, from what the transcript
 * itself recorded — or `null` when nothing recorded can say.
 *
 * The live `RunTiming` cannot answer this: `nextRunTiming` clears it to
 * {@link IDLE_TIMING} the moment a turn settles, and it is never persisted, so
 * a "last run" summary that read it always rendered `0s` — for a turn that ran
 * for minutes. A turn is the trailing assistant messages after the last
 * non-assistant one (the same boundary `deriveRunRecord` uses). In order:
 *
 * 1. A duration the turn was sealed with, newest message first: the run stamp's
 *    `durationMs` (the runtime's own report), its `completedAt − startedAt`,
 *    or the SDK usage's `durationMs`. A reported `0` is not a duration — a
 *    non-SDK turn reports exactly that — so it falls through.
 * 2. A span over the turn's own timestamps: from the earliest start signal
 *    (the prompt's and the turn messages' `createdAt`, the run stamp's
 *    `startedAt`, a tool's `startedAt`) to the latest *finish* signal (the
 *    run stamp's `completedAt`, a tool's `endedAt`). A message's `createdAt`
 *    is when its row was first written — the start of that message, not its
 *    end — so it never closes a span: a one-message turn would otherwise read
 *    as a second or two however long it ran, the same lie as `0s`.
 *
 * Unknown stays unknown: callers omit the duration rather than invent one.
 */
export function lastTurnElapsedMs(
  messages: readonly UIMessage[],
  toolTimestamps?: ToolTimestampLookup
): number | null {
  let firstTurnIndex = messages.length
  while (firstTurnIndex > 0 && messages[firstTurnIndex - 1]!.role === "assistant") {
    firstTurnIndex -= 1
  }
  if (firstTurnIndex === messages.length) return null
  const turn = messages.slice(firstTurnIndex)
  const prompt = firstTurnIndex > 0 ? messages[firstTurnIndex - 1] : undefined

  for (let i = turn.length - 1; i >= 0; i -= 1) {
    const meta = metadataOf(turn[i]!)
    const run = asRecord(meta.run)
    const reported = positiveMs(run.durationMs)
    if (reported != null) return reported
    const runStarted = finiteMs(run.startedAt)
    const runCompleted = finiteMs(run.completedAt)
    if (runStarted != null && runCompleted != null && runCompleted > runStarted) {
      return runCompleted - runStarted
    }
    const usage = positiveMs(asRecord(meta.usage).durationMs)
    if (usage != null) return usage
  }

  const starts: number[] = []
  const ends: number[] = []
  const pushFinite = (into: number[], value: unknown) => {
    const ms = finiteMs(value)
    if (ms != null) into.push(ms)
  }
  if (prompt) pushFinite(starts, metadataOf(prompt).createdAt)
  for (const message of turn) {
    const meta = metadataOf(message)
    pushFinite(starts, meta.createdAt)
    const run = asRecord(meta.run)
    pushFinite(starts, run.startedAt)
    pushFinite(ends, run.completedAt)
    if (!toolTimestamps) continue
    for (const part of (message.parts ?? []) as unknown[]) {
      const id = (part as { toolCallId?: unknown }).toolCallId
      if (typeof id !== "string" || id.length === 0) continue
      const stamp = toolTimestamps[id]
      if (!stamp) continue
      pushFinite(starts, stamp.startedAt)
      pushFinite(ends, stamp.endedAt)
    }
  }
  if (starts.length === 0 || ends.length === 0) return null
  const span = Math.max(...ends) - Math.min(...starts)
  return span > 0 ? span : null
}

// ── Running-tool detail lines ───────────────────────────────────────────────

/** A readable label for a tool, collapsing `mcp__server__tool` → `server:tool`. */
export function toolDisplayName(toolName: string): string {
  const m = /^(?:mcp|plugin)__(.+?)__(.+)$/.exec(toolName)
  return m ? `${m[1]}:${m[2]}` : toolName
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
}

function firstString(input: Record<string, unknown>, keys: string[], max = 80): string | undefined {
  for (const key of keys) {
    const v = input[key]
    if (typeof v === "string" && v.length > 0) {
      return v.length > max ? v.slice(0, max - 1) + "…" : v
    }
  }
  return undefined
}

/** A compact summary of a tool call (file path / command / pattern / url). */
export function summarizeToolCall(toolName: string, input: unknown): string {
  const rec = asRecord(input)
  const name = toolDisplayName(toolName).toLowerCase()
  if (name === "bash" || name === "shell") return firstString(rec, ["command", "cmd"]) ?? ""
  if (name === "grep" || name === "search") {
    return [firstString(rec, ["pattern", "query", "regex"]), firstString(rec, ["path", "glob"], 40)]
      .filter(Boolean)
      .join("  ")
  }
  if (name === "glob") return firstString(rec, ["pattern", "glob"]) ?? ""
  if (name === "read") return firstString(rec, ["file_path", "filePath", "path"]) ?? ""
  if (name === "webfetch" || name === "web_fetch" || name === "fetch")
    return firstString(rec, ["url", "uri"]) ?? ""
  if (name === "task" || name === "agent")
    return firstString(rec, ["subagent_type", "description", "prompt"]) ?? ""
  return firstString(rec, ["file_path", "filePath", "path", "url", "query", "command"]) ?? ""
}

/** `<tool>: <summary>` (or just `<tool>` when there's no natural summary). */
export function formatToolLine(toolName: string, input: unknown): string {
  const label = toolDisplayName(toolName)
  const summary = summarizeToolCall(toolName, input)
  return summary ? `${label}: ${summary}` : label
}

export interface ActiveToolLine {
  id: string
  label: string
}

/** AI-SDK tool-part states that mean "still running" (no output yet). */
export const RUNNING_TOOL_STATES = new Set(["input-streaming", "input-available"])

/**
 * The still-running tool calls of the latest assistant message, most-recent
 * last, capped at `max`. A tool part counts as running when its `state` is an
 * input phase (or absent) — i.e. it has not produced output or errored yet.
 * Empty when nothing is running.
 */
export function selectActiveToolLines(messages: readonly UIMessage[], max = 3): ActiveToolLine[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    const lines: ActiveToolLine[] = []
    const parts = (m.parts ?? []) as Array<Record<string, unknown>>
    for (const part of parts) {
      const type = part.type
      if (typeof type !== "string" || !type.startsWith("tool-")) continue
      const state = part.state
      if (typeof state === "string" && !RUNNING_TOOL_STATES.has(state)) continue
      const toolName = type.slice("tool-".length)
      const id = typeof part.toolCallId === "string" ? part.toolCallId : `${i}-${lines.length}`
      lines.push({ id, label: formatToolLine(toolName, part.input) })
    }
    return lines.slice(Math.max(0, lines.length - max))
  }
  return []
}

// ── Subagent chip ───────────────────────────────────────────────────────────

export interface SubagentChip {
  /** Name of the most-recently-running subagent. */
  name: string
  /** How many subagents are running right now. */
  count: number
}

/**
 * A chip describing the subagents running right now, or null when none are.
 * The runtime registry is process-global (a `SubAgent` carries no chat-session
 * id), so the caller only mounts this while its own session is streaming.
 */
export function selectRunningSubagentChip(
  subAgents: Record<string, { name: string; status: string }>
): SubagentChip | null {
  const running = Object.values(subAgents).filter((s) => s.status === "running")
  if (running.length === 0) return null
  return { name: running[running.length - 1]!.name, count: running.length }
}
