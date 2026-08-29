// OpenAI Codex CLI session-history source.
//
// On disk: `<codexHome>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, where
// `codexHome` is `$CODEX_HOME` or `~/.codex` — resolved in Rust and delivered
// through `SessionScanInput.roots` (`lib/agent-roots/`), because the renderer
// cannot read environment variables.
// Each line is a `RolloutLine` = `{ timestamp, type, payload }`,
// with `type` ∈ session_meta | response_item | event_msg | turn_context |
// compacted. We reconstruct the conversation from `response_item` payloads:
//
//   message (role + content[input_text|output_text]) → text
//   reasoning (summary/text)                          → reasoning
//   function_call (name, arguments, call_id)          → tool-<name> (input)
//   function_call_output (call_id, output)            → patch tool output
//   custom_tool_call[_output]                         → tool + patch
//   ghost_snapshot                                    → filtered out
//
// Item taxonomy reference: lib/ai/agent/external/codex-app-server-client.ts.

import { joinPath } from "@/lib/claude/instructions/paths"
import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@cognia/agent-config-types"
import { redactText } from "@cognia/redact"
import type {
  CanonicalHistoryEvent,
  CanonicalInterAgentMessage,
  CanonicalRecordedEvent,
  CanonicalSessionGoal,
  CanonicalSessionLifecycle,
  CanonicalSessionPlan,
  CanonicalSessionRelationKind,
  CanonicalSessionTask,
  SessionLossEntry,
} from "@cognia/agent-config-types/canonical-session"
import type { UsageInfo } from "@/lib/claude/adapter"
import { scanFileSummaries } from "../scan"
import { buildImportedSessionGraph } from "../graph"
import { importedUsageMetadata } from "../usage"
import {
  buildMessage,
  buildSession,
  deriveTitle,
  filePart,
  importedMessageId,
  importedSessionId,
  reasoningPart,
  textPart,
  toolPart,
} from "../to-parts"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "../types"

type Part = StoredMessage["parts"][number]

const ACCEPTED = [".jsonl"]

interface RolloutLine {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
}

interface ParsedSession {
  originalSessionId: string
  cwd?: string
  model?: string
  title: string
  messages: StoredMessage[]
  createdAt: number
  updatedAt: number
  sourceVersion?: string
  relationKind?: CanonicalSessionRelationKind
  parentNativeSessionId?: string
  lifecycle?: CanonicalSessionLifecycle
  goals: CanonicalSessionGoal[]
  plans: CanonicalSessionPlan[]
  tasks: CanonicalSessionTask[]
  history: CanonicalHistoryEvent[]
  interAgentMessages: CanonicalInterAgentMessage[]
  recordedEvents: CanonicalRecordedEvent[]
  losses: SessionLossEntry[]
}

function tsToMs(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback
  const n = Date.parse(ts)
  return Number.isNaN(n) ? fallback : n
}

/** Codex token accounting block (fields best-effort; names vary by version). */
interface CodexTokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

/** Cumulative token totals threaded across the rollout to derive per-turn deltas. */
interface CumulativeTokens {
  input: number
  output: number
  cacheRead: number
}

const ZERO_CUMULATIVE: CumulativeTokens = { input: 0, output: 0, cacheRead: 0 }

function numOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function toUsageInfo(u: CodexTokenUsage): UsageInfo {
  return {
    inputTokens: numOf(u.input_tokens),
    outputTokens: numOf(u.output_tokens),
    cacheReadInputTokens: numOf(u.cached_input_tokens),
    ...(u.reasoning_output_tokens ? { reasoningTokens: numOf(u.reasoning_output_tokens) } : {}),
  }
}

/**
 * Resolve one `token_count` event to per-turn usage. Prefers the event's own
 * `last_token_usage`; otherwise derives the turn's delta from the running
 * `total_token_usage`. Returns `null` (and leaves `prev` untouched) when the
 * event carries no usable counts. Mutates `prev` to the new cumulative totals.
 */
function codexTurnUsage(info: Record<string, unknown>, prev: CumulativeTokens): UsageInfo | null {
  const last = info.last_token_usage as CodexTokenUsage | undefined
  const total = info.total_token_usage as CodexTokenUsage | undefined
  if (last && (last.input_tokens || last.output_tokens || last.cached_input_tokens)) {
    return toUsageInfo(last)
  }
  if (total) {
    const input = numOf(total.input_tokens)
    const output = numOf(total.output_tokens)
    const cacheRead = numOf(total.cached_input_tokens)
    const delta: UsageInfo = {
      inputTokens: Math.max(0, input - prev.input),
      outputTokens: Math.max(0, output - prev.output),
      cacheReadInputTokens: Math.max(0, cacheRead - prev.cacheRead),
    }
    prev.input = input
    prev.output = output
    prev.cacheRead = cacheRead
    if (!delta.inputTokens && !delta.outputTokens && !delta.cacheReadInputTokens) return null
    return delta
  }
  return null
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/** Extract the concatenated text from a Codex message payload's content array. */
function messageText(payload: Record<string, unknown>): string {
  const content = payload.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const out: string[] = []
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>
      if (typeof b.text === "string") out.push(b.text)
    }
  }
  return out.join("")
}

