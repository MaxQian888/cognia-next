// Byte-exact SSE frame writer for the deterministic Anthropic conformance
// server (ADR-0090 Phase 4). Frames are `event: <name>\ndata: <json>\n\n`
// exactly as the Anthropic Messages API emits them; `splitPoints` lets a
// scenario force chunk boundaries mid-frame (including mid-UTF-8 codepoint)
// to exercise client reassembly.

/** Render one SSE frame. `data` may be an object (JSON-encoded) or a string. */
export function frame(event, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data)
  return `event: ${event}\ndata: ${payload}\n\n`
}

/** A ping keepalive frame (Anthropic emits these mid-stream). */
export function ping() {
  return frame("ping", { type: "ping" })
}

/**
 * Split a byte buffer at explicit offsets so the transport writes each piece
 * separately. Offsets are clamped/deduped; invalid ones are ignored.
 *
 * @param {Buffer} buffer
 * @param {number[]} [splitPoints]
 * @returns {Buffer[]}
 */
export function splitBytes(buffer, splitPoints = []) {
  const points = [...new Set(splitPoints.filter((p) => p > 0 && p < buffer.length))].sort(
    (a, b) => a - b
  )
  if (points.length === 0) return [buffer]
  const out = []
  let start = 0
  for (const point of points) {
    out.push(buffer.subarray(start, point))
    start = point
  }
  out.push(buffer.subarray(start))
  return out
}

/**
 * Standard Anthropic Messages SSE transcript for a plain text reply.
 * Deterministic ids come from the scenario.
 */
export function textReplyFrames({ messageId, model, text, inputTokens = 10, outputTokens = 5 }) {
  return [
    frame("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    }),
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    ping(),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }),
    frame("message_stop", { type: "message_stop" }),
  ]
}

/**
 * Tool-use transcript: the assistant calls `tools` (one content block each,
 * with `input_json_delta` fragments per the provided splits), then stops with
 * stop_reason "tool_use".
 *
 * @param {{ messageId: string, model: string, tools: Array<{ id: string, name: string, inputJson: string, fragments?: string[] }> }} args
 */
export function toolUseFrames({ messageId, model, tools }) {
  const frames = [
    frame("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 1 },
      },
    }),
  ]
  tools.forEach((tool, index) => {
    frames.push(
      frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
      })
    )
    const fragments = tool.fragments ?? [tool.inputJson]
    for (const fragment of fragments) {
      frames.push(
        frame("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: fragment },
        })
      )
    }
    frames.push(frame("content_block_stop", { type: "content_block_stop", index }))
  })
  frames.push(
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 15 },
    }),
    frame("message_stop", { type: "message_stop" })
  )
  return frames
}

/** Buffered (non-streaming) Anthropic message body for `stream: false` calls. */
export function bufferedMessage({ messageId, model, text, inputTokens = 10, outputTokens = 5 }) {
  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
}
