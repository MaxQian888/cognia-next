/**
 * Codex CLI session history reader (ADR-0217).
 *
 * On disk: `<codexHome>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Each
 * line is a `RolloutLine` = `{ timestamp, type, payload }` with `type` ∈
 * session_meta | response_item | event_msg | turn_context | compacted. The
 * conversation is rebuilt from `response_item` payloads:
 *
 *   message (role + content[input_text|output_text]) → text
 *   reasoning (summary/text)                          → reasoning
 *   function_call (name, arguments, call_id)          → tool (input)
 *   function_call_output (call_id, output)            → tool result
 *   custom_tool_call[_output]                         → tool + result
 *   ghost_snapshot                                    → bounded diagnostic
 *
 * Pure functions over file content: the host discovers the files, reads them
 * and maps the result into its own rows. This module loads no process,
 * transport or app-server code.
 */

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
} from "@cognia/agent-contracts/canonical-session"
import type {
  HistoryDetectVerdict,
  HistoryFormatInfo,
  HistoryMessage,
  HistoryPart,
  HistoryPickedFile,
  HistoryReaderHost,
  HistorySessionSummary,
  HistoryToolPart,
  HistoryUsage,
  ParsedHistorySession,
} from "@cognia/agent-contracts/history"
import {
  boundedDiagnostic,
  deriveTitle,
  historyFile,
  historyReasoning,
  historyText,
  historyTool,
  importedSessionId,
  stringifyToolResult,
} from "@cognia/agent-runtime-kit/history"
import { CODEX_SESSION_SOURCE_ID } from "./manifest"

/** The rollout format version this reader was last verified against. */
export const CODEX_HISTORY_FORMAT: HistoryFormatInfo = Object.freeze({
  sourceId: CODEX_SESSION_SOURCE_ID,
  verifiedVersion: "0.150.1",
  verifiedAt: "2026-08-29",
  acceptedExtensions: Object.freeze([".jsonl"]),
})

const FALLBACK_TITLE = "Codex session"