function messageParts(payload: Record<string, unknown>): Part[] {
  const content = payload.content
  if (typeof content === "string") return content ? [textPart(content)] : []
  if (!Array.isArray(content)) return []
  const parts: Part[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const value = block as Record<string, unknown>
    if (typeof value.text === "string" && value.text) parts.push(textPart(value.text))
    const url = asString(value.image_url) || asString(value.audio_url)
    if (url) {
      parts.push(
        filePart({
          mediaType: asString(value.type) === "input_audio" ? "audio/*" : "image/*",
          url,
        })
      )
    }
  }
  return parts
}

/** Extract reasoning text (summary or text arrays / plain string). */
function reasoningText(payload: Record<string, unknown>): string {
  for (const key of ["summary", "content", "text"]) {
    const v = payload[key]
    if (typeof v === "string" && v) return v
    if (Array.isArray(v)) {
      const texts = v
        .map((b) =>
          b && typeof b === "object" ? asString((b as Record<string, unknown>).text) : ""
        )
        .filter(Boolean)
      if (texts.length) return texts.join("\n")
    }
  }
  return ""
}

function nestedString(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  if (typeof record[key] === "string") return record[key]
  for (const child of Object.values(record)) {
    const found = nestedString(child, key)
    if (found) return found
  }
  return ""
}

function diagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]"
  if (typeof value === "string") {
    const bounded = value.length > 1000 ? `${value.slice(0, 1000)}…` : value
    return redactText(bounded).redacted
  }
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => diagnosticValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value).slice(0, 30)) {
    out[key] = /token|secret|password|authorization|api[_-]?key/i.test(key)
      ? "[redacted]"
      : diagnosticValue(child, depth + 1)
  }
  return out
}

function lifecycleStatus(value: unknown): CanonicalSessionLifecycle["status"] {
  const status = asString(value).toLowerCase()
  if (status === "completed" || status === "complete" || status === "done") return "completed"
  if (status === "failed" || status === "error") return "failed"
  if (status === "cancelled" || status === "canceled") return "cancelled"
  if (status === "interrupted") return "interrupted"
  if (status === "waiting") return "waiting"
  if (status === "pending") return "pending"
  return "running"
}

function eventText(payload: Record<string, unknown>): string {
  return asString(payload.message) || asString(payload.detail) || asString(payload.reason)
}

