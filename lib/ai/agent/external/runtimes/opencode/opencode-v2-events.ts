import type {
  FormField,
  FormInfo,
  SessionMessageInfo,
  TokenUsageInfo,
  V2Event,
} from "@opencode/client"

import type {
  AcpElicitationPropertySchema,
  AcpElicitationSchema,
  AcpStopReason,
  ExternalAgentContent,
  ExternalAgentEvent,
  ExternalAgentMessage,
  ExternalAgentTokenUsage,
} from "@/types/agent/external-agent"
import { normalizeAcpElicitationRequest } from "../acp/acp-elicitation"

// Restored forms use the HTTP representation, whose numeric values can include
// serialized non-finite values; live events are assignable to this wider shape.
export type OpenCodeEvent =
  | Exclude<V2Event, { type: "form.created" }>
  | (Omit<Extract<V2Event, { type: "form.created" }>, "data"> & { data: { form: FormInfo } })

function mapUsage(tokens: TokenUsageInfo, cost?: number): ExternalAgentTokenUsage {
  return {
    promptTokens: tokens.input,
    completionTokens: tokens.output + tokens.reasoning,
    totalTokens: tokens.input + tokens.output + tokens.reasoning,
    reasoningTokens: tokens.reasoning,
    cacheReadTokens: tokens.cache.read,
    cacheWriteTokens: tokens.cache.write,
    ...(cost !== undefined ? { providerCost: { amount: cost, currency: "USD" } } : {}),
  }
}

/** Project the provider's ordered history without losing non-text parts or failed work. */
export function mapOpenCodeV2Messages(messages: SessionMessageInfo[]): ExternalAgentMessage[] {
  return messages.map((message): ExternalAgentMessage => {
    const content: ExternalAgentContent[] = []
    let role: ExternalAgentMessage["role"] = "system"
    switch (message.type) {
      case "user":
        role = "user"
        content.push({ type: "text", text: message.text })
        for (const file of message.files ?? []) {
          if (file.mime.startsWith("image/")) {
            content.push({
              type: "image",
              source: { type: "base64", data: file.data, mediaType: file.mime },
              alt: file.name,
            })
          } else if (file.mime.startsWith("audio/")) {
            content.push({ type: "audio", data: file.data, mimeType: file.mime })
          } else {
            content.push({
              type: "resource",
              resource: {
                uri:
                  file.source.type === "uri"
                    ? file.source.uri
                    : `data:${file.mime};base64,${file.data}`,
                mimeType: file.mime,
                blob: file.data,
              },
            })
          }
        }
        break
      case "assistant":
        role = "assistant"
        for (const part of message.content) {
          if (part.type === "text") content.push({ type: "text", text: part.text })
          else if (part.type === "reasoning")
            content.push({ type: "thinking", thinking: part.text })
          else {
            content.push({
              type: "tool_use",
              id: part.id,
              name: part.name,
              input:
                part.state.status === "streaming" ? { raw: part.state.input } : part.state.input,
              status: part.state.status === "streaming" ? "pending" : part.state.status,
            })
            if (part.state.status === "completed") {
              content.push({
                type: "tool_result",
                toolUseId: part.id,
                content: { content: part.state.content },
                isError: false,
              })
            } else if (part.state.status === "error") {
              content.push({
                type: "tool_result",
                toolUseId: part.id,
                content: {
                  error: part.state.error,
                  ...(part.state.content ? { content: part.state.content } : {}),
                },
                isError: true,
              })
            }
          }
        }
        if (message.error)
          content.push({
            type: "error",
            error: message.error.message,
            code: message.error.type,
            details: { ...message.error },
          })
        break
      case "synthetic":
      case "system":
      case "skill":
        content.push({ type: "text", text: message.text })
        break
      case "agent-switched":
        content.push({ type: "text", text: message.agent })
        break
      case "model-switched":
        content.push({
          type: "text",
          text: `${message.model.providerID}/${message.model.id}${message.model.variant ? `#${message.model.variant}` : ""}`,
        })
        break
      case "location-switched":
        content.push({
          type: "text",
          text: message.location.directory ?? "",
        })
        break
      case "compaction":
        if (message.status === "failed")
          content.push({
            type: "error",
            error: message.error.message,
            code: message.error.type,
            details: { ...message.error },
          })
        else
          content.push({
            type: "text",
            text: [message.summary, message.recent].filter(Boolean).join("\n\n"),
          })
        break
      case "shell": {
        role = "tool"
        const failed =
          message.status === "timeout" ||
          message.status === "killed" ||
          (message.exit !== undefined && message.exit !== 0)
        content.push({
          type: "tool_use",
          id: message.shellID,
          name: "shell",
          input: { command: message.command },
          status: message.status === "running" ? "running" : failed ? "error" : "completed",
        })
        if (message.status !== "running")
          content.push({
            type: "tool_result",
            toolUseId: message.shellID,
            content: { status: message.status, exit: message.exit, output: message.output },
            isError: failed,
          })
        break
      }
    }
    return {
      id: message.id,
      role,
      content,
      timestamp: new Date(message.time.created),
      ...("tokens" in message && message.tokens
        ? { tokenUsage: mapUsage(message.tokens, message.cost) }
        : {}),
      metadata: { ...message.metadata, openCodeMessage: message },
    }
  })
}

