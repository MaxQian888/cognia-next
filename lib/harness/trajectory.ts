/**
 * Rollout trajectories as evidence (ADR-0237).
 *
 * Harness² serves editors the whole run, rendered as `[ACTION]`,
 * `[OBSERVATION]` and `[ERROR]` lines, with observations kept long (at least
 * 10k characters each) because the cause of a failure is usually in what a tool
 * returned, not in what the model said about it. This module builds that
 * rendering from either source a run can come from:
 *
 * - a probe's live capture stream ({@link createTrajectoryRecorder}), and
 * - a stored conversation's message parts ({@link trajectoryFromMessageParts}),
 *   for runs started from a failed session.
 *
 * Tool outputs are flattened by the same projection the `@result:` mention
 * selector uses (`projectToolOutputText`), so the two dialects of tool part and
 * the "a failed call returns its error" rule are not re-derived here.
 */

import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import { isToolPart, projectToolOutputText } from "@/lib/chat/mentions/tool-output-text"

/** Per-observation cap. Harness² requires at least 10k; errors are kept whole up to it too. */
export const OBSERVATION_MAX_CHARS = 12_000
/** Per-action input cap: arguments are usually short, file writes are not. */
export const ACTION_INPUT_MAX_CHARS = 4_000
/** Whole-trajectory cap. Past it the middle is cut and the cut is marked. */
export const TRAJECTORY_MAX_CHARS = 240_000

/** Tools that hand work to another agent. Their calls are reported as delegations. */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Task",
  "Agent",
  "dispatch_agent",
  "mcp__cognia-plugin-tools__dispatch_agent",
])

export type TrajectoryEntry =
  | { kind: "assistant"; text: string }
  | { kind: "action"; toolName: string; input: unknown; callId?: string }
  | { kind: "observation"; toolName: string; output: string; isError: boolean; callId?: string }