export function parseCodexRollout(
  content: string,
  locatorId: string,
  projectId?: string
): ParsedSession {
  const messages: StoredMessage[] = []
  const toolIndex = new Map<string, { m: number; p: number }>()
  let sessionId = ""
  let cwd: string | undefined
  let model: string | undefined
  let firstUserText = ""
  let createdAt = 0
  let updatedAt = 0
  let msgCounter = 0
  let sourceVersion: string | undefined
  let relationKind: CanonicalSessionRelationKind | undefined
  let parentNativeSessionId: string | undefined
  let lifecycle: CanonicalSessionLifecycle | undefined
  const plans: CanonicalSessionPlan[] = []
  const goals: CanonicalSessionGoal[] = []
  const tasks: CanonicalSessionTask[] = []
  const history: CanonicalHistoryEvent[] = []
  const interAgentMessages: CanonicalInterAgentMessage[] = []
  const recordedEvents: CanonicalRecordedEvent[] = []
  const losses: SessionLossEntry[] = []
  let eventSequence = 0
  // Codex emits token accounting as a standalone `event_msg` after each turn,
  // so we attach it to the turn's last-seen assistant message.
  let lastAssistantIndex = -1
  const prevTotal: CumulativeTokens = { ...ZERO_CUMULATIVE }

  const sid = () => importedSessionId("codex", sessionId || locatorId)

  for (const [lineIndex, line] of content.split("\n").entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: RolloutLine
    try {
      rec = JSON.parse(trimmed) as RolloutLine
    } catch {
      losses.push({
        path: `jsonl[${lineIndex}]`,
        kind: "dropped",
        detail: "Unparseable rollout record.",
      })
      continue
    }
    const ms = tsToMs(rec.timestamp, updatedAt || Date.now())
    if (!createdAt) createdAt = ms
    updatedAt = Math.max(updatedAt, ms)
    const payload = rec.payload ?? {}

    if (rec.type === "session_meta") {
      sessionId = asString(payload.id) || asString(payload.session_id) || sessionId
      cwd = asString(payload.cwd) || cwd
      model = asString(payload.model) || asString(payload.model_provider) || model
      sourceVersion = asString(payload.cli_version) || sourceVersion
      const forkedFrom = asString(payload.forked_from_id)
      const parent =
        asString(payload.parent_thread_id) || nestedString(payload.source, "parent_thread_id")
      if (forkedFrom) {
        relationKind = "fork"
        parentNativeSessionId = forkedFrom
      } else if (parent) {
        relationKind = "subagent"
        parentNativeSessionId = parent
      }
      continue
    }
    if (rec.type === "turn_context") {
      model = asString(payload.model) || model
      continue
    }
    if (rec.type === "event_msg") {
      const eventType = asString(payload.type)
      if (eventType === "token_count") {
        const info = (
          payload.info && typeof payload.info === "object" ? payload.info : payload
        ) as Record<string, unknown>
        const usage = codexTurnUsage(info, prevTotal)
        if (usage && lastAssistantIndex >= 0) {
          messages[lastAssistantIndex] = {
            ...messages[lastAssistantIndex],
            metadata: importedUsageMetadata(usage, model),
          }
        }
        recordedEvents.push({
          eventId: `codex-event-${eventSequence}`,
          sequence: eventSequence++,
          at: rec.timestamp,
          event: { kind: "usage", usage: diagnosticValue(info) as Record<string, unknown> },
        })
        continue
      }
      if (eventType === "turn_started") {
        lifecycle = { status: "running", startedAt: rec.timestamp, updatedAt: rec.timestamp }
        recordedEvents.push({
          eventId: `codex-event-${eventSequence}`,
          sequence: eventSequence++,
          turnId: asString(payload.turn_id) || undefined,
          at: rec.timestamp,
          event: { kind: "lifecycle", phase: "started" },
        })
        continue
      }
      if (eventType === "turn_complete") {
        const error = payload.error
        lifecycle = {
          status: error ? "failed" : "completed",
          startedAt: lifecycle?.startedAt,
          updatedAt: rec.timestamp,
          endedAt: rec.timestamp,
          ...(error ? { error: JSON.stringify(diagnosticValue(error)) } : {}),
        }
        recordedEvents.push({
          eventId: `codex-event-${eventSequence}`,
          sequence: eventSequence++,
          turnId: asString(payload.turn_id) || undefined,
          at: rec.timestamp,
          event: error
            ? { kind: "failure", code: "turn_complete", message: lifecycle.error ?? "Turn failed" }
            : { kind: "lifecycle", phase: "ended" },
        })
        continue
      }
      if (eventType === "turn_aborted") {
        lifecycle = {
          status: "interrupted",
          startedAt: lifecycle?.startedAt,
          updatedAt: rec.timestamp,
          endedAt: rec.timestamp,
          error: eventText(payload) || "interrupted",
        }
        recordedEvents.push({
          eventId: `codex-event-${eventSequence}`,
          sequence: eventSequence++,
          turnId: asString(payload.turn_id) || undefined,
          at: rec.timestamp,
          event: { kind: "lifecycle", phase: "interrupted", detail: lifecycle.error },
        })
        continue
      }
      if (eventType === "plan_update") {
        const entries = Array.isArray(payload.plan) ? payload.plan : []
        plans.splice(0, plans.length, {
          planId: asString(payload.plan_id) || `plan-${plans.length + 1}`,
          title: asString(payload.explanation) || undefined,
          status: entries.every(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              asString((entry as Record<string, unknown>).status) === "completed"
          )
            ? "completed"
            : "active",
          steps: entries
            .map((entry) =>
              entry && typeof entry === "object"
                ? asString((entry as Record<string, unknown>).step)
                : ""
            )
            .filter(Boolean),
          updatedAt: rec.timestamp,
        })
        continue
      }
      if (eventType === "goal_update") {
        const description =
          asString(payload.description) || asString(payload.goal) || asString(payload.objective)
        if (description) {
          goals.splice(0, goals.length, {
            goalId: asString(payload.goal_id) || "goal-1",
            description,
            status:
              lifecycleStatus(payload.status) === "completed"
                ? "completed"
                : lifecycleStatus(payload.status) === "cancelled"
                  ? "cancelled"
                  : lifecycleStatus(payload.status) === "failed"
                    ? "blocked"
                    : "active",
            updatedAt: rec.timestamp,
          })
        }
        continue
      }
      if (eventType === "context_compacted") {
        history.push({
          historyId: `compaction-${history.length + 1}`,
          kind: "compaction",
          at: rec.timestamp,
        })
        recordedEvents.push({
          eventId: `codex-event-${eventSequence}`,
          sequence: eventSequence++,
          at: rec.timestamp,
          event: { kind: "compact", trigger: "auto" },
        })
        continue
      }
      if (eventType === "thread_rolled_back") {
        history.push({
          historyId: `rollback-${history.length + 1}`,
          kind: "rollback",
          at: rec.timestamp,
          summary: `${numOf(payload.num_turns)} turn(s) removed`,
        })
        continue
      }
      if (eventType === "collab_agent_spawn_begin" || eventType === "collab_agent_spawn_end") {
        const taskId = asString(payload.call_id) || `collab-${tasks.length + 1}`
        const existing = tasks.findIndex((task) => task.taskId === taskId)
        const task: CanonicalSessionTask = {
          taskId,
          description: asString(payload.prompt) || undefined,
          status:
            eventType === "collab_agent_spawn_begin" ? "running" : lifecycleStatus(payload.status),
          toolCallId: taskId,
          childCanonicalSessionId: asString(payload.new_thread_id)
            ? `canon:codex:${importedSessionId("codex", asString(payload.new_thread_id))}`
            : undefined,
          startedAt: existing >= 0 ? tasks[existing].startedAt : rec.timestamp,
          endedAt:
            eventType === "collab_agent_spawn_end" && lifecycleStatus(payload.status) !== "running"
              ? rec.timestamp
              : undefined,
        }
        if (existing >= 0) tasks[existing] = task
        else tasks.push(task)
        recordedEvents.push({
          eventId: `codex-event-${eventSequence}`,
          sequence: eventSequence++,
          at: rec.timestamp,
          event: {
            kind: "subagent",
            phase: eventType.endsWith("begin") ? "started" : "ended",
            runtimeBinding: asString(payload.new_thread_id) || undefined,
          },
        })
        continue
      }
      if (eventType === "warning" || eventType === "error") {
        const text = eventText(payload)
        if (text) {
          messages.push(
            buildMessage({
              sessionId: sid(),
              projectId,
              index: msgCounter++,
              role: "system",
              parts: [textPart(text)],
              createdAt: ms,
            })
          )
        }
        recordedEvents.push({
          eventId: `codex-event-${eventSequence}`,
          sequence: eventSequence++,
          at: rec.timestamp,
          event:
            eventType === "warning"
              ? { kind: "warning", code: "codex", message: text }
              : { kind: "failure", code: "codex", message: text },
        })
        continue
      }
      if (eventType) {
        recordedEvents.push({
          eventId: `codex-event-${eventSequence}`,
          sequence: eventSequence++,
          at: rec.timestamp,
          event: {
            kind: "diagnostic",
            runtime: "codex",
            payload: { type: eventType, summary: diagnosticValue(payload) },
          },
        })
        losses.push({
          path: `event_msg.${eventType}`,
          kind: "approximated",
          detail: "Unknown Codex event retained as a bounded redacted diagnostic.",
        })
      }
      continue
    }
    // Context-compaction boundary — previously dropped. Surface it as a system
    // marker so the compacted history is visible in the imported transcript.
    if (rec.type === "compacted") {
      const note = messageText(payload) || asString(payload.message) || "Context compacted"
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role: "system",
          parts: [textPart(note)],
          createdAt: ms,
        })
      )
      history.push({
        historyId: `compaction-${history.length + 1}`,
        kind: "compaction",
        at: rec.timestamp,
        summary: note,
      })
      continue
    }
    if (rec.type !== "response_item") {
      recordedEvents.push({
        eventId: `codex-event-${eventSequence}`,
        sequence: eventSequence++,
        at: rec.timestamp,
        event: {
          kind: "diagnostic",
          runtime: "codex",
          payload: { type: rec.type || "unknown", summary: diagnosticValue(payload) },
        },
      })
      losses.push({
        path: `rollout.${rec.type || "unknown"}`,
        kind: "approximated",
        detail: "Unknown Codex rollout item retained as a bounded redacted diagnostic.",
      })
      continue
    }

    const itemType = asString(payload.type)
    if (itemType === "ghost_snapshot") {
      recordedEvents.push({
        eventId: `codex-event-${eventSequence}`,
        sequence: eventSequence++,
        at: rec.timestamp,
        event: {
          kind: "diagnostic",
          runtime: "codex",
          payload: { type: itemType, summary: diagnosticValue(payload) },
        },
      })
      losses.push({
        path: "response_item.ghost_snapshot",
        kind: "approximated",
        detail: "Ghost snapshot retained as a bounded redacted diagnostic.",
      })
      continue
    }

    if (itemType === "agent_message") {
      const text = messageText(payload)
      if (!text) continue
      const author = asString(payload.author) || sessionId || "agent"
      const recipient = asString(payload.recipient) || undefined
      interAgentMessages.push({
        messageId: asString(payload.id) || `agent-message-${interAgentMessages.length + 1}`,
        fromSessionId: author,
        toSessionId: recipient,
        text,
        at: rec.timestamp,
      })
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role: "system",
          parts: [textPart(text)],
          createdAt: ms,
          metadata: { codexAgentMessage: { author, recipient } },
        })
      )
      continue
    }

    if (itemType === "message") {
      const role = asString(payload.role) === "assistant" ? "assistant" : "user"
      const text = messageText(payload)
      const contentParts = messageParts(payload)
      if (contentParts.length === 0) continue
      if (role === "user" && !firstUserText) firstUserText = text
      const phase = asString(payload.phase)
      const part =
        role === "assistant" && phase === "commentary"
          ? ({
              type: "data-commentary",
              data: {
                ...(asString(payload.id) ? { messageId: asString(payload.id) } : {}),
                text,
                state: "done",
                source: "codex",
              },
            } as unknown as Part)
          : undefined
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role,
          parts: part ? [part] : contentParts,
          createdAt: ms,
        })
      )
      if (role === "assistant") lastAssistantIndex = messages.length - 1
      continue
    }

    if (itemType === "reasoning") {
      const text = reasoningText(payload)
      if (!text) continue
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role: "assistant",
          parts: [reasoningPart(text)],
          createdAt: ms,
        })
      )
      lastAssistantIndex = messages.length - 1
      continue
    }

    if (itemType === "local_shell_call") {
      const callId = asString(payload.call_id) || asString(payload.id) || `shell-${msgCounter}`
      const part = toolPart({
        name: "local_shell",
        toolCallId: callId,
        input:
          payload.action && typeof payload.action === "object"
            ? (payload.action as Record<string, unknown>)
            : { action: payload.action },
      }) as Part & Record<string, unknown>
      part.status = asString(payload.status) || "running"
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role: "assistant",
          parts: [part],
          createdAt: ms,
        })
      )
      lastAssistantIndex = messages.length - 1
      toolIndex.set(callId, { m: lastAssistantIndex, p: 0 })
      continue
    }

    if (itemType === "web_search_call") {
      const callId = asString(payload.id) || `web-${msgCounter}`
      const part = toolPart({
        name: "web_search",
        toolCallId: callId,
        input:
          payload.action && typeof payload.action === "object"
            ? (payload.action as Record<string, unknown>)
            : {},
        ...(asString(payload.status) === "completed" ? { output: { status: "completed" } } : {}),
      }) as Part & Record<string, unknown>
      part.status = asString(payload.status) || "running"
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role: "assistant",
          parts: [part],
          createdAt: ms,
        })
      )
      lastAssistantIndex = messages.length - 1
      continue
    }

    if (itemType === "image_generation_call") {
      const callId = asString(payload.id) || `image-${msgCounter}`
      const result = asString(payload.result)
      const part = toolPart({
        name: "image_generation",
        toolCallId: callId,
        input: { revisedPrompt: asString(payload.revised_prompt) || undefined },
        ...(result ? { output: { base64: result, status: asString(payload.status) } } : {}),
        isError: asString(payload.status) === "failed",
      }) as Part & Record<string, unknown>
      part.status = asString(payload.status) || "completed"
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role: "assistant",
          parts: [part],
          createdAt: ms,
        })
      )
      lastAssistantIndex = messages.length - 1
      continue
    }

    if (itemType === "tool_search_call") {
      const callId =
        asString(payload.call_id) || asString(payload.id) || `tool-search-${msgCounter}`
      const part = toolPart({
        name: "tool_search",
        toolCallId: callId,
        input:
          payload.arguments && typeof payload.arguments === "object"
            ? (payload.arguments as Record<string, unknown>)
            : { arguments: payload.arguments },
      }) as Part & Record<string, unknown>
      part.status = asString(payload.status) || "running"
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role: "assistant",
          parts: [part],
          createdAt: ms,
        })
      )
      lastAssistantIndex = messages.length - 1
      toolIndex.set(callId, { m: lastAssistantIndex, p: 0 })
      continue
    }

    if (itemType === "tool_search_output") {
      const callId = asString(payload.call_id) || asString(payload.id)
      const loc = callId ? toolIndex.get(callId) : undefined
      const part = loc
        ? (messages[loc.m]?.parts[loc.p] as Record<string, unknown> | undefined)
        : undefined
      if (loc && part) {
        messages[loc.m].parts[loc.p] = {
          ...part,
          state: asString(payload.status) === "failed" ? "output-error" : "output-available",
          ...(asString(payload.status) === "failed"
            ? { errorText: JSON.stringify(payload.tools ?? []) }
            : { output: payload.tools ?? [] }),
          status: asString(payload.status),
        } as unknown as Part
      }
      continue
    }

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callId = asString(payload.call_id) || asString(payload.id) || `call-${msgCounter}`
      const name = asString(payload.name) || "tool"
      const rawArgs = payload.arguments ?? payload.input
      const input = parseMaybeJson(rawArgs)
      const part = toolPart({ name, toolCallId: callId, input })
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role: "assistant",
          parts: [part],
          createdAt: ms,
        })
      )
      lastAssistantIndex = messages.length - 1
      toolIndex.set(callId, { m: messages.length - 1, p: 0 })
      continue
    }

    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const callId = asString(payload.call_id) || asString(payload.id)
      const loc = callId ? toolIndex.get(callId) : undefined
      if (!loc) continue
      const msg = messages[loc.m]
      const part = msg?.parts[loc.p] as Record<string, unknown> | undefined
      if (!part) continue
      const output = extractOutput(payload.output)
      const isError = isCodexToolError(payload.output)
      msg.parts[loc.p] = {
        ...part,
        state: isError ? "output-error" : "output-available",
        ...(isError
          ? { errorText: typeof output === "string" ? output : JSON.stringify(output) }
          : { output }),
      } as unknown as Part
      continue
    }

    recordedEvents.push({
      eventId: `codex-event-${eventSequence}`,
      sequence: eventSequence++,
      at: rec.timestamp,
      event: {
        kind: "diagnostic",
        runtime: "codex",
        payload: { type: itemType || "unknown", summary: diagnosticValue(payload) },
      },
    })
    losses.push({
      path: `response_item.${itemType || "unknown"}`,
      kind: "approximated",
      detail: "Unknown Codex response item retained as a bounded redacted diagnostic.",
    })
  }

  const finalId = sid()
  messages.forEach((m, i) => {
    m.sessionId = finalId
    m.id = importedMessageId(finalId, i)
  })

  const now = Date.now()
  return {
    originalSessionId: sessionId || locatorId,
    cwd,
    model,
    title: deriveTitle(firstUserText, "Codex session"),
    messages,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
    sourceVersion,
    relationKind,
    parentNativeSessionId,
    lifecycle,
    goals,
    plans,
    tasks,
    history,
    interAgentMessages,
    recordedEvents,
    losses,
  }
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? {}
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

