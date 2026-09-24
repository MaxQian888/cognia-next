import type { ExternalAgentEvent, ExternalAgentTokenUsage } from "@/types/agent/external-agent"

/** Current @deepseek-ai/dsh-session 0.1.5-rc.1 vocabulary (session format 3).
 * The SDK publishes durable settlements, not the removed assistant/chunk wire.
 * Plugin records without a canonical presentation remain observable as progress.
 */
const KNOWN_EVENT_TYPES = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/attempt",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "deliverables/presented",
  "feedback/message-delete",
  "feedback/message-put",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "model/selection",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session-log-deepseek/delivery-accepted",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/catalog",
  "subagent/descriptor",
  "subagent/model-selection-policy",
  "system/message",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/call",
  "tool/ptc-dispatch",
  "tool/ptc-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request",
])

export interface DshSessionEventNotification {
  method: "session.event"
  params: {
    sessionId: string
    event: {
      type: string
      seq: number
      time: number
      data: unknown
      ignorable?: true
      surfaceOp?: unknown
    }
  }
}
export interface DshSessionStatusNotification {
  method: "session.status"
  params: { sessionId: string; status: "running" | "idle" }
}
export interface DshSubagentStartedNotification {
  method: "subagent.started"
  params: { parentSessionId: string; childSessionId: string }
}
export interface DshSubagentFinishedNotification {
  method: "subagent.finished"
  params: {
    parentSessionId: string
    childSessionId: string
    provider: string
    agentId: string
    status: "ok" | "error"
    stopReason: string
    lastAssistantMessage?: unknown[]
  }
}
export type DshNotification =
  | DshSessionEventNotification
  | DshSessionStatusNotification
  | DshSubagentStartedNotification
  | DshSubagentFinishedNotification