export interface TrajectorySummary {
  entries: TrajectoryEntry[]
  toolCalls: number
  toolFailures: number
  /** Assistant text blocks plus tool calls: the run's step count. */
  steps: number
  /** Delegation tool calls, as `<tool>:<subagent>` when the target is known. */
  delegations: string[]
  /** The last assistant text block: what the run finally said. */
  finalText: string
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

function cap(text: string, max: number, what: string): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[${what} truncated: ${text.length - max} more chars]`
}

function delegationLabel(toolName: string, input: unknown): string | null {
  if (!DELEGATION_TOOL_NAMES.has(toolName)) return null
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const target = record.subagent_type ?? record.subagentId ?? record.agent ?? record.name
  return typeof target === "string" && target ? `${toolName}:${target}` : toolName
}

/** Counts and the final text of a list of entries. */
export function summarizeTrajectory(entries: readonly TrajectoryEntry[]): TrajectorySummary {
  let toolCalls = 0
  let toolFailures = 0
  let steps = 0
  let finalText = ""
  const delegations: string[] = []
  for (const entry of entries) {
    if (entry.kind === "assistant") {
      if (entry.text.trim()) {
        steps += 1
        finalText = entry.text
      }
    } else if (entry.kind === "action") {
      toolCalls += 1
      steps += 1
      const label = delegationLabel(entry.toolName, entry.input)
      if (label) delegations.push(label)
    } else if (entry.isError) {
      toolFailures += 1
    }
  }
  return { entries: [...entries], toolCalls, toolFailures, steps, delegations, finalText }
}

/** Accumulates a probe's capture stream into trajectory entries. */
export interface TrajectoryRecorder {
  onEvent(event: CaptureStreamEvent): void
  /** Record an action the probe policy refused before it ran. */
  recordBlocked(toolName: string, input: unknown, reason: string): void
  entries(): TrajectoryEntry[]
  summary(): TrajectorySummary
}

export function createTrajectoryRecorder(): TrajectoryRecorder {
  const entries: TrajectoryEntry[] = []
  let text = ""
  const flushText = () => {
    if (text.trim()) entries.push({ kind: "assistant", text })
    text = ""
  }
  return {
    onEvent(event) {
      switch (event.type) {
        case "text-delta":
          text += event.delta
          break
        case "tool-call":
          flushText()
          entries.push({
            kind: "action",
            toolName: event.toolName,
            input: event.input,
            ...(event.id ? { callId: event.id } : {}),
          })
          break
        case "tool-result": {
          flushText()
          const isError = event.isError === true
          const output = isError
            ? projectToolOutputText(
                { state: "output-error", errorText: errorTextOf(event.result) },
                OBSERVATION_MAX_CHARS
              )
            : projectToolOutputText({ output: event.result }, OBSERVATION_MAX_CHARS)
          entries.push({
            kind: "observation",
            toolName: event.toolName,
            output,
            isError,
            ...(event.id ? { callId: event.id } : {}),
          })
          break
        }
        default:
          break
      }
    },
    recordBlocked(toolName, input, reason) {
      flushText()
      entries.push({ kind: "action", toolName, input })
      entries.push({
        kind: "observation",
        toolName,
        output: `Blocked by the probe policy: ${reason}`,
        isError: true,
      })
    },
    entries() {
      flushText()
      return [...entries]
    },
    summary() {
      flushText()
      return summarizeTrajectory(entries)
    },
  }
}

/** The text of an error result, whatever shape the runtime handed it over in. */
function errorTextOf(result: unknown): string {
  const flat = projectToolOutputText({ output: result }, OBSERVATION_MAX_CHARS)
  return flat || stringify(result)
}

/** A message part as stored on a session: text, or a tool part in either dialect. */
export interface TrajectoryPartLike {
  type?: unknown
  text?: unknown
  toolName?: unknown
  toolCallId?: unknown
  input?: unknown
  state?: unknown
  output?: unknown
  errorText?: unknown
}

export interface TrajectoryMessageLike {
  role?: unknown
  parts?: readonly TrajectoryPartLike[] | null
}

function toolNameOf(part: TrajectoryPartLike): string {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" && part.toolName ? part.toolName : "tool"
  }
  return typeof part.type === "string" ? part.type.slice("tool-".length) : "tool"
}

/**
 * Entries from stored assistant messages. User messages are left out: the task
 * prompt is evidence of its own, and mid-run user turns would read to an editor
 * as part of what the agent did.
 */
export function trajectoryFromMessageParts(
  messages: readonly TrajectoryMessageLike[]
): TrajectoryEntry[] {
  const entries: TrajectoryEntry[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        if (part.text.trim()) entries.push({ kind: "assistant", text: part.text })
        continue
      }
      if (!isToolPart(part)) continue
      const toolName = toolNameOf(part)
      const callId = typeof part.toolCallId === "string" ? part.toolCallId : undefined
      entries.push({ kind: "action", toolName, input: part.input, ...(callId ? { callId } : {}) })
      const output = projectToolOutputText(part, OBSERVATION_MAX_CHARS)
      const isError = part.state === "output-error"
      if (output || isError) {
        entries.push({
          kind: "observation",
          toolName,
          output: output || "Error: (no message)",
          isError,
          ...(callId ? { callId } : {}),
        })
      }
    }
  }
  return entries
}

/**
 * The text rendering editors read. A failed observation is an `[ERROR]` line so
 * a scan for failures finds it; assistant prose is `[ASSISTANT]`.
 */
export function renderTrajectory(
  entries: readonly TrajectoryEntry[],
  options: { maxChars?: number } = {}
): string {
  const lines: string[] = []
  for (const entry of entries) {
    if (entry.kind === "assistant") {
      lines.push(`[ASSISTANT] ${cap(entry.text.trim(), OBSERVATION_MAX_CHARS, "text")}`)
    } else if (entry.kind === "action") {
      const input = cap(stringify(entry.input ?? {}), ACTION_INPUT_MAX_CHARS, "input")
      lines.push(`[ACTION] ${entry.toolName} ${input}`)
    } else {
      const body = entry.output.trim() || "(empty)"
      lines.push(`${entry.isError ? "[ERROR]" : "[OBSERVATION]"} ${entry.toolName}\n${body}`)
    }
  }
  const text = lines.join("\n\n")
  const max = options.maxChars ?? TRAJECTORY_MAX_CHARS
  if (text.length <= max) return text
  // Keep the opening (how the run understood the task) and the end (how it
  // finished); the middle is the part an editor can most afford to lose.
  const head = Math.floor(max * 0.4)
  const tail = max - head
  return `${text.slice(0, head)}\n\n[… ${text.length - head - tail} chars of trajectory omitted …]\n\n${text.slice(text.length - tail)}`
}
