import type { ExternalAgentEvent, ExternalAgentTokenUsage } from "@/types/agent/external-agent"

/**
 * One-way codec from DeepSeek Harness SDK wire notifications to Cognia's
 * `ExternalAgentEvent` vocabulary.
 *
 * Deliberately one-way. Cognia's UI, persistence, CLI, and Fleet read canonical
 * events only; the raw DSH payload is a diagnostic attachment, never a data
 * source. Emitting DSH-shaped events back out would create a second vocabulary
 * with no owner.
 *
 * Downstream, `canonicalEventFromExternalEvent()` in
 * `lib/ai/agent/execution/event-envelope.ts` carries these into canonical
 * envelopes, and `createEnvelopeOrderTracker()` there already implements
 * at-least-once dedupe and gap detection — this module deliberately does not
 * reimplement either.
 *
 * The wire shapes below were confirmed against upstream's own recorded
 * regression snapshots and against a live run of Cognia's
 * `runtime/deepseek-harness/host.sdk-readonly.yml`.
 */

/** `{"method":"session.event","params":{sessionId,event:{type,seq,time,data}}}` */
export interface DshSessionEventNotification {
  method: "session.event"
  params: {
    sessionId: string
    event: {
      type: string
      seq: number
      time?: number
      data?: unknown
      surfaceOp?: string
    }
  }
}

/** `{"method":"session.status","params":{sessionId,status}}` */
export interface DshSessionStatusNotification {
  method: "session.status"
  params: { sessionId: string; status: "running" | "idle" }
}

export interface DshSubagentStartedNotification {
  method: "subagent.started"
  params: { sessionId: string; parentSessionId?: string; childSessionId?: string }
}

export interface DshSubagentFinishedNotification {
  method: "subagent.finished"
  params: {
    sessionId: string
    childSessionId?: string
    stopReason?: string
    lastAssistantMessage?: unknown
  }
}

export type DshNotification =
  | DshSessionEventNotification
  | DshSessionStatusNotification
  | DshSubagentStartedNotification
  | DshSubagentFinishedNotification

/**
 * DSH event types Cognia must understand.
 *
 * An unrecognized type that is NOT marked `ignorable` on the wire is treated as
 * a version-drift failure rather than being silently dropped: upstream's
 * `SESSION_FORMAT_VERSION` is `0` with no compatibility promise, so a new
 * required event means the installed channel no longer matches this codec.
 */
const KNOWN_EVENT_TYPES = new Set([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "assistant/chunk",
  "assistant/message",
  "tool/call",
  "tool/result",
  "request/header",
  "request/context",
  "session/title",
  "agent/inbox/spliced",
])

/** `assistant/chunk` sub-vocabulary, observed on the wire. */
const KNOWN_CHUNK_TYPES = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-call-delta",
  "block-start",
  "block-end",
  "usage",
  "finish",
])

export class DshVersionDriftError extends Error {
  readonly eventType: string
  constructor(eventType: string) {
    super(
      `DeepSeek Harness emitted an unrecognized required event "${eventType}". ` +
        "The installed runtime channel does not match this codec; upstream makes " +
        "no session-format compatibility promise. Reinstall or upgrade the channel."
    )
    this.name = "DshVersionDriftError"
    this.eventType = eventType
  }
}

/** A non-fatal translation note, surfaced as a bounded diagnostic. */
export interface DshCodecWarning {
  kind: "ignorable-unknown-event" | "unknown-chunk-type" | "malformed-payload"
  detail: string
}

export interface DshCodecResult {
  events: ExternalAgentEvent[]
  warnings: DshCodecWarning[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * DSH reports `{inputTokens, outputTokens, cacheReadTokens, reasoningTokens}`
 * per step. Cognia's shape wants an explicit total, which DSH does not send.
 *
 * `totalTokens` is input + output only. Cache reads are not new tokens billed
 * against the turn, and reasoning tokens are already counted inside
 * `outputTokens`; adding either would inflate every total.
 */
function mapUsage(raw: unknown): ExternalAgentTokenUsage | undefined {
  if (!isRecord(raw)) return undefined
  const promptTokens = asNumber(raw.inputTokens) ?? 0
  const completionTokens = asNumber(raw.outputTokens) ?? 0
  const usage: ExternalAgentTokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  }
  const cacheReadTokens = asNumber(raw.cacheReadTokens)
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  const reasoningTokens = asNumber(raw.reasoningTokens)
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
  return usage
}

/**
 * DSH `turn/end` reasons -> Cognia stop reasons.
 *
 * Anything unmapped becomes `"error"` rather than a success: an unrecognized
 * terminal reason is not evidence the turn completed.
 */
function mapTurnEndReason(kind: string | undefined): {
  success: boolean
  stopReason: "end_turn" | "max_tokens" | "cancelled" | "refusal" | undefined
} {
  switch (kind) {
    case "completed":
      return { success: true, stopReason: "end_turn" }
    case "max-tokens":
      return { success: false, stopReason: "max_tokens" }
    case "aborted":
    case "interrupted":
      return { success: false, stopReason: "cancelled" }
    case "blocked":
      return { success: false, stopReason: "refusal" }
    default:
      return { success: false, stopReason: undefined }
  }
}

/** Extract plain text from a DSH content-block array. */
function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("")
}