interface RolloutLine {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
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

function numOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function toUsage(u: CodexTokenUsage): HistoryUsage {
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
function codexTurnUsage(
  info: Record<string, unknown>,
  prev: CumulativeTokens
): HistoryUsage | null {
  const last = info.last_token_usage as CodexTokenUsage | undefined
  const total = info.total_token_usage as CodexTokenUsage | undefined
  if (last && (last.input_tokens || last.output_tokens || last.cached_input_tokens)) {
    return toUsage(last)
  }
  if (total) {
    const input = numOf(total.input_tokens)
    const output = numOf(total.output_tokens)
    const cacheRead = numOf(total.cached_input_tokens)
    const delta: HistoryUsage = {
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

function messageParts(payload: Record<string, unknown>): HistoryPart[] {
  const content = payload.content
  if (typeof content === "string") return content ? [historyText(content)] : []
  if (!Array.isArray(content)) return []
  const parts: HistoryPart[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const value = block as Record<string, unknown>
    if (typeof value.text === "string" && value.text) parts.push(historyText(value.text))
    const url = asString(value.image_url) || asString(value.audio_url)
    if (url) {
      parts.push(
        historyFile({
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

function parseRolloutLine(line: string): RolloutLine | null {
  try {
    return JSON.parse(line) as RolloutLine
  } catch {
    return null
  }
}

/** The session-meta facts both the parser and the summary read. */
function readSessionMeta(
  payload: Record<string, unknown>,
  into: {
    sessionId: string
    cwd?: string
    sourceVersion?: string
    relationKind?: CanonicalSessionRelationKind
    parentNativeSessionId?: string
  }
): void {
  into.sessionId = asString(payload.id) || asString(payload.session_id) || into.sessionId
  into.cwd = asString(payload.cwd) || into.cwd
  into.sourceVersion = asString(payload.cli_version) || into.sourceVersion
  const forkedFrom = asString(payload.forked_from_id)
  const parent =
    asString(payload.parent_thread_id) || nestedString(payload.source, "parent_thread_id")
  if (forkedFrom) {
    into.relationKind = "fork"
    into.parentNativeSessionId = forkedFrom
  } else if (parent) {
    into.relationKind = "subagent"
    into.parentNativeSessionId = parent
  }
}

/**
 * Parse one rollout file. `locator` names the file; it stands in for the
 * session id when the rollout records none.
 */
export function parseCodexRollout(
  content: string,
  locator: string,
  host: HistoryReaderHost
): ParsedHistorySession {
  const messages: HistoryMessage[] = []
  const toolIndex = new Map<string, { m: number; p: number }>()
  const meta: {
    sessionId: string
    cwd?: string
    sourceVersion?: string
    relationKind?: CanonicalSessionRelationKind
    parentNativeSessionId?: string
  } = { sessionId: "" }
  let model: string | undefined
  let firstUserText = ""
  let createdAt = 0
  let updatedAt = 0
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
  // so it is attached to the turn's last-seen assistant message.
  let lastAssistantIndex = -1
  const prevTotal: CumulativeTokens = { input: 0, output: 0, cacheRead: 0 }
  const diagnostic = (value: unknown) => boundedDiagnostic(value, host)
  const push = (message: HistoryMessage) => {
    messages.push(message)
    if (message.role === "assistant") lastAssistantIndex = messages.length - 1
    return messages.length - 1
  }
  const pushTool = (part: HistoryToolPart, createdAtMs: number) =>
    push({ role: "assistant", parts: [part], createdAt: createdAtMs })

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
      readSessionMeta(payload, meta)
      model = asString(payload.model) || asString(payload.model_provider) || model
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
            usage,
            ...(model ? { usageModel: model } : {}),
          }
        }
        recordedEvents.push({
          eventId: `codex-event-${eventSequence}`,
          sequence: eventSequence++,
          at: rec.timestamp,
          event: { kind: "usage", usage: diagnostic(info) as Record<string, unknown> },
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
          ...(error ? { error: JSON.stringify(diagnostic(error)) } : {}),
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
          const status = lifecycleStatus(payload.status)
          goals.splice(0, goals.length, {
            goalId: asString(payload.goal_id) || "goal-1",
            description,
            status:
              status === "completed"
                ? "completed"
                : status === "cancelled"
                  ? "cancelled"
                  : status === "failed"
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
            ? `canon:${CODEX_SESSION_SOURCE_ID}:${importedSessionId(
                CODEX_SESSION_SOURCE_ID,
                asString(payload.new_thread_id)
              )}`
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
        if (text) push({ role: "system", parts: [historyText(text)], createdAt: ms })
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
            payload: { type: eventType, summary: diagnostic(payload) },
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
    // Context-compaction boundary: a system marker keeps the compacted
    // history visible in the imported transcript.
    if (rec.type === "compacted") {
      const note = messageText(payload) || asString(payload.message) || "Context compacted"
      push({ role: "system", parts: [historyText(note)], createdAt: ms })
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
          payload: { type: rec.type || "unknown", summary: diagnostic(payload) },
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
          payload: { type: itemType, summary: diagnostic(payload) },
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
      const author = asString(payload.author) || meta.sessionId || "agent"
      const recipient = asString(payload.recipient) || undefined
      interAgentMessages.push({
        messageId: asString(payload.id) || `agent-message-${interAgentMessages.length + 1}`,
        fromSessionId: author,
        toSessionId: recipient,
        text,
        at: rec.timestamp,
      })
      push({
        role: "system",
        parts: [historyText(text)],
        createdAt: ms,
        annotations: { codexAgentMessage: { author, recipient } },
      })
      continue
    }

    if (itemType === "message") {
      const role = asString(payload.role) === "assistant" ? "assistant" : "user"
      const text = messageText(payload)
      const contentParts = messageParts(payload)
      if (contentParts.length === 0) continue
      if (role === "user" && !firstUserText) firstUserText = text
      const commentary =
        role === "assistant" && asString(payload.phase) === "commentary"
          ? ({
              type: "commentary",
              text,
              ...(asString(payload.id) ? { messageId: asString(payload.id) } : {}),
              source: "codex",
            } satisfies HistoryPart)
          : undefined
      push({ role, parts: commentary ? [commentary] : contentParts, createdAt: ms })
      continue
    }

    if (itemType === "reasoning") {
      const text = reasoningText(payload)
      if (!text) continue
      push({ role: "assistant", parts: [historyReasoning(text)], createdAt: ms })
      continue
    }

    if (itemType === "local_shell_call") {
      const callId = asString(payload.call_id) || asString(payload.id) || `shell-${messages.length}`
      const index = pushTool(
        historyTool({
          name: "local_shell",
          toolCallId: callId,
          input:
            payload.action && typeof payload.action === "object"
              ? (payload.action as Record<string, unknown>)
              : { action: payload.action },
          status: asString(payload.status) || "running",
        }),
        ms
      )
      toolIndex.set(callId, { m: index, p: 0 })
      continue
    }

    if (itemType === "web_search_call") {
      const callId = asString(payload.id) || `web-${messages.length}`
      pushTool(
        historyTool({
          name: "web_search",
          toolCallId: callId,
          input:
            payload.action && typeof payload.action === "object"
              ? (payload.action as Record<string, unknown>)
              : {},
          ...(asString(payload.status) === "completed"
            ? { result: { ok: true as const, output: { status: "completed" } } }
            : {}),
          status: asString(payload.status) || "running",
        }),
        ms
      )
      continue
    }

    if (itemType === "image_generation_call") {
      const callId = asString(payload.id) || `image-${messages.length}`
      const result = asString(payload.result)
      const output = { base64: result, status: asString(payload.status) }
      pushTool(
        historyTool({
          name: "image_generation",
          toolCallId: callId,
          input: { revisedPrompt: asString(payload.revised_prompt) || undefined },
          ...(result
            ? {
                result:
                  asString(payload.status) === "failed"
                    ? { ok: false as const, errorText: stringifyToolResult(output) }
                    : { ok: true as const, output },
              }
            : {}),
          status: asString(payload.status) || "completed",
        }),
        ms
      )
      continue
    }

    if (itemType === "tool_search_call") {
      const callId =
        asString(payload.call_id) || asString(payload.id) || `tool-search-${messages.length}`
      const index = pushTool(
        historyTool({
          name: "tool_search",
          toolCallId: callId,
          input:
            payload.arguments && typeof payload.arguments === "object"
              ? (payload.arguments as Record<string, unknown>)
              : { arguments: payload.arguments },
          status: asString(payload.status) || "running",
        }),
        ms
      )
      toolIndex.set(callId, { m: index, p: 0 })
      continue
    }

    if (itemType === "tool_search_output") {
      const callId = asString(payload.call_id) || asString(payload.id)
      const loc = callId ? toolIndex.get(callId) : undefined
      const part = loc ? messages[loc.m]?.parts[loc.p] : undefined
      if (loc && part?.type === "tool") {
        const failed = asString(payload.status) === "failed"
        messages[loc.m].parts[loc.p] = {
          ...part,
          result: failed
            ? { ok: false, errorText: JSON.stringify(payload.tools ?? []) }
            : { ok: true, output: payload.tools ?? [] },
          status: asString(payload.status),
        }
      }
      continue
    }

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callId = asString(payload.call_id) || asString(payload.id) || `call-${messages.length}`
      const name = asString(payload.name) || "tool"
      const input = parseMaybeJson(payload.arguments ?? payload.input)
      const index = pushTool(historyTool({ name, toolCallId: callId, input }), ms)
      toolIndex.set(callId, { m: index, p: 0 })
      continue
    }

    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const callId = asString(payload.call_id) || asString(payload.id)
      const loc = callId ? toolIndex.get(callId) : undefined
      if (!loc) continue
      const part = messages[loc.m]?.parts[loc.p]
      if (part?.type !== "tool") continue
      const output = extractOutput(payload.output)
      messages[loc.m].parts[loc.p] = {
        ...part,
        result: isCodexToolError(payload.output)
          ? { ok: false, errorText: typeof output === "string" ? output : JSON.stringify(output) }
          : { ok: true, output },
      }
      continue
    }

    recordedEvents.push({
      eventId: `codex-event-${eventSequence}`,
      sequence: eventSequence++,
      at: rec.timestamp,
      event: {
        kind: "diagnostic",
        runtime: "codex",
        payload: { type: itemType || "unknown", summary: diagnostic(payload) },
      },
    })
    losses.push({
      path: `response_item.${itemType || "unknown"}`,
      kind: "approximated",
      detail: "Unknown Codex response item retained as a bounded redacted diagnostic.",
    })
  }

  const now = Date.now()
  return {
    sourceId: CODEX_SESSION_SOURCE_ID,
    originalSessionId: meta.sessionId || locator,
    cwd: meta.cwd,
    model,
    title: deriveTitle(firstUserText, FALLBACK_TITLE),
    messages,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
    sourceVersion: meta.sourceVersion,
    relationKind: meta.relationKind,
    parentNativeSessionId: meta.parentNativeSessionId,
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

/** First valid `timestamp` on a head/tail line; rollouts append in order. */
function edgeTimestamp(lines: string[], fromEnd: boolean): number {
  for (let i = 0; i < lines.length; i++) {
    const rec = parseRolloutLine(lines[fromEnd ? lines.length - 1 - i : i])
    if (!rec?.timestamp) continue
    const ms = Date.parse(rec.timestamp)
    if (!Number.isNaN(ms)) return ms
  }
  return 0
}

/**
 * Cheap single-pass summary of a rollout: title, count, timestamps and cwd
 * without building any transcript. `messageCount` counts the response items
 * that would each emit a turn (message / reasoning / tool call / compaction
 * marker), close enough to the full parse for a picker row.
 *
 * Two-tier scan: `"type":"…"` substring markers count and collect the handful
 * of lines the summary actually reads, so only ~5 records per file are
 * JSON-parsed instead of every line. On a multi-GB corpus that is the
 * difference between a scan dominated by JSON.parse and one dominated by
 * substring search. Files the markers cannot see (spaced or non-rollout JSON)
 * fall back to the per-line parse, so nothing is silently mis-summarised.
 */
export function summarizeCodexRollout(
  content: string,
  locator: string
): HistorySessionSummary | null {
  const lines = content.split("\n")
  // A marker absent from the whole file can never match a line, so its
  // per-line scan is skipped entirely.
  const hasMeta = content.includes('"type":"session_meta"')
  const hasCompacted = content.includes('"type":"compacted"')
  const metaLines: string[] = []
  const messageLines: string[] = []
  const head: string[] = []
  const tail: string[] = []
  let count = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (head.length < 4) head.push(line)
    tail.push(line)
    if (tail.length > 4) tail.shift()
    // A `compacted` record embeds whole message objects inside
    // `replacement_history`, so it must win over the response_item checks.
    if (hasMeta && line.includes('"type":"session_meta"')) {
      metaLines.push(line)
      continue
    }
    if (hasCompacted && line.includes('"type":"compacted"')) {
      count += 1
      continue
    }
    if (!line.includes('"type":"response_item"')) continue
    if (line.includes('"type":"message"')) {
      count += 1
      messageLines.push(line)
    } else if (
      line.includes('"type":"reasoning"') ||
      line.includes('"type":"function_call"') ||
      line.includes('"type":"custom_tool_call"')
    ) {
      count += 1
    }
  }
  if (count === 0) return summarizeCodexRolloutSlow(lines, locator)

  const meta: Parameters<typeof readSessionMeta>[1] = { sessionId: "" }
  for (const line of metaLines) readSessionMeta(parseRolloutLine(line)?.payload ?? {}, meta)
  let firstUserText = ""
  for (const line of messageLines) {
    const payload = parseRolloutLine(line)?.payload ?? {}
    if (asString(payload.role) === "assistant") continue
    const text = messageText(payload)
    if (text) {
      firstUserText = text
      break
    }
  }
  const createdAt = edgeTimestamp(head, false)
  const updatedAt = edgeTimestamp(tail, true)
  return summaryOf(meta, locator, firstUserText, count, updatedAt || createdAt || Date.now())
}

/**
 * Per-line JSON.parse fallback for files the marker scan reads as empty:
 * spaced or otherwise non-compact serialisation the `"type":"…"` substrings
 * cannot see. Runs only when the fast path counted nothing.
 */
function summarizeCodexRolloutSlow(lines: string[], locator: string): HistorySessionSummary | null {
  const meta: Parameters<typeof readSessionMeta>[1] = { sessionId: "" }
  let firstUserText = ""
  let createdAt = 0
  let updatedAt = 0
  let count = 0
  for (const line of lines) {
    const rec = parseRolloutLine(line.trim())
    if (!rec) continue
    if (rec.timestamp) {
      const ms = Date.parse(rec.timestamp)
      if (!Number.isNaN(ms)) {
        if (!createdAt) createdAt = ms
        if (ms > updatedAt) updatedAt = ms
      }
    }
    const payload = rec.payload ?? {}
    if (rec.type === "session_meta") {
      readSessionMeta(payload, meta)
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
  return summaryOf(meta, locator, firstUserText, count, updatedAt || createdAt || Date.now())
}

function summaryOf(
  meta: Parameters<typeof readSessionMeta>[1],
  locator: string,
  firstUserText: string,
  messageCount: number,
  updatedAt: number
): HistorySessionSummary {
  return {
    sourceId: CODEX_SESSION_SOURCE_ID,
    originalSessionId: meta.sessionId || locator,
    title: deriveTitle(firstUserText, FALLBACK_TITLE),
    messageCount,
    updatedAt,
    cwd: meta.cwd,
    sourceVersion: meta.sourceVersion || CODEX_HISTORY_FORMAT.verifiedVersion,
    relationKind: meta.relationKind,
    ...(meta.parentNativeSessionId ? { parentNativeSessionId: meta.parentNativeSessionId } : {}),
  }
}

/** True for a file name the rollout format uses. */
export function isCodexRolloutFileName(name: string): boolean {
  return name.toLowerCase().endsWith(".jsonl")
}

/** How likely a batch of picked files is a set of Codex rollouts. */
export function detectCodexRollouts(files: readonly HistoryPickedFile[]): HistoryDetectVerdict {
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
}