function extractOutput(output: unknown): unknown {
  if (typeof output === "string") return parseMaybeJson(output)
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>
    if (typeof o.output === "string") return o.output
    if (typeof o.content === "string") return o.content
  }
  return output ?? ""
}

/**
 * Whether a Codex tool result signals failure. Codex records exec results as
 * `{ output, metadata: { exit_code } }` and other tools as `{ success, error }`;
 * a JSON-string output is unwrapped first. Non-error results fall through.
 */
function isCodexToolError(output: unknown): boolean {
  if (typeof output === "string") {
    try {
      return isCodexToolError(JSON.parse(output))
    } catch {
      return false
    }
  }
  if (!output || typeof output !== "object") return false
  const o = output as Record<string, unknown>
  if (o.success === false) return true
  if (typeof o.error === "string" && o.error) return true
  if (typeof o.exit_code === "number" && o.exit_code !== 0) return true
  const md = o.metadata as Record<string, unknown> | undefined
  if (md && typeof md.exit_code === "number" && md.exit_code !== 0) return true
  return false
}

/**
 * Cheap single-pass summary of a Codex rollout — pulls title, count, timestamps
 * and cwd WITHOUT building any `StoredMessage`. `messageCount` counts the
 * response items that would each emit a turn (message / reasoning / tool call /
 * compaction marker), mirroring the full parse closely enough for the row
 * subtitle while skipping all the allocation `parseCodexRollout` does.
 */
