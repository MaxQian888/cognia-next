import type { ExternalAgentEvent } from "@cognia/agent-contracts/external-agent"

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Crush event")
  return value as Record<string, unknown>
}

/** Converts native snapshots into deltas; queued turns end only on their own run_id. */
export class CrushEventDecoder {
  ended = false
  private text = new Map<string, string>()
  private tools = new Set<string>()
  private results = new Set<string>()
  private emitted = ""
  private messages = new Map<string, string>()
  constructor(
    readonly sessionId: string,
    readonly runId: string,
    readonly messageId: string,
    private readonly priorMessages: ReadonlySet<string> = new Set()
  ) {}

  decode(value: unknown): ExternalAgentEvent[] {
    const envelope = record(value)
    if (!["message", "run_complete", "agent_event"].includes(String(envelope.type))) return []
    const wrapped = record(envelope.payload)
    const payload = record(wrapped.payload)
    const base = { sessionId: this.sessionId, timestamp: new Date() }
    const events: ExternalAgentEvent[] = []
    if (envelope.type === "run_complete") {
      if (payload.session_id !== this.sessionId || payload.run_id !== this.runId) return []
      const text = typeof payload.text === "string" ? payload.text : ""
      const emitted = this.messages.get(String(payload.message_id)) ?? this.emitted
      if (text && !text.startsWith(emitted))
        throw new Error("Crush final response conflicts with streamed content")
      if (text.length > emitted.length)
        events.push({
          ...base,
          type: "message_delta",
          messageId: this.messageId,
          delta: { type: "text", text: text.slice(emitted.length) },
        })
      if (payload.error) events.push({ ...base, type: "error", error: String(payload.error) })
      this.ended = true
      events.push({ ...base, type: "message_end", messageId: this.messageId })
      events.push({
        ...base,
        type: "done",
        success: !payload.error && !payload.cancelled,
        stopReason: payload.cancelled ? "cancelled" : payload.error ? "refusal" : "end_turn",
      })
      return events
    }
    if (envelope.type === "agent_event" && payload.run_id === this.runId && payload.error)
      throw new Error(String(payload.error))
    if (envelope.type !== "message" || payload.session_id !== this.sessionId) return events
    if (this.priorMessages.has(String(payload.id))) return events
    if (!Array.isArray(payload.parts)) throw new Error("Malformed Crush message parts")
    for (const [index, raw] of payload.parts.entries()) {
      const part = record(raw)
      // Crush MarshalParts uses {type, data} discriminators.
      const content = record(part.data)
      if (part.type === "text" || part.type === "reasoning") {
        if (payload.role !== "assistant") continue
        const next = String(content[part.type === "text" ? "text" : "thinking"] ?? "")
        const key = `${payload.id}:${index}`
        const previous = this.text.get(key) ?? ""
        if (!next.startsWith(previous))
          throw new Error("Crush message snapshot rewrote already streamed content")
        this.text.set(key, next)
        const delta = next.slice(previous.length)
        if (delta) {
          if (part.type === "text") {
            this.emitted += delta
            this.messages.set(
              String(payload.id),
              (this.messages.get(String(payload.id)) ?? "") + delta
            )
            events.push({
              ...base,
              type: "message_delta",
              messageId: this.messageId,
              delta: { type: "text", text: delta },
            })
          } else
            events.push({
              ...base,
              type: "message_delta",
              messageId: this.messageId,
              delta: { type: "thinking", text: delta },
            })
        }
      } else if (part.type === "tool_call") {
        const id = String(content.id ?? "")
        if (!id || !content.name) throw new Error("Malformed Crush tool call")
        if (!this.tools.has(id)) {
          this.tools.add(id)
          events.push({
            ...base,
            type: "tool_use_start",
            toolUseId: id,
            toolName: String(content.name),
          })
        }
        if (content.finished && !this.results.has(`input:${id}`)) {
          this.results.add(`input:${id}`)
          const input =
            typeof content.input === "string" ? JSON.parse(content.input || "{}") : content.input
          events.push({ ...base, type: "tool_use_end", toolUseId: id, input: record(input) })
        }
      } else if (part.type === "tool_result") {
        const id = String(content.tool_call_id ?? "")
        if (!id) throw new Error("Malformed Crush tool result")
        if (!this.results.has(id)) {
          this.results.add(id)
          events.push({
            ...base,
            type: "tool_result",
            toolUseId: id,
            result: String(content.content ?? ""),
            isError: Boolean(content.is_error),
          })
        }
      }
    }
    return events
  }
}

/** Bounded native SSE framing; an incomplete event cannot report success. */
export async function* readCrushStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader(),
    decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let separator: RegExpExecArray | null
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        if (separator.index > 2 * 1024 * 1024)
          throw new Error("Crush event exceeded the 2 MiB limit")
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
        if (data) yield data
      }
      if (buffer.length > 2 * 1024 * 1024) throw new Error("Crush event exceeded the 2 MiB limit")
      if (done) break
    }
    if (buffer.trim()) throw new Error("Incomplete Crush SSE frame")
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