function translateChunk(
  data: Record<string, unknown>,
  sessionId: string,
  timestamp: Date,
  out: ExternalAgentEvent[],
  warnings: DshCodecWarning[]
): void {
  const chunk = data.chunk
  if (!isRecord(chunk)) {
    warnings.push({ kind: "malformed-payload", detail: "assistant/chunk without a chunk object" })
    return
  }
  const chunkType = asString(chunk.type)
  if (chunkType && !KNOWN_CHUNK_TYPES.has(chunkType)) {
    // A new chunk kind is additive presentation detail, not a protocol break:
    // the committed `assistant/message` still carries the full content.
    warnings.push({ kind: "unknown-chunk-type", detail: chunkType })
    return
  }

  switch (chunkType) {
    case "text-delta": {
      const text = asString(chunk.text) ?? asString(chunk.delta) ?? ""
      if (text) {
        out.push({
          type: "message_delta",
          sessionId,
          timestamp,
          delta: { type: "text", text },
        })
      }
      return
    }
    case "reasoning-delta": {
      const text = asString(chunk.text) ?? asString(chunk.delta) ?? ""
      if (text) {
        // `thinking`, not `commentary_delta`: this is model reasoning and stays
        // governed by the reasoning disclosure policy.
        out.push({ type: "thinking", sessionId, timestamp, thinking: text })
      }
      return
    }
    case "tool-call-delta": {
      const toolUseId = asString(chunk.id) ?? asString(chunk.toolCallId)
      const delta = asString(chunk.delta) ?? asString(chunk.arguments) ?? ""
      // Without a call id the delta cannot be attributed; the committed
      // `tool/call` event carries the complete arguments regardless.
      if (toolUseId && delta) {
        out.push({ type: "tool_use_delta", sessionId, timestamp, toolUseId, delta })
      }
      return
    }
    case "usage": {
      const usage = mapUsage(chunk.usage)
      if (usage) {
        out.push({
          type: "usage_update",
          sessionId,
          timestamp,
          used: usage.totalTokens,
          size: usage.totalTokens,
        })
      }
      return
    }
    // `block-start` / `block-end` / `finish` are stream framing. Cognia derives
    // block structure from the committed message, so they carry no extra fact.
    default:
      return
  }
}

/**
 * Translate one DSH notification.
 *
 * @throws {DshVersionDriftError} when a required event type is unrecognized.
 */
