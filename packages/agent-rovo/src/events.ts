/** Native SSE contract from atlassian/atlascode's responseParser.ts. */
export interface RovoWireEvent {
  kind: string
  data: Record<string, unknown>
}
const KINDS = new Set([
  "text",
  "tool-call",
  "tool-return",
  "user-prompt",
  "retry-prompt",
  "exception",
  "warning",
  "clear",
  "prune",
  "on_call_tools_start",
  "deferred-request",
  "close",
  "replay_end",
  "status",
  "usage",
  "prompts",
  "models",
  "request-usage",
  "thinking",
  "ui_changes_detected",
])

export function decodeRovoEvent(kind: string, value: unknown): RovoWireEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Rovo event payload")
  let data = value as Record<string, unknown>
  if (kind === "part_start" || kind === "part_delta") {
    const part = data[kind === "part_start" ? "part" : "delta"]
    if (!part || typeof part !== "object" || Array.isArray(part))
      throw new Error("Malformed Rovo part wrapper")
    data = part as Record<string, unknown>
    kind = String(data[kind === "part_start" ? "part_kind" : "part_delta_kind"])
  }
  kind = kind.replace(/^(tool_call|tool_return|user_prompt|retry_prompt)$/, (v) =>
    v.replace("_", "-")
  )
  if (!KINDS.has(kind)) throw new Error(`Unsupported Rovo event: ${kind}`)
  return { kind, data }
}

/** Preserves event: names (including payload-free close), with bounded framing. */
export async function* readRovoStream(
  body: ReadableStream<Uint8Array>
): AsyncIterable<RovoWireEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const decode = (block: string): RovoWireEvent | undefined => {
    let kind: string | undefined
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) kind = line.slice(6).trim()
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
    }
    if (!kind && !data.length) return
    if (!kind) throw new Error("Malformed Rovo SSE event: missing event name")
    let value: unknown = {}
    if (data.join("\n")) {
      try {
        value = JSON.parse(data.join("\n"))
      } catch {
        throw new Error("Malformed Rovo SSE JSON")
      }
    }
    return decodeRovoEvent(kind, value)
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (buffer.length > 2 * 1024 * 1024)
        throw new Error("Rovo SSE frame exceeded the 2 MiB limit")
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = decode(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
        if (event) yield event
      }
      if (done) break
    }
    if (buffer.trim()) throw new Error("Incomplete Rovo SSE frame")
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