export function summarizeCodexFile(content: string, locator: string): SessionSummary | null {
  let sessionId = ""
  let cwd: string | undefined
  let firstUserText = ""
  let createdAt = 0
  let updatedAt = 0
  let count = 0
  let sourceVersion: string | undefined
  let relationKind: CanonicalSessionRelationKind | undefined
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: RolloutLine
    try {
      rec = JSON.parse(trimmed) as RolloutLine
    } catch {
      continue
    }
    if (rec.timestamp) {
      const ms = Date.parse(rec.timestamp)
      if (!Number.isNaN(ms)) {
        if (!createdAt) createdAt = ms
        if (ms > updatedAt) updatedAt = ms
      }
    }
    const payload = rec.payload ?? {}
    if (rec.type === "session_meta") {
      sessionId = asString(payload.id) || asString(payload.session_id) || sessionId
      cwd = asString(payload.cwd) || cwd
      sourceVersion = asString(payload.cli_version) || sourceVersion
      if (asString(payload.forked_from_id)) relationKind = "fork"
      else if (
        asString(payload.parent_thread_id) ||
        nestedString(payload.source, "parent_thread_id")
      ) {
        relationKind = "subagent"
      }
      continue
    }
    if (rec.type === "compacted") {
      count += 1
      continue
    }
    if (rec.type !== "response_item") continue
    const itemType = asString(payload.type)
    if (itemType === "message") {
      const text = messageText(payload)
      if (!text) continue
      count += 1
      if (asString(payload.role) !== "assistant" && !firstUserText) firstUserText = text
    } else if (
      itemType === "reasoning" ||
      itemType === "function_call" ||
      itemType === "custom_tool_call"
    ) {
      count += 1
    }
  }
  if (count === 0) return null
  return {
    ref: { sourceId: "codex", originalSessionId: sessionId || locator, locator },
    title: deriveTitle(firstUserText, "Codex session"),
    sourceId: "codex",
    messageCount: count,
    updatedAt: updatedAt || createdAt || Date.now(),
    cwd,
    sourceVersion: sourceVersion || codexSessionSource.verifiedVersion,
    relationKind,
  }
}