export function translateDshNotification(notification: unknown): DshCodecResult {
  const events: ExternalAgentEvent[] = []
  const warnings: DshCodecWarning[] = []

  if (!isRecord(notification) || !isRecord(notification.params)) {
    warnings.push({ kind: "malformed-payload", detail: "notification without params" })
    return { events, warnings }
  }

  const method = asString(notification.method)
  const params = notification.params
  const sessionId = asString(params.sessionId) ?? ""
  const timestamp = new Date()

  if (method === "session.status") {
    // running -> idle is the only reliable turn boundary on this transport:
    // `session/prompt` returns an inbox-admission receipt, never a turn result.
    if (params.status === "idle") {
      events.push({ type: "done", sessionId, timestamp, success: true })
    }
    return { events, warnings }
  }

  if (method === "subagent.started") {
    events.push({
      type: "progress",
      sessionId,
      timestamp,
      progress: 0,
      message: `subagent:started:${asString(params.childSessionId) ?? "unknown"}`,
    })
    return { events, warnings }
  }

  if (method === "subagent.finished") {
    events.push({
      type: "progress",
      sessionId,
      timestamp,
      progress: 1,
      message: `subagent:finished:${asString(params.childSessionId) ?? "unknown"}`,
    })
    return { events, warnings }
  }

  if (method !== "session.event") {
    warnings.push({ kind: "malformed-payload", detail: `unknown method ${method ?? "(none)"}` })
    return { events, warnings }
  }

  const event = params.event
  if (!isRecord(event)) {
    warnings.push({ kind: "malformed-payload", detail: "session.event without an event object" })
    return { events, warnings }
  }

  const eventType = asString(event.type) ?? ""
  const data = isRecord(event.data) ? event.data : {}

  if (!KNOWN_EVENT_TYPES.has(eventType)) {
    if (event.ignorable === true || data.ignorable === true) {
      warnings.push({ kind: "ignorable-unknown-event", detail: eventType })
      return { events, warnings }
    }
    throw new DshVersionDriftError(eventType)
  }

  switch (eventType) {
    case "turn/start":
      events.push({ type: "session_start", sessionId, timestamp })
      break

    case "turn/end": {
      const reason = isRecord(data.reason) ? asString(data.reason.kind) : undefined
      const { success, stopReason } = mapTurnEndReason(reason)
      // Omit the key entirely when the reason is unrecognized. Spreading an
      // explicit `undefined` would still create `stopReason`, so a consumer
      // checking whether the runtime reported one could not tell "no reason
      // given" from "reason present". `success: false` already carries the
      // verdict; an unrecognized terminal reason is not evidence of completion.
      events.push({
        type: "done",
        sessionId,
        timestamp,
        success,
        ...(stopReason ? { stopReason } : {}),
      })
      break
    }

    case "step/start":
      events.push({ type: "message_start", sessionId, timestamp, role: "assistant" })
      break

    case "step/end":
      events.push({ type: "message_end", sessionId, timestamp })
      break

    case "user/message":
      // Logged for transcript fidelity; Cognia already knows what it sent, but
      // DSH also splices context the caller never wrote.
      break

    case "assistant/chunk":
      translateChunk(data, sessionId, timestamp, events, warnings)
      break

    case "assistant/message": {
      const message = isRecord(data.message) ? data.message : undefined
      if (!message) {
        warnings.push({ kind: "malformed-payload", detail: "assistant/message without message" })
        break
      }
      // Committed content. Deltas above are presentation; this is the fact.
      const content = Array.isArray(message.content) ? message.content : []
      for (const block of content) {
        if (!isRecord(block)) continue
        if (block.type === "tool-call") {
          const toolUseId = asString(block.id)
          const toolName = asString(block.name)
          if (toolUseId && toolName) {
            events.push({
              type: "tool_use_start",
              sessionId,
              timestamp,
              toolUseId,
              toolName,
            })
          }
        }
      }
      break
    }

    case "tool/call": {
      const toolUseId = asString(data.callId)
      const toolName = asString(data.name)
      if (!toolUseId || !toolName) {
        warnings.push({ kind: "malformed-payload", detail: "tool/call missing callId or name" })
        break
      }
      let rawInput: Record<string, unknown> | undefined
      const args = data.arguments
      if (typeof args === "string") {
        try {
          const parsed: unknown = JSON.parse(args)
          if (isRecord(parsed)) rawInput = parsed
        } catch {
          // A model can emit malformed JSON arguments. That is a normal tool
          // failure, not a protocol break: the call still happened and the
          // result event will carry the error.
          warnings.push({
            kind: "malformed-payload",
            detail: `tool/call ${toolName}: unparsable arguments`,
          })
        }
      } else if (isRecord(args)) {
        rawInput = args
      }
      events.push({ type: "tool_use_start", sessionId, timestamp, toolUseId, toolName, rawInput })
      break
    }

    case "tool/result": {
      const message = isRecord(data.message) ? data.message : undefined
      const source = message && isRecord(message.source) ? message.source : undefined
      const toolUseId = asString(source?.callId) ?? asString(data.callId)
      if (!toolUseId) {
        warnings.push({ kind: "malformed-payload", detail: "tool/result without a call id" })
        break
      }
      const content = Array.isArray(message?.content) ? message.content : []
      const first = content.find((block): block is Record<string, unknown> => isRecord(block))
      const isError = first?.isError === true
      const resultText = textFromContent(first?.content)
      events.push({
        type: "tool_result",
        sessionId,
        timestamp,
        toolUseId,
        result: resultText,
        isError,
      })
      break
    }

    case "request/header":
    case "request/context":
    case "session/title":
    case "agent/inbox/spliced":
      // Model-request provenance, titles, and inbox admission are recorded on
      // the canonical envelope by the caller, which holds the run identity this
      // codec does not. Nothing to project into the message stream.
      break
  }

  return { events, warnings }
}

/**
 * Translate a batch, keeping wire order.
 *
 * A `DshVersionDriftError` propagates: an unrecognized required event means the
 * rest of the stream can no longer be trusted to mean what this codec assumes.
 */
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

/**
 * Stable dedupe key for a DSH event.
 *
 * `seq` is per-session monotonic, so the channel + session + seq triple is
 * unique. The channel id is included because two channels may run concurrently
 * during an upgrade and their session ids are independently generated.
 */
export function dshEventDedupeKey(channelId: string, sessionId: string, seq: number): string {
  return `${channelId} ${sessionId} ${seq}`
}