function formProperty(
  field: Exclude<FormField, { type: "external" }>
): AcpElicitationPropertySchema {
  const { key: _key, required: _required, ...native } = field
  if (field.type === "multiselect") {
    return {
      ...native,
      type: "array",
      items: {
        type: "string",
        ...(!field.custom
          ? {
              oneOf: field.options.map((option) => ({ const: option.value, title: option.label })),
            }
          : {}),
      },
    }
  }
  return {
    ...native,
    type: field.type,
    ...(field.type === "string" && field.options && !field.custom
      ? {
          oneOf: field.options.map((option) => ({ const: option.value, title: option.label })),
        }
      : {}),
  }
}

/** Current native V2 wire projection; transport and outbound policy remain in the adapter. */
export class OpenCodeV2EventMapper {
  readonly pendingForms = new Map<string, FormInfo>()
  private readonly tools = new Map<string, string>()
  private readonly steps = new Map<string, { tokens: TokenUsageInfo; cost: number }>()
  private terminalEmitted = false
  private stopReason: AcpStopReason = "end_turn"

  constructor(
    private readonly sessionId: string,
    private readonly mountedServers: string[] = []
  ) {}

  private toolName(name: string): string {
    for (const server of this.mountedServers) {
      if (!["cognia-tools", "cognia-plugin-tools"].includes(server)) continue
      const prefix = `${server}_`
      if (name.startsWith(prefix) && name.length > prefix.length)
        return `mcp__${server}__${name.slice(prefix.length)}`
    }
    return name
  }

  resetExecution(): void {
    this.tools.clear()
    this.steps.clear()
    this.terminalEmitted = false
    this.stopReason = "end_turn"
  }

  get tokenUsage(): ExternalAgentTokenUsage | undefined {
    if (this.steps.size === 0) return undefined
    let input = 0
    let output = 0
    let reasoning = 0
    let read = 0
    let write = 0
    let cost = 0
    for (const step of this.steps.values()) {
      const { tokens } = step
      input += tokens.input
      output += tokens.output
      reasoning += tokens.reasoning
      read += tokens.cache.read
      write += tokens.cache.write
      cost += step.cost
    }
    return mapUsage({ input, output, reasoning, cache: { read, write } }, cost)
  }