function toConversation(parsed: ParsedSession, projectId?: string): ImportedConversation {
  const id = importedSessionId("codex", parsed.originalSessionId)
  const session = buildSession({
    id,
    projectId,
    title: parsed.title,
    model: parsed.model,
    workingDir: parsed.cwd,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    seedMessages: parsed.messages,
    kind: parsed.relationKind === "subagent" ? "subagent" : "direct",
    suppressSeed: parsed.relationKind === "subagent",
  })
  session.importRuntimeBinding = {
    presetId: "codex",
    nativeSessionId: parsed.originalSessionId,
    cwd: parsed.cwd,
    resumeMethod: "cli",
    verifiedAt: codexSessionSource.verifiedAt,
  }
  if (parsed.relationKind && parsed.parentNativeSessionId) {
    session.parentSessionId = importedSessionId("codex", parsed.parentNativeSessionId)
    session.importRelation = {
      kind: parsed.relationKind,
      parentNativeSessionId: parsed.parentNativeSessionId,
    }
  }
  if (parsed.lifecycle) session.importLifecycle = parsed.lifecycle
  return { session, messages: parsed.messages }
}

async function readRolloutContent(ref: SessionRef, input: SessionScanInput): Promise<string> {
  if (input.pickedFiles?.length) {
    return input.pickedFiles.find((file) => file.path === ref.locator)?.content ?? ""
  }
  return input.fs.readTextFile(ref.locator)
}

