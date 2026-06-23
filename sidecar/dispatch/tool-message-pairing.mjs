// Tool-call ↔ tool-result pairing invariant for the AI SDK dispatcher's
// conversation history. The AI SDK `ModelMessage[]` form keeps a model's tool
// calls and their results in SEPARATE messages — an assistant message carries
// `{ type: "tool-call", toolCallId }` parts, and a following `role: "tool"`
// message carries the matching `{ type: "tool-result", toolCallId }` parts.
//
// Two corruptions can break that pairing before a send:
//   - A **dangling tool-call**: an interrupt aborts a leg after the assistant
//     emitted a `tool-call` part but before its `tool-result` landed, so the
//     call has no matching result.
//   - An **orphan tool-result**: a count-based compaction tail slice cuts
//     between an assistant `tool-call` and its `tool` message, leaving a
//     `tool-result` whose originating call is no longer in history.
//
// Providers like DeepSeek/OpenAI reject either case ("Messages with role
// 'tool' must be a response to a preceding message with 'tool_calls'"). The
// Anthropic protocol is stricter still. `sanitizeToolMessagePairs` drops the
// unpaired parts (and any message left empty by the drop) so the history is
// always well-formed when it reaches the provider.

/**
 * Drop unpaired tool-call / tool-result parts so the history satisfies the
 * tool-call ↔ tool-result pairing invariant. Pairs strictly by `toolCallId`:
 * the conversation is built in causal order, so a surviving result always
 * trails its call — only a fully-missing partner is pruned.
 *
 * Identity-preserving on a well-formed history: every message whose content is
 * untouched is returned as the same object reference (so a downstream
 * `cacheControl` breakpoint spread still lands on the original message), and a
 * history with no corruption yields a structurally identical array.
 *
 * @param {Array<any>} messages AI SDK `ModelMessage[]` (assistant/tool/user/system).
 * @returns {Array<any>} A new array with unpaired tool parts and emptied messages removed.
 */
export function sanitizeToolMessagePairs(messages) {
  if (!Array.isArray(messages)) return messages

  // Collect the call/result id sets in a single pass so the rewrite below can
  // decide each part in O(1).
  const callIds = new Set()
  const resultIds = new Set()
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part?.type === "tool-call" && part.toolCallId) callIds.add(part.toolCallId)
      }
    } else if (msg.role === "tool") {
      for (const part of msg.content) {
        if (part?.type === "tool-result" && part.toolCallId) resultIds.add(part.toolCallId)
      }
    }
  }

  const out = []
  for (const msg of messages) {
    // Assistant: drop dangling `tool-call` parts (a call with no result).
    if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
      const filtered = msg.content.filter(
        (part) =>
          !(part?.type === "tool-call" && part.toolCallId && !resultIds.has(part.toolCallId))
      )
      if (filtered.length === 0) continue
      out.push(filtered.length === msg.content.length ? msg : { ...msg, content: filtered })
      continue
    }
    // Tool: drop orphan `tool-result` parts (a result with no preceding call).
    if (msg && msg.role === "tool" && Array.isArray(msg.content)) {
      const filtered = msg.content.filter(
        (part) =>
          !(part?.type === "tool-result" && part.toolCallId && !callIds.has(part.toolCallId))
      )
      if (filtered.length === 0) continue
      out.push(filtered.length === msg.content.length ? msg : { ...msg, content: filtered })
      continue
    }
    out.push(msg)
  }
  return out
}
