// Per-tool-result capping applied during compaction (generic path).
//
// Implements `CompressionSettings.maxToolResultTokens` + `preserveToolCallMetadata`
// (types/system/compression.ts). Large tool outputs (bash/grep/read) that survive
// verbatim in the kept slices bloat the post-compaction window; this caps each
// tool-result body to ~`maxToolResultTokens` tokens (≈4 chars/token), keeping the
// tool name/status header when `preserveToolCallMetadata` is on. Reuses the
// sidecar's own `headTruncate` (sidecar→sidecar import is allowed).

import { headTruncate } from "../builtin-tools/shared/truncate.mjs"

const APPROX_CHARS_PER_TOKEN = 4
const MARKER = "\n... (tool result truncated)"

function toolHeader(name, status) {
  return `[tool: ${name || "tool"} | status: ${status || "ok"}]`
}

/** Cap a string body; prepend a metadata header only when it was truncated. */
function capBody(text, maxChars, header) {
  const { text: capped, truncated } = headTruncate(text, maxChars, { marker: MARKER })
  if (!truncated) return { text, truncated: false }
  return {
    text: header ? `${header}${capped.startsWith("\n") ? "" : "\n"}${capped}` : capped,
    truncated: true,
  }
}

function statusOf(part, message) {
  if (part?.isError || message?.isError) return "error"
  return part?.status || message?.status || "ok"
}

function nameOf(part, message) {
  return part?.toolName || part?.tool_name || message?.name || message?.toolName || "tool"
}

/** Cap one message's tool-result body, returning the same ref when unchanged. */
function capMessage(message, maxChars, preserveMeta) {
  if (!message) return message

  // role:"tool" with a string body — the dominant large-output shape.
  if (message.role === "tool" && typeof message.content === "string") {
    const header = preserveMeta ? toolHeader(nameOf(null, message), statusOf(null, message)) : ""
    const { text, truncated } = capBody(message.content, maxChars, header)
    return truncated ? { ...message, content: text } : message
  }

  // Block content — cap any tool-result part whose body is a string.
  if (Array.isArray(message.content)) {
    let changed = false
    const content = message.content.map((part) => {
      if (!part || typeof part !== "object") return part
      const isToolResult = part.type === "tool-result" || part.type === "tool_result"
      if (!isToolResult) return part
      for (const field of ["output", "result", "text", "content"]) {
        if (typeof part[field] === "string") {
          const header = preserveMeta
            ? toolHeader(nameOf(part, message), statusOf(part, message))
            : ""
          const { text, truncated } = capBody(part[field], maxChars, header)
          if (truncated) {
            changed = true
            return { ...part, [field]: text }
          }
          return part
        }
      }
      return part
    })
    return changed ? { ...message, content } : message
  }

  return message
}

/**
 * Cap every tool-result body in the conversation. No-op when
 * `maxToolResultTokens` is unset / non-positive. Non-tool messages are untouched.
 *
 * @param {Array<{role?:string, content?:any}>} conversation
 * @param {{ maxToolResultTokens?: number, preserveToolCallMetadata?: boolean }} [opts]
 */
export function capToolResults(
  conversation,
  { maxToolResultTokens, preserveToolCallMetadata = true } = {}
) {
  if (typeof maxToolResultTokens !== "number" || maxToolResultTokens <= 0) return conversation
  const maxChars = maxToolResultTokens * APPROX_CHARS_PER_TOKEN
  return conversation.map((m) => capMessage(m, maxChars, preserveToolCallMetadata))
}