async function scanCodexSummaries(input: SessionScanInput): Promise<SessionSummary[]> {
  return scanFileSummaries(
    input,
    codexSessionSource.scanRoots(input.home, input.roots),
    (name) => name.toLowerCase().endsWith(".jsonl"),
    summarizeCodexFile
  )
}

async function parseCodexArtifacts(input: SessionScanInput): Promise<ParsedSession[]> {
  const summaries = await scanCodexSummaries(input)
  const parsed: ParsedSession[] = []
  for (const summary of summaries) {
    const content = await readRolloutContent(summary.ref, input)
    parsed.push(parseCodexRollout(content, summary.ref.locator))
  }
  return parsed
}

function rootOf(selected: ParsedSession, byId: ReadonlyMap<string, ParsedSession>): ParsedSession {
  let current = selected
  const visited = new Set<string>()
  while (current.parentNativeSessionId && !visited.has(current.originalSessionId)) {
    visited.add(current.originalSessionId)
    const parent = byId.get(current.parentNativeSessionId)
    if (!parent) break
    current = parent
  }
  return current
}

function conversationTree(
  parsed: ParsedSession,
  children: ReadonlyMap<string, ParsedSession[]>,
  visited = new Set<string>()
): ImportedConversation {
  const conversation = toConversation(parsed)
  if (visited.has(parsed.originalSessionId)) return conversation
  visited.add(parsed.originalSessionId)
  const nested = (children.get(parsed.originalSessionId) ?? []).map((child) =>
    conversationTree(child, children, visited)
  )
  if (nested.length > 0) conversation.nested = nested
  return conversation
}