export class DshVersionDriftError extends Error {
  constructor(readonly eventType: string) {
    super(
      `DeepSeek Harness emitted an unrecognized required event "${eventType}". Reinstall the current runtime channel; only session format 3 is supported.`
    )
    this.name = "DshVersionDriftError"
  }
}
export interface DshCodecWarning {
  kind: "ignorable-unknown-event" | "malformed-payload"
  detail: string
}
export interface DshCodecResult {
  events: ExternalAgentEvent[]
  warnings: DshCodecWarning[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Input counters are disjoint in v3: cache tokens contribute to prompt totals. */
function mapUsage(raw: unknown): ExternalAgentTokenUsage | undefined {
  if (!record(raw)) return undefined
  const cacheReadTokens = number(raw.cacheReadTokens) ?? 0
  const cacheWriteTokens = number(raw.cacheWriteTokens) ?? 0
  const promptTokens = (number(raw.inputTokens) ?? 0) + cacheReadTokens + cacheWriteTokens
  const completionTokens = number(raw.outputTokens) ?? 0
  return {
    promptTokens,
    completionTokens,
    totalTokens: number(raw.totalTokens) ?? promptTokens + completionTokens,
    ...(raw.cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(raw.cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(raw.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: number(raw.reasoningTokens) ?? 0 }),
  }
}

/** Translate only the current published SDK notifications. Malformed required content fails closed. */
export function translateDshNotification(notification: unknown): DshCodecResult {
  const events: ExternalAgentEvent[] = []
  const warnings: DshCodecWarning[] = []
  if (!record(notification) || !record(notification.params))
    throw new TypeError("DeepSeek Harness notification requires params")
  const params = notification.params
  const method = string(notification.method)
  const sessionId = string(
    method?.startsWith("subagent.") ? params.parentSessionId : params.sessionId
  )
  if (!sessionId) throw new TypeError("DeepSeek Harness notification requires a session identity")
  const event = record(params.event) ? params.event : undefined
  const timestamp = new Date(number(event?.time) ?? Date.now())
  const base = { sessionId, timestamp }
  const progress = (message: string, complete = false) =>
    events.push({ type: "progress", ...base, progress: complete ? 1 : 0, message })
  if (method === "session.status") {
    if (params.status !== "idle" && params.status !== "running")
      throw new TypeError("Invalid DeepSeek Harness session status")
    // Idle is only a boundary; the adapter requires a matching admitted prompt
    // and a turn/end verdict before completing. Idle itself never means success.
    return { events, warnings }
  }
  if (method === "subagent.started" || method === "subagent.finished") {
    if (!string(params.childSessionId))
      throw new TypeError("DeepSeek Harness subagent notification requires childSessionId")
    const { lastAssistantMessage: _output, ...lineage } = params
    progress(`${method}:${JSON.stringify(lineage)}`, method === "subagent.finished")
    return { events, warnings }
  }
  if (method !== "session.event") throw new DshVersionDriftError(method ?? "(missing method)")
  if (!event || !record(event.data))
    throw new TypeError("DeepSeek Harness session event requires data")
  const eventType = string(event.type) ?? ""
  const data = event.data
  if (!KNOWN_EVENT_TYPES.has(eventType)) {
    if (event.ignorable === true) {
      warnings.push({ kind: "ignorable-unknown-event", detail: eventType })
      return { events, warnings }
    }
    throw new DshVersionDriftError(eventType)
  }
  switch (eventType) {
    case "turn/start":
      events.push({ type: "session_start", ...base })
      break
    case "turn/end": {
      const reason = record(data.reason) ? data.reason : {}
      const kind = string(reason.kind)
      if (kind === "error") {
        const failure = record(reason.error) ? reason.error : {}
        events.push({
          type: "error",
          ...base,
          error: string(failure.message) ?? "DeepSeek Harness turn failed",
          code: string(failure.code),
          recoverable: false,
        })
      } else if (
        !["completed", "aborted", "interrupted", "blocked", "max-tokens"].includes(kind ?? "")
      ) {
        throw new DshVersionDriftError(`turn/end:${kind ?? "(missing reason)"}`)
      }
      events.push({
        type: "done",
        ...base,
        success: kind === "completed",
        ...(kind === "completed"
          ? { stopReason: "end_turn" as const }
          : kind === "aborted" || kind === "interrupted"
            ? { stopReason: "cancelled" as const }
            : kind === "blocked"
              ? { stopReason: "refusal" as const }
              : kind === "max-tokens"
                ? { stopReason: "max_tokens" as const }
                : {}),
      })
      break
    }
    case "assistant/message": {
      const message = record(data.message) ? data.message : undefined
      if (!message || !Array.isArray(message.content))
        throw new TypeError("DeepSeek Harness assistant/message requires content")
      const messageId = string(message.id)
      events.push({ type: "message_start", ...base, messageId, role: "assistant" })
      for (const block of message.content) {
        if (!record(block)) throw new TypeError("Invalid DeepSeek Harness content block")
        if (block.type === "text" && typeof block.text === "string")
          events.push({
            type: "message_delta",
            ...base,
            messageId,
            delta: { type: "text", text: block.text },
          })
        else if (block.type === "reasoning" && typeof block.text === "string")
          events.push({ type: "thinking", ...base, thinking: block.text })
        // tool/call owns invocation presentation and arguments; showing the
        // committed tool-call block too would execute/display it twice.
        else if (block.type === "tool-call") continue
        else if (block.type === "image" || block.type === "file")
          progress(`assistant/content:${JSON.stringify(block)}`)
        else throw new DshVersionDriftError(`assistant/content:${string(block.type) ?? "unknown"}`)
      }
      events.push({ type: "message_end", ...base, messageId, tokenUsage: mapUsage(data.usage) })
      break
    }
    case "assistant/attempt": {
      // Failed attempts never enter the final assistant answer. Reasoning must
      // use the governed thinking channel, never a generic progress message.
      if (!Array.isArray(data.stream))
        throw new TypeError("DeepSeek Harness assistant/attempt requires stream")
      for (const entry of data.stream) {
        if (!record(entry)) throw new TypeError("Invalid DeepSeek Harness assistant stream record")
        if (entry.type === "reasoning-chunks" && Array.isArray(entry.texts)) {
          events.push({ type: "thinking", ...base, thinking: entry.texts.join("") })
        } else if (entry.type === "text-chunks" && Array.isArray(entry.texts)) {
          progress(`assistant/attempt:${entry.texts.join("")}`)
        } else if (entry.type === "tool-call-chunks") {
          progress(`assistant/attempt:tool-call:${string(entry.name) ?? string(entry.id) ?? ""}`)
        } else if (entry.type === "chunk" && record(entry.chunk)) {
          const chunk = entry.chunk
          if (chunk.type === "block-end" && record(chunk.block) && chunk.block.type === "reasoning")
            continue
          if (chunk.type === "usage") {
            events.push({ type: "message_end", ...base, tokenUsage: mapUsage(chunk.usage) })
          } else if (chunk.type === "finish") {
            const reason = record(chunk.reason) ? chunk.reason : {}
            const failure = record(reason.failure) ? reason.failure : {}
            progress(
              `assistant/attempt:${string(reason.kind) ?? "unknown"}:${string(failure.message) ?? ""}`
            )
          }
        } else
          throw new DshVersionDriftError(`assistant/attempt:${string(entry.type) ?? "unknown"}`)
      }
      break
    }
    case "tool/call": {
      const toolUseId = string(data.callId)
      const toolName = string(data.name)
      if (!toolUseId || !toolName || typeof data.arguments !== "string")
        throw new TypeError("DeepSeek Harness tool/call requires callId, name and arguments")
      let rawInput: Record<string, unknown> | undefined
      try {
        const parsed: unknown = JSON.parse(data.arguments)
        if (record(parsed)) rawInput = parsed
      } catch {
        warnings.push({
          kind: "malformed-payload",
          detail: `tool/call ${toolName}: unparsable arguments`,
        })
      }
      events.push({ type: "tool_use_start", ...base, toolUseId, toolName, rawInput })
      events.push({ type: "tool_use_delta", ...base, toolUseId, delta: data.arguments })
      if (rawInput) events.push({ type: "tool_use_end", ...base, toolUseId, input: rawInput })
      break
    }
    case "tool/result": {
      const message = record(data.message) ? data.message : undefined
      const source = record(message?.source) ? message.source : undefined
      const block =
        Array.isArray(message?.content) && record(message.content[0])
          ? message.content[0]
          : undefined
      const toolUseId = string(source?.callId)
      if (
        !toolUseId ||
        block?.type !== "tool-result" ||
        block.toolCallId !== toolUseId ||
        !Array.isArray(block.content)
      )
        throw new TypeError(
          "DeepSeek Harness tool/result requires matching tool call identity and content"
        )
      const textOnly = block.content.every(
        (part: unknown) => record(part) && part.type === "text" && typeof part.text === "string"
      )
      const result = textOnly
        ? block.content.map((part: { text: string }) => part.text).join("")
        : { content: block.content }
      events.push({
        type: "tool_result",
        ...base,
        toolUseId,
        result,
        isError: block.isError === true,
        rawOutput: {
          content: block.content,
          ...(data.meta === undefined ? {} : { meta: data.meta }),
          ...(data.error === undefined ? {} : { error: data.error }),
        },
      })
      break
    }
    case "session/title":
      if (typeof data.title !== "string")
        throw new TypeError("DeepSeek Harness session/title requires title")
      events.push({ type: "session_info_update", ...base, title: data.title })
      break
    case "step/start":
    case "step/end":
    case "session/end-seed":
      break
    case "request/header":
    case "request/context":
    case "system/message":
    case "user/message":
    case "agent/inbox/spliced":
      // Input/provenance records do not become assistant output. In particular,
      // a request header can contain replay reasoning and full tool schemas;
      // exposing it through progress would bypass reasoning disclosure policy.
      break
    default:
      // Preserve plugin activity without surfacing opaque private payloads as
      // UI text or accidentally treating a logged approval as an actionable one.
      progress(eventType)
  }
  return { events, warnings }
}

export function translateDshNotifications(notifications: readonly unknown[]): DshCodecResult {
  const events: ExternalAgentEvent[] = []
  const warnings: DshCodecWarning[] = []
  for (const notification of notifications) {
    const result = translateDshNotification(notification)
    events.push(...result.events)
    warnings.push(...result.warnings)
  }
  return { events, warnings }
}
export function dshEventDedupeKey(channelId: string, sessionId: string, seq: number): string {
  return `${channelId}\0${sessionId}\0${seq}`
}
