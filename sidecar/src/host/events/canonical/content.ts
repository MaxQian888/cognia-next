import { record, asString, compact, type CanonicalEvent, type SdkMappingState } from "./common.ts"

/**
 * Whether a `tool_use` block is still receiving its input. The AI SDK adapter
 * marks the block `input-streaming` from `tool-input-start` until the input
 * is sealed, and its `input` is `{}` for that whole window. Surfacing such a
 * block as a `tool-call` records a call the model has not finished making,
 * with arguments it never sent.
 */
export function isToolInputStreaming(block: Record<string, unknown>) {
  return block?.state === "input-streaming"
}

/**
 * Whether this snapshot is the first time the block's id is seen. Blocks
 * without an id cannot be correlated and always pass (both rails supply ids).
 */
export function claimToolCallId(state: SdkMappingState, block: Record<string, unknown>) {
  const id = asString(block?.id)
  if (!id) return true
  const seen = state.emittedToolCallIds instanceof Set ? state.emittedToolCallIds : null
  if (!seen) return true
  if (seen.has(id)) return false
  seen.add(id)
  return true
}

export function contentBlocks(message: unknown): Record<string, unknown>[] {
  const content = record(message).content
  if (Array.isArray(content)) return content.map(record)
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  return []
}

/** Assistant turn: tool calls always, text only when nothing streamed it. */
export function fromAssistant(
  evt: Record<string, unknown>,
  state: SdkMappingState
): CanonicalEvent[] {
  const events: CanonicalEvent[] = []
  const messageId = asString(record(evt.message).id)
  const streamedThisMessage = messageId
    ? state.streamedMessageIds instanceof Set && state.streamedMessageIds.has(messageId)
    : state.sawStreamEvents
  for (const block of contentBlocks(evt.message)) {
    if (block?.type === "tool_use") {
      // One `tool-call` per call, carrying the input the model actually sent:
      // skip the snapshots taken while the input was still streaming, then
      // let only the first sealed snapshot through.
      if (isToolInputStreaming(block) || !claimToolCallId(state, block)) continue
      events.push(
        compact({
          kind: "tool-call",
          toolName: String(block.name ?? ""),
          input: block.input && typeof block.input === "object" ? block.input : {},
          toolCallId: asString(block.id),
        })
      )
    } else if (!streamedThisMessage && block?.type === "text" && block.text) {
      events.push({ kind: "text-delta", delta: String(block.text) })
    } else if (!streamedThisMessage && block?.type === "thinking" && block.thinking) {
      events.push({ kind: "thinking-delta", delta: String(block.thinking) })
    }
  }
  return events
}

/**
 * User turn. `isReplay` is the runtime echoing a message back with the id it
 * assigned — the id `rewindFiles` needs — so it becomes `user-replay` rather
 * than a second copy of the user's input.
 */
export function fromUser(evt: Record<string, unknown>): CanonicalEvent[] {
  if (evt.isReplay) {
    const text = contentBlocks(evt.message)
      .filter((b) => b?.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("")
    return [
      compact({
        kind: "user-replay",
        messageId: String(evt.uuid ?? ""),
        preview: text ? text.slice(0, 200) : undefined,
        synthetic: evt.isSynthetic === true ? true : undefined,
      }),
    ]
  }

  const events: CanonicalEvent[] = []
  let text = ""
  for (const block of contentBlocks(evt.message)) {
    if (block?.type === "tool_result") {
      events.push(
        compact({
          kind: "tool-result",
          toolName: asString(block.tool_name) ?? "",
          toolCallId: asString(block.tool_use_id),
          result: block.content,
          isError: block.is_error === true ? true : undefined,
        })
      )
    } else if (block?.type === "text") {
      text += String(block.text ?? "")
    }
  }
  if (text) events.unshift({ kind: "user-input", text })
  return events
}

/** Token-level partials. Only actual content deltas mute the matching snapshot. */
export function fromStreamEvent(
  evt: Record<string, unknown>,
  state: SdkMappingState
): CanonicalEvent[] {
  const streamEvent = record(evt.event)
  if (streamEvent?.type === "message_start") {
    state.activeStreamMessageId = asString(record(streamEvent.message).id)
  }
  const delta = record(record(evt.event).delta)
  if (delta?.type === "text_delta" && delta.text) {
    if (state.activeStreamMessageId && state.streamedMessageIds instanceof Set) {
      state.streamedMessageIds.add(state.activeStreamMessageId)
    } else {
      state.sawStreamEvents = true
    }
    return [{ kind: "text-delta", delta: String(delta.text) }]
  }
  if (delta?.type === "thinking_delta" && delta.thinking) {
    if (state.activeStreamMessageId && state.streamedMessageIds instanceof Set) {
      state.streamedMessageIds.add(state.activeStreamMessageId)
    } else {
      state.sawStreamEvents = true
    }
    return [{ kind: "thinking-delta", delta: String(delta.thinking) }]
  }
  // A `content_block_start` for a `tool_use` block deliberately yields nothing.
  // The Anthropic API streams the arguments as `input_json_delta` frames after
  // it, so the only input available here is `{}`. The authoritative
  // `assistant` snapshot seals the same block with its real input and arrives
  // before the tool executes, and that is the one `tool-call` the log keeps.
  // Emitting here as well recorded every call twice, the first time with
  // arguments the model never sent.
  return []
}
