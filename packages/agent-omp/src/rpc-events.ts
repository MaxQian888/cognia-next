/** OMP 18.6.1 RPC projection. Prompt/settle ownership belongs to the adapter. */
import type {
  AcpContentBlock,
  AcpElicitationPropertySchema,
  ExternalAgentEvent,
  ExternalAgentTokenUsage,
} from "@cognia/agent-contracts/external-agent"

export interface OmpNativeEvent {
  type: string
  [key: string]: unknown
}
export interface OmpStreamState {
  toolCallsByIndex: Map<string, string>
  startedToolCalls: Set<string>
}
export function createOmpStreamState(): OmpStreamState {
  return { toolCallsByIndex: new Map(), startedToolCalls: new Set() }
}
export interface OmpEventMapContext {
  sessionId: string
  streamState?: OmpStreamState
  now?: () => Date
  /** Receives every original frame, including rich vendor/subagent metadata. */
  onNativeEvent?: (event: OmpNativeEvent) => void
}
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
const string = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const number = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined

export function ompStatsToTokenUsage(stats: unknown): ExternalAgentTokenUsage | undefined {
  const s = record(stats)
  const t = record(s?.tokens) ?? record(s?.usage)
  if (!t) return undefined
  const promptTokens = number(t.input) ?? 0
  const completionTokens = number(t.output) ?? 0
  const cacheReadTokens = number(t.cacheRead)
  const cacheWriteTokens = number(t.cacheWrite)
  const cost = number(s?.cost) ?? number(record(t.cost)?.total)
  const context = record(s?.contextUsage)
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      number(t.total) ??
      number(t.totalTokens) ??
      promptTokens + completionTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
    cacheReadTokens,
    cacheWriteTokens,
    contextTokens: number(context?.tokens),
    modelContextWindow: number(context?.contextWindow),
    ...(cost === undefined ? {} : { providerCost: { amount: cost } }),
  }
}
function contentBlocks(value: unknown): AcpContentBlock[] {
  const items =
    typeof value === "string" ? [{ type: "text", text: value }] : Array.isArray(value) ? value : []
  return items.flatMap((item): AcpContentBlock[] => {
    const b = record(item)
    if (b?.type === "text" && typeof b.text === "string") return [{ type: "text", text: b.text }]
    if (b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string")
      return [{ type: "image", data: b.data, mimeType: b.mimeType }]
    return []
  })
}

export function mapOmpRpcEvent(
  event: OmpNativeEvent,
  ctx: OmpEventMapContext
): ExternalAgentEvent[] {
  ctx.onNativeEvent?.(event)
  const base = { sessionId: ctx.sessionId, timestamp: (ctx.now ?? (() => new Date()))() }
  const messageId = string(event.messageId)
  const message = record(event.message)
  const state = ctx.streamState
  switch (event.type) {
    case "message_start": {
      const role =
        message?.role === "user"
          ? "user"
          : message?.role === "toolResult"
            ? "tool"
            : message?.role === "system"
              ? "system"
              : "assistant"
      const events: ExternalAgentEvent[] = [{ ...base, type: "message_start", messageId, role }]
      // Assistant snapshots repeat streamed text; only user content is materialized here.
      if (role === "user")
        for (const block of contentBlocks(message?.content)) {
          events.push(
            { ...base, type: "content_block_start", messageId, role, block },
            { ...base, type: "content_block_end", messageId, block }
          )
        }
      return events
    }
    case "message_update": {
      const delta = record(event.assistantMessageEvent)
      if (!delta) return []
      if (delta.type === "text_delta" && typeof delta.delta === "string")
        return [
          { ...base, messageId, type: "message_delta", delta: { type: "text", text: delta.delta } },
        ]
      if (delta.type === "thinking_delta" && typeof delta.delta === "string")
        return [
          {
            ...base,
            messageId,
            type: "message_delta",
            delta: { type: "thinking", text: delta.delta },
          },
        ]
      const partial = record(delta.partial)
      const content = Array.isArray(partial?.content) ? partial.content : []
      const index = typeof delta.contentIndex === "number" ? delta.contentIndex : undefined
      const tool =
        record(delta.toolCall) ?? (index === undefined ? undefined : record(content[index]))
      const key = `${messageId ?? ""}:${index}`
      const id = string(tool?.id) ?? string(delta.id) ?? state?.toolCallsByIndex.get(key)
      const name = string(tool?.name) ?? string(delta.toolName)
      if (delta.type === "toolcall_start" && id && name) {
        state?.toolCallsByIndex.set(key, id)
        if (state?.startedToolCalls.has(id)) return []
        state?.startedToolCalls.add(id)
        return [{ ...base, type: "tool_use_start", toolUseId: id, toolName: name }]
      }
      if (delta.type === "toolcall_delta" && id && typeof delta.delta === "string")
        return [{ ...base, type: "tool_use_delta", toolUseId: id, delta: delta.delta }]
      if (delta.type === "toolcall_end" && id) {
        state?.toolCallsByIndex.delete(key)
        const events: ExternalAgentEvent[] = []
        // Delta mode omits partial snapshots; toolcall_end first identifies the call.
        if (name && !state?.startedToolCalls.has(id)) {
          state?.startedToolCalls.add(id)
          events.push({ ...base, type: "tool_use_start", toolUseId: id, toolName: name })
        }
        events.push({
          ...base,
          type: "tool_use_end",
          toolUseId: id,
          input: record(tool?.arguments) ?? {},
        })
        return events
      }
      return []
    }
    case "message_end": {
      if (messageId && state) {
        for (const key of state.toolCallsByIndex.keys()) {
          if (key.startsWith(`${messageId}:`)) state.toolCallsByIndex.delete(key)
        }
      }
      const events: ExternalAgentEvent[] = []
      if (message?.stopReason === "error" || event.stopReason === "error")
        events.push({
          ...base,
          type: "error",
          error:
            string(message?.errorMessage) ??
            string(event.errorMessage) ??
            "OMP provider request failed",
          recoverable: true,
        })
      // Some providers emit images only in the final assistant snapshot.
      if (message?.role === "assistant")
        for (const block of contentBlocks(message.content).filter((b) => b.type === "image"))
          events.push(
            { ...base, type: "content_block_start", messageId, role: "assistant", block },
            { ...base, type: "content_block_end", messageId, block }
          )
      events.push({
        ...base,
        type: "message_end",
        messageId,
        tokenUsage: ompStatsToTokenUsage({ usage: message?.usage }),
      })
      return events
    }
    case "tool_execution_start": {
      const id = string(event.toolCallId)
      if (!id) return []
      if (state?.startedToolCalls.has(id))
        return [
          {
            ...base,
            type: "tool_call_update",
            toolCallId: id,
            status: "in_progress",
            rawInput: record(event.args),
          },
        ]
      state?.startedToolCalls.add(id)
      return [
        {
          ...base,
          type: "tool_use_start",
          toolUseId: id,
          toolName: string(event.toolName) ?? "unknown",
          rawInput: record(event.args),
        },
      ]
    }
    case "tool_execution_update": {
      const id = string(event.toolCallId)
      return id
        ? [
            {
              ...base,
              type: "tool_call_update",
              toolCallId: id,
              status: "in_progress",
              rawInput: record(event.args),
              rawOutput: record(event.partialResult),
            },
          ]
        : []
    }
    case "tool_execution_end": {
      const id = string(event.toolCallId)
      if (!id) return []
      state?.startedToolCalls.delete(id)
      const result = record(event.result)
      return [
        {
          ...base,
          type: "tool_result",
          toolUseId: id,
          toolName: string(event.toolName),
          result: contentBlocks(result?.content)
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join(""),
          rawOutput: result,
          isError: event.isError === true,
          status: event.isError === true ? "failed" : "completed",
        },
      ]
    }
    case "command_output":
      return typeof event.text === "string"
        ? [{ ...base, type: "message_delta", delta: { type: "text", text: event.text } }]
        : []
    case "session_info_update":
      return typeof event.title === "string"
        ? [{ ...base, type: "session_info_update", title: event.title }]
        : []
    case "extension_error":
      return [
        {
          ...base,
          type: "error",
          error: string(event.error) ?? "OMP extension failed",
          recoverable: true,
        },
      ]
    case "available_commands_update": {
      const commands = Array.isArray(event.commands)
        ? event.commands.flatMap((item) => {
            const c = record(item)
            return typeof c?.name === "string"
              ? [{ name: c.name, description: string(c.description) ?? "" }]
              : []
          })
        : []
      return [{ ...base, type: "commands_update", commands }]
    }
    case "extension_ui_request":
      return mapUi(event, base)
    default:
      return []
  }
}

function mapUi(
  event: OmpNativeEvent,
  base: { sessionId: string; timestamp: Date }
): ExternalAgentEvent[] {
  const method = string(event.method)
  const id = string(event.id) ?? `${base.sessionId}:${base.timestamp.getTime()}:${method}`
  const ui = { ...base, type: "extension_ui_update" as const, id }
  if (method === "cancel" && typeof event.targetId === "string")
    return [{ ...base, type: "elicitation_complete", elicitationId: event.targetId }]
  if (method === "notify" && typeof event.message === "string")
    return [
      {
        ...ui,
        update: {
          kind: "notification",
          message: event.message,
          level:
            event.notifyType === "warning" || event.notifyType === "error"
              ? event.notifyType
              : "info",
        },
      },
    ]
  if (method === "setStatus" && typeof event.statusKey === "string")
    return event.statusKey === "cognia-omp-ready"
      ? []
      : [
          {
            ...ui,
            update: {
              kind: "status",
              key: event.statusKey,
              text: string(event.statusText) ?? null,
            },
          },
        ]
  if (method === "setWidget" && typeof event.widgetKey === "string") {
    if (
      event.widgetLines !== undefined &&
      (!Array.isArray(event.widgetLines) || !event.widgetLines.every((v) => typeof v === "string"))
    )
      return []
    return [
      {
        ...ui,
        update: {
          kind: "widget",
          key: event.widgetKey,
          lines: (event.widgetLines as string[] | undefined) ?? null,
          placement: event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
        },
      },
    ]
  }
  if (method === "setTitle" && typeof event.title === "string")
    return [{ ...ui, update: { kind: "title", title: event.title } }]
  if (method === "set_editor_text" && typeof event.text === "string")
    return [{ ...ui, update: { kind: "editor", text: event.text } }]
  if (!event.id || !method) return []
  const title = string(event.title)
  if (method === "open_url" && typeof event.url === "string")
    return [
      {
        ...base,
        type: "elicitation_request",
        request: {
          id,
          mode: "url",
          message: string(event.instructions) ?? event.url,
          url: event.url,
          raw: event,
        },
      },
    ]
  const properties: Record<string, AcpElicitationPropertySchema> = Object.create(null) as Record<
    string,
    AcpElicitationPropertySchema
  >
  const required: string[] = []
  if (method === "ask") {
    if (!Array.isArray(event.questions)) return []
    for (const value of event.questions) {
      const q = record(value)
      if (typeof q?.id !== "string" || typeof q.question !== "string" || !Array.isArray(q.options))
        return []
      const options = q.options
        .map(record)
        .flatMap((o) => (typeof o?.label === "string" ? [o.label] : []))
      properties[q.id] =
        q.multi === true
          ? { type: "array", title: q.question, items: { type: "string", enum: options } }
          : { type: "string", title: q.question, enum: options }
      properties[`${q.id}:customInput`] = { type: "string", title: q.question }
    }
  } else if (["confirm", "select", "input", "editor"].includes(method)) {
    properties[method] =
      method === "confirm"
        ? { type: "boolean", title }
        : {
            type: "string",
            title,
            ...(Array.isArray(event.options)
              ? { enum: event.options.filter((v): v is string => typeof v === "string") }
              : {}),
            ...(typeof event.placeholder === "string" ? { description: event.placeholder } : {}),
            ...(typeof event.prefill === "string" ? { default: event.prefill } : {}),
          }
    required.push(method)
  } else return []
  return [
    {
      ...base,
      type: "elicitation_request",
      request: {
        id,
        sessionId: base.sessionId,
        mode: "form",
        message: string(event.message) ?? title ?? `omp.${method}`,
        requestedSchema: { type: "object", title, properties, required },
        raw: event,
      },
    },
  ]
}
