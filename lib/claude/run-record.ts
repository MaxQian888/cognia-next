/**
 * Pure aggregator for the Run Panel's "second clock" — derives a turn-level
 * `RunRecordView` (tools, sub-agents, todos, timing) from the chat-store slice
 * state. No React, no I/O, so the turn-boundary, ordering, and snapshot
 * semantics are unit tested in isolation. The view it returns is fed straight
 * to the panel (and snapshotted into Dexie by the persistence hook).
 */
import type { ToolUIPart, UIMessage } from "ai"

import { countCompletedTodos, parseTodoInput, type TodoEntry } from "@/lib/chat/todos"
import { describeToolResult, type ToolResultDescriptor } from "@/lib/chat/tool-result-summary"
import { isSubagentPart, type SubagentPart } from "@/lib/claude/parts-extensions"
import { RUNNING_TOOL_STATES, type RunStatus, type RunTiming } from "@/lib/claude/run-status"

/** TodoWrite renders as the Plan section, never as a generic tool row. */
const TODO_TOOL_TYPES = new Set(["tool-TodoWrite", "tool-mcp__cognia-tools__TodoWrite"])

/** One tool call in the turn — carries the live `part` so the panel can feed it to `<ToolCallRow>`. */
export interface RunToolEntry {
  /** `toolCallId` (or a positional fallback). */
  id: string
  /** Raw tool name, e.g. `Bash` / `mcp__x__y`. */
  toolName: string
  /** The live AI-SDK part — rendered directly by `<ToolCallRow>`. */
  part: ToolUIPart
  status: ToolUIPart["state"]
  /** Epoch ms — from the store's transient timestamp map; undefined until stamped. */
  startedAt?: number
  endedAt?: number
  /** Compact result descriptor (null while running / when there's nothing to show). */
  resultSummary: ToolResultDescriptor | null
}

/** Resolved status of a whole run, distinct from the live `RunStatus`. */
export type RunRecordStatus =
  | "running"
  | "awaiting_approval"
  | "done"
  | "error"
  | "interrupted"
  | "idle"

/** The in-memory aggregate the panel reads (and C snapshots into Dexie). */
export interface RunRecordView {
  sessionId: string
  runId: number | null
  status: RunRecordStatus
  timing: RunTiming
  /** Every tool of the turn, chronological (most-recent last). Excludes TodoWrite. */
  tools: RunToolEntry[]
  /** Subset of `tools` still running. */
  runningTools: RunToolEntry[]
  /** Subagent parts of the turn — fed to `<SubagentTree>`. */
  subagentParts: SubagentPart[]
  subagentIds: string[]
  /** Latest TodoWrite snapshot of the turn (authoritative full-snapshot). */
  todos: TodoEntry[]
  todoCounts: { done: number; total: number }
  counts: { tools: number; subagents: number }
}

export interface DeriveRunRecordInput {
  sessionId: string
  runId: number | null
  messages: readonly UIMessage[]
  runTiming: RunTiming
  status: RunStatus
  /** Transient per-tool timing keyed by `toolCallId` (chat-store slice). */
  toolTimestamps?: Record<string, { startedAt: number; endedAt?: number }>
}

/** The contiguous trailing assistant messages — the latest turn's run. */
function currentTurnMessages(messages: readonly UIMessage[]): UIMessage[] {
  const out: UIMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "assistant") break
    out.push(m)
  }
  return out.reverse()
}

function isToolPart(part: unknown): part is ToolUIPart & { toolCallId?: string } {
  const type = (part as { type?: unknown }).type
  return typeof type === "string" && type.startsWith("tool-")
}

export function deriveRunRecord(input: DeriveRunRecordInput): RunRecordView {
  const { sessionId, runId, messages, runTiming, status, toolTimestamps } = input
  const turn = currentTurnMessages(messages)

  const tools: RunToolEntry[] = []
  const subagentParts: SubagentPart[] = []
  let todos: TodoEntry[] = []

  turn.forEach((message, mi) => {
    const parts = (message.parts ?? []) as unknown[]
    parts.forEach((part, pi) => {
      if (isSubagentPart(part)) {
        subagentParts.push(part)
        return
      }
      if (!isToolPart(part)) return
      const type = (part as { type: string }).type
      if (TODO_TOOL_TYPES.has(type)) {
        const parsed = parseTodoInput((part as ToolUIPart).input)
        if (parsed) todos = parsed // last snapshot wins
        return
      }
      const id =
        typeof part.toolCallId === "string" && part.toolCallId.length > 0
          ? part.toolCallId
          : `${mi}-${pi}`
      const ts = toolTimestamps?.[id]
      tools.push({
        id,
        toolName: type.slice("tool-".length),
        part,
        status: part.state,
        startedAt: ts?.startedAt,
        endedAt: ts?.endedAt,
        resultSummary: describeToolResult(part),
      })
    })
  })

  const runningTools = tools.filter(
    (t) => typeof t.status === "string" && RUNNING_TOOL_STATES.has(t.status)
  )
  const subagentIds = subagentParts.map((p) => p.subagentId)
  const hasWork = tools.length > 0 || todos.length > 0 || subagentParts.length > 0

  return {
    sessionId,
    runId,
    status: resolveStatus(status, hasWork),
    timing: runTiming,
    tools,
    runningTools,
    subagentParts,
    subagentIds,
    todos,
    todoCounts: { done: countCompletedTodos(todos), total: todos.length },
    counts: { tools: tools.length, subagents: subagentParts.length },
  }
}

/** Per-tool timing map keyed by `toolCallId`. */
export type ToolTimestampMap = Record<string, { startedAt: number; endedAt?: number }>

/**
 * Fold the current turn's tool parts into the timing map: stamp `startedAt`
 * the first time a tool is seen and `endedAt` when it first reaches a terminal
 * state. Pure and idempotent — returns the *same reference* when nothing
 * changed, so the store can skip a no-op write. Only parts with a real
 * `toolCallId` are tracked (positional fallbacks aren't stable across renders).
 */
export function nextToolTimestamps(
  prev: ToolTimestampMap,
  messages: readonly UIMessage[],
  now: number
): ToolTimestampMap {
  let next = prev
  const mutable = (): ToolTimestampMap => {
    if (next === prev) next = { ...prev }
    return next
  }
  for (const message of currentTurnMessages(messages)) {
    for (const part of (message.parts ?? []) as unknown[]) {
      if (!isToolPart(part)) continue
      const type = (part as { type: string }).type
      if (TODO_TOOL_TYPES.has(type)) continue
      const id =
        typeof part.toolCallId === "string" && part.toolCallId.length > 0 ? part.toolCallId : null
      if (!id) continue
      const state = part.state
      const running = typeof state === "string" && RUNNING_TOOL_STATES.has(state)
      const existing = next[id]
      if (!existing) {
        mutable()[id] = { startedAt: now }
      } else if (!running && existing.endedAt == null) {
        mutable()[id] = { ...existing, endedAt: now }
      }
    }
  }
  return next
}

function resolveStatus(status: RunStatus, hasWork: boolean): RunRecordStatus {
  if (status === "streaming") return "running"
  if (status === "awaiting_approval") return "awaiting_approval"
  if (status === "error") return "error"
  return hasWork ? "done" : "idle"
}

/** Narrow an arbitrary chat status string onto the aggregator's `RunStatus`. */
export function toRunStatus(status: string): RunStatus {
  if (status === "streaming" || status === "awaiting_approval" || status === "error") return status
  return "idle"
}