  map(event: OpenCodeEvent): ExternalAgentEvent[] {
    const data = event.data as Record<string, unknown>
    const eventSessionId =
      event.type === "form.created" ? event.data.form.sessionID : data.sessionID
    if (eventSessionId !== this.sessionId) return []
    const base = {
      sessionId: this.sessionId,
      timestamp: new Date("created" in event ? event.created : Date.now()),
    }
    switch (event.type) {
      case "session.execution.started":
        this.resetExecution()
        return []
      case "session.text.started":
        return [
          {
            ...base,
            type: "message_start",
            messageId: event.data.assistantMessageID,
            role: "assistant",
          },
        ]
      case "session.text.delta":
        return [
          {
            ...base,
            type: "message_delta",
            messageId: event.data.assistantMessageID,
            delta: { type: "text", text: event.data.delta },
          },
        ]
      case "session.text.ended":
        return [{ ...base, type: "message_end", messageId: event.data.assistantMessageID }]
      case "session.reasoning.delta":
        return [
          {
            ...base,
            type: "thinking",
            messageId: event.data.assistantMessageID,
            thinking: event.data.delta,
          },
        ]
      case "session.tool.input.started":
        this.tools.set(event.data.id, this.toolName(event.data.name))
        return [
          {
            ...base,
            type: "tool_use_start",
            toolUseId: event.data.id,
            toolName: this.toolName(event.data.name),
          },
        ]
      case "session.tool.input.delta":
        return [
          { ...base, type: "tool_use_delta", toolUseId: event.data.id, delta: event.data.delta },
        ]
      case "session.tool.called": {
        const events: ExternalAgentEvent[] = []
        if (!this.tools.has(event.data.id)) {
          this.tools.set(event.data.id, "unknown")
          events.push({
            ...base,
            type: "tool_use_start",
            toolUseId: event.data.id,
            toolName: "unknown",
            rawInput: event.data.input,
          })
        }
        events.push({
          ...base,
          type: "tool_use_end",
          toolUseId: event.data.id,
          input: event.data.input,
        })
        return events
      }
      case "session.tool.success":
        return [
          {
            ...base,
            type: "tool_result",
            toolUseId: event.data.id,
            toolName: this.tools.get(event.data.id),
            result: { content: event.data.content },
            rawOutput: { content: event.data.content, metadata: event.data.metadata },
            isError: false,
          },
        ]
      case "session.tool.failed":
        return [
          {
            ...base,
            type: "tool_result",
            toolUseId: event.data.id,
            toolName: this.tools.get(event.data.id),
            result: {
              error: event.data.error,
              ...(event.data.content ? { content: event.data.content } : {}),
            },
            isError: true,
          },
        ]
      case "session.step.ended":
        this.steps.set(event.data.assistantMessageID, {
          tokens: event.data.tokens,
          cost: event.data.cost,
        })
        this.stopReason =
          event.data.finish === "length"
            ? "max_tokens"
            : event.data.finish === "content-filter"
              ? "refusal"
              : "end_turn"
        return []
      case "session.step.failed":
        return [
          {
            ...base,
            type: "error",
            error: event.data.error.message,
            code: event.data.error.type,
            recoverable: true,
          },
        ]
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        if (this.terminalEmitted) return []
        this.terminalEmitted = true
        const events: ExternalAgentEvent[] = []
        if (event.type === "session.execution.failed") {
          events.push({
            ...base,
            type: "error",
            error: event.data.error.message,
            code: event.data.error.type,
            recoverable: false,
          })
        }
        events.push({
          ...base,
          type: "done",
          success: event.type === "session.execution.succeeded",
          stopReason:
            event.type === "session.execution.interrupted" ? "cancelled" : this.stopReason,
          ...(this.tokenUsage ? { tokenUsage: this.tokenUsage } : {}),
        })
        return events
      }
      case "permission.asked":
        return [
          {
            ...base,
            type: "permission_request",
            request: {
              id: event.data.id,
              requestId: event.data.id,
              sessionId: this.sessionId,
              toolCallId: event.data.source?.id,
              title: event.data.message ?? event.data.action,
              toolInfo: { id: event.data.action, name: this.toolName(event.data.action) },
              rawInput: { resources: event.data.resources },
              metadata: {
                ...event.data.metadata,
                save: event.data.save,
                source: event.data.source,
              },
            },
          },
        ]
      case "permission.replied":
        return [
          {
            ...base,
            type: "permission_response",
            response: {
              requestId: event.data.requestID,
              granted: event.data.reply !== "reject",
              rememberChoice: event.data.reply === "always",
              scope: event.data.reply === "always" ? "always" : "once",
            },
          },
        ]
      case "form.created":
        return this.mapForm(event.data.form, base)
      case "form.replied":
      case "form.cancelled":
        this.pendingForms.delete(event.data.id)
        return [{ ...base, type: "elicitation_complete", elicitationId: event.data.id }]
      case "session.compaction.started":
        return [{ ...base, type: "progress", progress: 0, message: "context_compaction" }]
      case "session.compaction.ended":
        return [{ ...base, type: "progress", progress: 1, message: "context_compaction_complete" }]
      case "session.agent.selected":
        return [{ ...base, type: "mode_update", modeId: event.data.agent }]
      default:
        return []
    }
  }

  private mapForm(
    form: FormInfo,
    base: { sessionId: string; timestamp: Date }
  ): ExternalAgentEvent[] {
    this.pendingForms.set(form.id, form)
    const unavailable = (reason: string): ExternalAgentEvent[] => [
      {
        ...base,
        type: "error",
        code: `opencode_form_${reason}`,
        error: `OpenCode form ${form.id} cannot be displayed: ${reason}`,
        recoverable: true,
      },
    ]
    // The current shared renderer has no conditional or mixed URL/form flow.
    // Preserve the full native request for cancellation or a native client.
    if (form.fields.some((field) => "when" in field && field.when?.length))
      return unavailable("conditional_fields")
    if (form.fields.some((field) => field.type === "multiselect" && field.custom))
      return unavailable("custom_multiselect")
    if (
      form.fields.some(
        (field) =>
          (field.type === "number" || field.type === "integer") &&
          [field.minimum, field.maximum, field.default].some(
            (value) => value !== undefined && !Number.isFinite(value)
          )
      )
    )
      return unavailable("nonfinite_number")
    const external = form.fields.filter((field) => field.type === "external")
    if (external.length && form.fields.length !== 1) return unavailable("mixed_external_fields")
    const common = {
      sessionId: this.sessionId,
      message: form.title,
      _meta: { openCodeFormId: form.id },
      openCodeForm: form,
    }
    let payload: Record<string, unknown>
    if (external.length) {
      payload = { ...common, mode: "url", elicitationId: form.id, url: external[0].url }
    } else {
      const properties: AcpElicitationSchema["properties"] = Object.create(null)
      const required: string[] = []
      for (const field of form.fields) {
        if (field.type === "external") continue
        properties[field.key] = formProperty(field)
        if (field.required) required.push(field.key)
      }
      payload = {
        ...common,
        mode: "form",
        requestedSchema: { type: "object", properties, required },
      }
    }
    const normalized = normalizeAcpElicitationRequest(form.id, payload)
    if (!normalized.ok) return unavailable(normalized.reason)
    return [{ ...base, type: "elicitation_request", request: normalized.request }]
  }
}