function enrichCodexGraph(
  graph: ReturnType<typeof buildImportedSessionGraph>,
  parsedById: ReadonlyMap<string, ParsedSession>
): void {
  for (const node of graph.nodes) {
    const nativeId = node.session.header.runtimeBinding?.nativeSessionId
    const parsed = nativeId ? parsedById.get(nativeId) : undefined
    if (!parsed) continue
    if (parsed.goals.length > 0) node.session.goals = parsed.goals
    if (parsed.plans.length > 0) node.session.plans = parsed.plans
    if (parsed.tasks.length > 0) node.session.tasks = parsed.tasks
    if (parsed.history.length > 0) node.session.history = parsed.history
    if (parsed.interAgentMessages.length > 0) {
      node.session.interAgentMessages = parsed.interAgentMessages
    }
    if (parsed.recordedEvents.length > 0) node.session.recordedEvents = parsed.recordedEvents
    node.loss.losses.push(...parsed.losses)
  }
}

import { codexCodec } from "@/lib/session-import/codecs/codex-codec"

export const codexSessionSource: AgentSessionSourceAdapter = {
  codec: codexCodec,
  id: "codex",
  displayName: "Codex CLI",
  labelKey: "codex",
  verifiedVersion: "0.150.1",
  verifiedAt: "2026-08-29",
  acceptedExtensions: ACCEPTED,

  // `$CODEX_HOME` relocates the whole tree; `roots` carries it (the renderer
  // can't read env vars — see `lib/agent-roots/`).
  scanRoots(home, roots) {
    const base = roots?.codexHome || (home ? joinPath(home, ".codex") : "")
    return base ? [joinPath(base, "sessions")] : []
  },

  detect(files: PickedSessionFile[]) {
    if (files.length === 0) return "no"
    const hinted = files.filter((f) => {
      const p = f.path.replace(/\\/g, "/")
      return p.includes(".codex/sessions") || /rollout-.*\.jsonl$/.test(f.name)
    })
    if (hinted.length > 0) return hinted.length === files.length ? "match" : "maybe"
    const looksCodex = files.some((f) => {
      const first = f.content.split("\n").find((l) => l.trim())
      if (!first) return false
      try {
        const rec = JSON.parse(first) as RolloutLine
        return rec.type === "session_meta" || (!!rec.type && !!rec.payload)
      } catch {
        return false
      }
    })
    return looksCodex ? "maybe" : "no"
  },

  summarizeFile: summarizeCodexFile,

  async listSessions(input: SessionScanInput) {
    const summaries = await scanCodexSummaries(input)
    const parsed = await Promise.all(
      summaries.map(async (summary) =>
        parseCodexRollout(await readRolloutContent(summary.ref, input), summary.ref.locator)
      )
    )
    const nativeIds = new Set(parsed.map((session) => session.originalSessionId))
    return summaries.filter(
      (_, index) =>
        !parsed[index].parentNativeSessionId || !nativeIds.has(parsed[index].parentNativeSessionId!)
    )
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    const content = await readRolloutContent(ref, input)
    return toConversation(parseCodexRollout(content, ref.locator))
  },
  async parseGraph(ref: SessionRef, input: SessionScanInput) {
    const selected = parseCodexRollout(await readRolloutContent(ref, input), ref.locator)
    const artifacts = await parseCodexArtifacts(input)
    if (!artifacts.some((item) => item.originalSessionId === selected.originalSessionId)) {
      artifacts.push(selected)
    }
    const parsedById = new Map(artifacts.map((item) => [item.originalSessionId, item]))
    const root = rootOf(selected, parsedById)
    const children = new Map<string, ParsedSession[]>()
    for (const item of artifacts) {
      if (!item.parentNativeSessionId || !parsedById.has(item.parentNativeSessionId)) continue
      const siblings = children.get(item.parentNativeSessionId) ?? []
      siblings.push(item)
      children.set(item.parentNativeSessionId, siblings)
    }
    const graph = buildImportedSessionGraph(conversationTree(root, children), {
      sourceRuntime: this.id,
      sourceVersion: root.sourceVersion || selected.sourceVersion || this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: this.codec?.importFidelity ?? "structured",
      codec: this.codec,
    })
    enrichCodexGraph(graph, parsedById)
    return graph
  },
}
