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

/** A history message as far as pairing cares: tool parts carry a `toolCallId`. */
interface PairedMessage {
  role?: unknown
  content?: ({ type?: unknown; toolCallId?: unknown } | null | undefined)[] | unknown
  [field: string]: unknown
}

/**
 * Drop unpaired tool-call / tool-result parts so the history satisfies the
 * tool-call ↔ tool-result pairing invariant. Pairs strictly by `toolCallId`:
 * the conversation is built in causal order, so a surviving result always
 * trails its call — only a fully-missing partner is pruned.
 *
 * Identity-preserving on a well-formed history: every message whose content is
 * untouched is returned as the same object reference (so a downstream
 * `cacheControl` breakpoint spread still lands on the original message), and a
 * history with no corruption yields a structurally identical array. A
 * non-array passes through untouched.
 */
export function sanitizeToolMessagePairs<T>(messages: T): T {
  if (!Array.isArray(messages)) return messages
  const list = messages as (PairedMessage | null | undefined)[]

  // Collect the call/result id sets in a single pass so the rewrite below can
  // decide each part in O(1).
  const callIds = new Set<unknown>()
  const resultIds = new Set<unknown>()
  for (const msg of list) {
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

  const out: (PairedMessage | null | undefined)[] = []
  for (const msg of list) {
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
  return out as T
}

// ── Pair-safe history splits ──────────────────────────────────────────────
//
// Compaction cuts the history into a summarized prefix and a verbatim tail.
// A cut between a tool call and its result leaves one half unpaired: the live
// session survives because `sanitizeToolMessagePairs` repairs every send, but
// the compacted history is also what gets saved, and a resume refuses a
// snapshot with an orphan result or an unanswered call. So every cut is moved
// to a pair-safe index instead: no call before it whose result is after it.

/** Tool call ids each message issues, and the ids whose results it carries. */
function toolIdsOf(message: PairedMessage | null | undefined): {
  calls: string[]
  results: string[]
} {
  const calls: string[] = []
  const results: string[] = []
  if (!message || !Array.isArray(message.content)) return { calls, results }
  for (const raw of message.content as unknown[]) {
    if (!raw || typeof raw !== "object") continue
    const part = raw as Record<string, unknown>
    if (part.type === "tool-call" && typeof part.toolCallId === "string")
      calls.push(part.toolCallId)
    else if (part.type === "tool_use" && typeof part.id === "string") calls.push(part.id)
    else if (part.type === "tool-result" && typeof part.toolCallId === "string")
      results.push(part.toolCallId)
    else if (part.type === "tool_result" && typeof part.tool_use_id === "string")
      results.push(part.tool_use_id)
  }
  return { calls, results }
}

/** First-call and last-result index of every tool call id in the history. */
function pairSpans(messages: readonly unknown[]): Map<string, { call: number; result: number }> {
  const spans = new Map<string, { call: number; result: number }>()
  messages.forEach((message, index) => {
    const { calls, results } = toolIdsOf(message as PairedMessage)
    for (const id of calls) if (!spans.has(id)) spans.set(id, { call: index, result: -1 })
    for (const id of results) {
      const span = spans.get(id)
      // A result with no earlier call is already orphaned; no cut can fix it.
      if (span && span.call < index) span.result = Math.max(span.result, index)
    }
  })
  return spans
}

/** Clamp a split index into `[0, length]`. */
function clampSplit(index: number, length: number): number {
  return Math.min(Math.max(0, Math.trunc(index)), length)
}

/**
 * The largest index ≤ `index` that splits `messages` without separating a tool
 * call from its result. Moving the cut earlier keeps the whole pair on the
 * later (verbatim) side.
 */
export function pairSafeSplitBefore(messages: readonly unknown[], index: number): number {
  let split = clampSplit(index, messages.length)
  const spans = pairSpans(messages)
  for (let changed = true; changed;) {
    changed = false
    for (const { call, result } of spans.values()) {
      if (call < split && result >= split) {
        split = call
        changed = true
      }
    }
  }
  return split
}

/**
 * The smallest index ≥ `index` that splits `messages` without separating a
 * tool call from its result. Moving the cut later puts the whole pair on the
 * earlier (summarized) side.
 */
export function pairSafeSplitAfter(messages: readonly unknown[], index: number): number {
  let split = clampSplit(index, messages.length)
  const spans = pairSpans(messages)
  for (let changed = true; changed;) {
    changed = false
    for (const { call, result } of spans.values()) {
      if (call < split && result >= split) {
        split = result + 1
        changed = true
      }
    }
  }
  return split
}

/**
 * Split `messages` into the smallest runs that each keep every tool call with
 * all of its results (a call and its results land in one run; a message with
 * no tool parts is a run of its own). Concatenating the runs gives the input.
 */
export function toolPairUnits<T>(messages: readonly T[]): T[][] {
  const units: T[][] = []
  let start = 0
  while (start < messages.length) {
    const end = pairSafeSplitAfter(messages, start + 1)
    units.push(messages.slice(start, end))
    start = end
  }
  return units
}

/**
 * Ids of tool calls that are unpaired in `messages`: a call with no later
 * result, or a result with no earlier call. Empty for a well-formed history.
 */
export function unpairedToolCallIds(messages: readonly unknown[]): Set<string> {
  const unpaired = new Set<string>()
  const answered = new Set<string>()
  const called = new Set<string>()
  for (const message of messages) {
    const { calls, results } = toolIdsOf(message as PairedMessage)
    for (const id of calls) called.add(id)
    for (const id of results) {
      if (called.has(id)) answered.add(id)
      else unpaired.add(id)
    }
  }
  for (const id of called) if (!answered.has(id)) unpaired.add(id)
  return unpaired
}
