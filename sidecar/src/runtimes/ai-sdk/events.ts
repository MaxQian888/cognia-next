import {
  shapeToolResultContent,
  finishReasonToStopReason,
  mergeMessageMetadata,
  sourceToCitation,
  generatedFileToBlock,
  getToolCallId,
  getToolInput,
  getToolMetadata,
  getProviderMetadata,
  tryParseToolInput,
} from "./events-payload.ts"
export { shapeToolResultContent, finishReasonToStopReason } from "./events-payload.ts"
import type {
  AiStreamEvent,
  EventAdapterContext,
  EventBlock,
  Citation,
  ProviderMetadata,
  TranslatedEvent,
} from "./events-types.ts"
// Translate Vercel AI SDK stream events into the SDKMessage shapes that
// `lib/claude/adapter.ts` consumes. Keeping this in one module is the core
// of the multi-provider port — everything downstream of the sidecar stays
// unchanged because the wire shape is preserved.
//
// Vercel AI SDK events we care about (subset of `result.fullStream`):
//   { type: "text-delta", textDelta: string }
//   { type: "reasoning", textDelta: string }     // o1/o3 / claude thinking
//   { type: "file", file: GeneratedFile }
//   { type: "tool-input-start"|"tool-input-delta"|"tool-input-end", id, ... }
//   { type: "tool-call", toolCallId, toolName, args }
//   { type: "tool-result", toolCallId, result }
//   { type: "finish", finishReason, usage|totalUsage: { promptTokens, completionTokens, totalTokens } }
//   { type: "error", error }
//
// SDKMessage shapes we emit (mirrors @anthropic-ai/claude-agent-sdk):
//   { type: "system", subtype: "init", session_id, ... }   — emitted once at start
//   { type: "assistant", message: { id, content: BetaContentBlock[] }, session_id, uuid }
//   { type: "result", subtype, session_id, usage, total_cost_usd, duration_ms, num_turns }

import { randomUUID } from "node:crypto"
import { normalizeUsageBlock } from "../../providers/usage-normalize.ts"
import { restoreToolName } from "../../policy/tool-catalog/model-names.ts"

function isRawAnalysis(event: AiStreamEvent) {
  return event?.providerMetadata?.cognia?.reasoningSource === "raw-analysis"
}

/**
 * Build a stateful translator. Call `.handle(event)` for each Vercel-AI-SDK
 * event; it returns zero or more SDKMessage objects to emit. Call `.finish(usage?)`
 * once the upstream stream completes to produce the trailing result message.
 *
 * State machine: we accumulate text-delta / reasoning chunks into a single
 * assistant content block and emit a fresh `assistant` message every time the
 * block boundary changes (text → reasoning → tool_use). Each emitted message
 * carries the same `id` until the boundary changes, so the renderer's id-keyed
 * dedup logic replaces the in-progress version with the final one.
 *
 */
export function createEventAdapter(ctx: EventAdapterContext) {
  const startedAt = ctx.startedAt ?? Date.now()
  let messageId: string = randomUUID()
  let activeBlockKind: "text" | "reasoning" | "tool_use" | null = null
  let textBuf = ""
  let reasoningBuf = ""
  let textProviderMetadata: ProviderMetadata | undefined
  let reasoningProviderMetadata: ProviderMetadata | undefined
  let messageMetadata: unknown
  const completedToolUses: EventBlock[] = []
  const streamedToolInputs = new Map<string, { text: string; name: string; input: unknown }>()
  // Provider citations (web-search / url / document sources) accumulated from
  // AI SDK `source`/`source-url`/`source-document` stream parts and projected
  // onto the assistant text block in the Anthropic `citations` shape, so the
  // renderer's existing `extractAnthropicCitations` pipeline surfaces them with
  // no downstream change. Previously these parts had no case and were dropped.
  const sourceCitations: Citation[] = []
  const sourceKeys = new Set<string>()
  let initEmitted = false
  let lastUsage: unknown = null
  // The AI SDK `finishReason` from the closing `finish` event, mapped to an
  // Anthropic-style `stop_reason` on the sealed assistant snapshot so downstream
  // consumers (e.g. the ACP server's turn-end translation) can distinguish a
  // truncated (`max_tokens`) or refused (`refusal`) turn from a clean `end_turn`.
  let lastStopReason: ReturnType<typeof finishReasonToStopReason> = null
  // The messageId a `stream_event` `message_start` was already emitted for. Lets
  // the delta path seed the renderer's in-progress assistant preview exactly once
  // per assistant message (idempotent on the renderer, but avoids redundant
  // frames). Reset whenever `messageId` rotates (turn boundary / tool_use split).
  let streamStartId: string | null = null

  function emitInitIfNeeded(out: TranslatedEvent[]) {
    if (initEmitted) return
    initEmitted = true
    out.push({
      type: "system",
      subtype: "init",
      session_id: ctx.sdkSessionId,
      cwd: undefined,
      tools: [],
      mcp_servers: [],
      model: ctx.model,
      permissionMode: "default",
      apiKeySource: "user",
    })
  }

  function buildToolResultMessage(
    toolCallId: string | undefined,
    content: EventBlock["content"],
    isError: boolean
  ): TranslatedEvent {
    return {
      type: "user",
      session_id: ctx.sdkSessionId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId ?? "",
            content,
            is_error: isError,
          },
        ],
      },
    }
  }

  // The model calls tools by their provider-safe names (`ocr_extract`); the
  // renderer, permission rules and plugin round-trip key on the cognia name
  // (`ocr.extract`), so every name is mapped back through the session's alias
  // table before it leaves the adapter.
  function getToolName(event: AiStreamEvent, fallback = "unknown") {
    const raw =
      typeof event?.toolName === "string"
        ? event.toolName
        : typeof event?.toolCall?.toolName === "string"
          ? event.toolCall.toolName
          : fallback
    return restoreToolName(ctx.toolNameAliases, raw)
  }

  function upsertToolUse(block: EventBlock) {
    const idx = completedToolUses.findIndex((tu) => tu.id === block.id)
    if (idx >= 0) {
      completedToolUses[idx] = block
    } else {
      completedToolUses.push(block)
    }
  }

  /**
   * A tool result closes its tool_use: drop any lingering transient state
   * ("input-streaming" / "approval-requested") so later assistant snapshots
   * don't clobber the renderer's view back to an in-flight look.
   */
  function finalizeToolUseState(id: string | undefined) {
    if (!id) return
    const tu = completedToolUses.find((t) => t.id === id)
    if (tu && tu.state) delete tu.state
  }

  function updateMessageMetadata(metadata: unknown) {
    messageMetadata = mergeMessageMetadata(messageMetadata, metadata)
  }

  /**
   * Clear the per-message content accumulators (text / reasoning / tool_use and
   * their metadata + citations). Shared by `reset()` (turn boundary) and the
   * tool_use→text split below: when a new `messageId` starts a fresh assistant
   * message, the blocks accumulated so far were ALREADY sealed into the previous
   * message via boundary snapshots, so leaving them populated makes the new
   * message's snapshot re-emit all prior text and every prior tool_use under the
   * new id — the duplicate-output regression on multi-step tool turns. Does NOT
   * touch session-scoped state (`messageMetadata`, `lastUsage`, `initEmitted`,
   * `messageId`, `streamStartId`), which the callers manage themselves.
   */
  function clearMessageContent() {
    activeBlockKind = null
    textBuf = ""
    reasoningBuf = ""
    textProviderMetadata = undefined
    reasoningProviderMetadata = undefined
    completedToolUses.length = 0
    streamedToolInputs.clear()
    sourceCitations.length = 0
    sourceKeys.clear()
  }

  // --- Incremental stream frames --------------------------------------------
  // Text / reasoning deltas are emitted as `stream_event` partial-message frames
  // (the same shape the Anthropic `includePartialMessages` path uses) instead of
  // a full assistant snapshot per delta. The renderer's `applyStreamEvent`
  // (`lib/claude/adapter.ts`) seeds an in-progress assistant message on
  // `message_start` and grows it on each `content_block_delta`; a later full
  // `assistant` snapshot (block boundary or `sealAssistant()` at leg end) replaces
  // it by id. This turns the previous O(n²) "re-serialize the whole textBuf per
  // delta" into O(n) — each frame carries only the new chunk.
  function streamEnvelope(streamEvent: NonNullable<TranslatedEvent["event"]>): TranslatedEvent {
    return {
      type: "stream_event",
      session_id: ctx.sdkSessionId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      event: streamEvent,
    }
  }

  /** Emit `message_start` once per assistant messageId (idempotent downstream). */
  function emitStreamStartIfNeeded(out: TranslatedEvent[]) {
    if (streamStartId === messageId) return
    streamStartId = messageId
    out.push(streamEnvelope({ type: "message_start", message: { id: messageId } }))
  }

  /** A `content_block_delta` for a text or thinking chunk. */
  function streamDelta(kind: "text_delta" | "thinking_delta", chunk: string) {
    return streamEnvelope({
      type: "content_block_delta",
      delta:
        kind === "thinking_delta"
          ? { type: "thinking_delta", thinking: chunk }
          : { type: "text_delta", text: chunk },
    })
  }

  function buildAssistantSnapshot(): TranslatedEvent {
    const content: EventBlock[] = []
    // Emit a text block when there is text OR accumulated citations to carry
    // (web search may surface sources alongside the answer text); attach the
    // citations in the Anthropic shape the renderer already understands.
    if (textBuf || sourceCitations.length) {
      const textBlock: EventBlock = { type: "text", text: textBuf }
      if (textProviderMetadata) textBlock.providerMetadata = textProviderMetadata
      if (sourceCitations.length) textBlock.citations = sourceCitations.slice()
      content.push(textBlock)
    }
    if (reasoningBuf) {
      const thinkingBlock: EventBlock = { type: "thinking", thinking: reasoningBuf }
      if (reasoningProviderMetadata) thinkingBlock.providerMetadata = reasoningProviderMetadata
      content.push(thinkingBlock)
    }
    for (const tu of completedToolUses) content.push(tu)
    return {
      type: "assistant",
      session_id: ctx.sdkSessionId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: ctx.model,
        content,
        stop_reason: lastStopReason,
        stop_sequence: null,
        ...(messageMetadata !== undefined ? { metadata: messageMetadata } : {}),
      },
    }
  }

  type EventHandler = (event: AiStreamEvent, out: TranslatedEvent[]) => TranslatedEvent[]
  const handleReasoning: EventHandler = (event, out) => {
    // Raw chain-of-thought is provider-internal state. Provenance-aware
    // middleware marks it before this persistence/rendering boundary.
    if (isRawAnalysis(event)) return out
    if (activeBlockKind === "tool_use") {
      // Same boundary split the text-delta case does: reasoning after a
      // sealed tool_use starts a fresh message. Without it, interleaved-
      // thinking models (tool_use → reasoning → text) accumulate new
      // reasoning/text into the sealed message and every snapshot
      // re-emits all prior tool_uses (the "duplicate output" bug).
      messageId = randomUUID()
      streamStartId = null
      clearMessageContent()
    }
    activeBlockKind = "reasoning"
    const chunk = event.text ?? event.textDelta ?? event.delta ?? ""
    reasoningBuf += chunk
    reasoningProviderMetadata = getProviderMetadata(event) ?? reasoningProviderMetadata
    emitStreamStartIfNeeded(out)
    if (chunk) out.push(streamDelta("thinking_delta", chunk))
    return out
  }
  const handleSource: EventHandler = (event, out) => {
    // Provider citation (web search / url / document). Accumulate in the
    // Anthropic `citations` shape, deduped by url||title, and re-emit the
    // assistant snapshot so the now-cited text block reaches the renderer.
    const cit = sourceToCitation(event)
    if (cit) {
      const key = cit.url || cit.title
      if (key && !sourceKeys.has(key)) {
        sourceKeys.add(key)
        sourceCitations.push(cit)
      }
    }
    out.push(buildAssistantSnapshot())
    return out
  }
  const handlers: Record<string, EventHandler> = {
    start: (event, out) => {
      if (typeof event?.messageId === "string" && event.messageId) {
        messageId = event.messageId
        streamStartId = null
      }
      updateMessageMetadata(event?.messageMetadata)
      return out
    },
    "message-metadata": (event, out) => {
      updateMessageMetadata(event?.messageMetadata)
      return out
    },
    "text-start": (event, out) => {
      textProviderMetadata = getProviderMetadata(event) ?? textProviderMetadata
      return out
    },
    "text-delta": (event, out) => {
      if (activeBlockKind === "tool_use") {
        // Boundary change — start a new message id so the renderer doesn't
        // merge text after a tool_use into the same block, AND clear the
        // already-sealed content buffers so this fresh message doesn't
        // re-emit the prior text + every prior tool_use under the new id.
        messageId = randomUUID()
        streamStartId = null
        clearMessageContent()
      }
      activeBlockKind = "text"
      // v6 high-level fullStream uses `text`; v4 used `textDelta`; the
      // low-level model stream uses `delta`. Accept all three.
      const chunk = event.text ?? event.textDelta ?? event.delta ?? ""
      textBuf += chunk
      textProviderMetadata = getProviderMetadata(event) ?? textProviderMetadata
      emitStreamStartIfNeeded(out)
      if (chunk) out.push(streamDelta("text_delta", chunk))
      return out
    },
    "text-end": (event, out) => {
      textProviderMetadata = getProviderMetadata(event) ?? textProviderMetadata
      return out
    },
    "reasoning-start": (event, out) => {
      if (isRawAnalysis(event)) return out
      reasoningProviderMetadata = getProviderMetadata(event) ?? reasoningProviderMetadata
      return out
    },
    reasoning: handleReasoning,
    "reasoning-delta": handleReasoning,
    "reasoning-end": (event, out) => {
      if (isRawAnalysis(event)) return out
      reasoningProviderMetadata = getProviderMetadata(event) ?? reasoningProviderMetadata
      return out
    },
    "start-step": (event, out) => {
      emitStreamStartIfNeeded(out)
      out.push(streamEnvelope({ type: "step_start" }))
      return out
    },
    "finish-step": (event, out) => {
      out.push(streamEnvelope({ type: "step_finish" }))
      return out
    },
    "tool-input-start": (event, out) => {
      activeBlockKind = "tool_use"
      const id = getToolCallId(event) ?? randomUUID()
      const name = getToolName(event)
      streamedToolInputs.set(id, { text: "", name, input: {} })
      upsertToolUse({
        type: "tool_use",
        id,
        name,
        input: {},
        state: "input-streaming",
        ...getToolMetadata(event),
      })
      out.push(buildAssistantSnapshot())
      return out
    },
    "tool-input-delta": (event, out) => {
      activeBlockKind = "tool_use"
      const id = getToolCallId(event)
      if (!id) return out
      const prior = streamedToolInputs.get(id) ?? { text: "", name: "unknown", input: {} }
      // O(1) accumulation only. The old per-delta `JSON.parse(wholeBuffer)`
      // + full-assistant-snapshot pair was the same O(n²) shape the
      // text-delta path above was cured of — and the mid-stream parse
      // virtually never succeeds (the JSON is incomplete), so every one of
      // those snapshots carried `input: {}` over stdio for nothing. The
      // buffer is parsed exactly once, at tool-input-end (or by the
      // tool-call / tool-input-available finalizers).
      prior.text += event.delta ?? event.inputTextDelta ?? ""
      streamedToolInputs.set(id, prior)
      return out
    },
    "tool-input-end": (event, out) => {
      const id = getToolCallId(event)
      const prior = id ? streamedToolInputs.get(id) : undefined
      if (!prior) return out
      const parsed = tryParseToolInput(prior.text)
      if (parsed !== undefined) prior.input = parsed
      // Input streaming is over — no `state` here, or the block would
      // stay stuck on "input-streaming" (and later snapshots would keep
      // re-asserting it) when the provider never follows up with a
      // tool-call / tool-input-available finalizer.
      upsertToolUse({
        type: "tool_use",
        id,
        name: prior.name,
        input: prior.input ?? {},
        ...getToolMetadata(event),
      })
      out.push(buildAssistantSnapshot())
      return out
    },
    "tool-input-available": (event, out) => {
      activeBlockKind = "tool_use"
      const id = getToolCallId(event) ?? randomUUID()
      upsertToolUse({
        type: "tool_use",
        id,
        name: getToolName(event),
        input: getToolInput(event),
        ...getToolMetadata(event),
      })
      streamedToolInputs.delete(id)
      out.push(buildAssistantSnapshot())
      return out
    },
    "tool-input-error": (event, out) => {
      const message =
        typeof event.errorText === "string" && event.errorText
          ? event.errorText
          : "tool input error"
      out.push(buildToolResultMessage(getToolCallId(event), message, true))
      return out
    },
    "tool-call": (event, out) => {
      activeBlockKind = "tool_use"
      const id = getToolCallId(event) ?? randomUUID()
      const prior = streamedToolInputs.get(id)
      upsertToolUse({
        type: "tool_use",
        id,
        name: getToolName(event, prior?.name ?? "unknown"),
        input: getToolInput(event, prior?.input ?? {}),
        ...getToolMetadata(event),
      })
      streamedToolInputs.delete(id)
      out.push(buildAssistantSnapshot())
      return out
    },
    "tool-approval-request": (event, out) => {
      activeBlockKind = "tool_use"
      const id = getToolCallId(event) ?? randomUUID()
      const prior = completedToolUses.find((tu) => tu.id === id) ?? streamedToolInputs.get(id)
      const approval =
        typeof event.approvalId === "string" && event.approvalId
          ? {
              id: event.approvalId,
              ...(typeof event.signature === "string" && event.signature
                ? { signature: event.signature }
                : {}),
            }
          : undefined
      upsertToolUse({
        type: "tool_use",
        id,
        name: getToolName(event, prior?.name ?? "unknown"),
        input: getToolInput(event, prior?.input ?? {}),
        state: "approval-requested",
        ...getToolMetadata(event),
        ...(approval ? { approval } : {}),
      })
      streamedToolInputs.delete(id)
      out.push(buildAssistantSnapshot())
      return out
    },
    "tool-result": (event, out) => {
      // Mirror the Anthropic SDK shape: tool results arrive as a synthetic
      // user message with `tool_result` content blocks. v6 carries the
      // payload in `output`; v4 used `result`. Image results keep their
      // structured blocks (see `shapeToolResultContent`) so the TUI renders
      // them inline instead of dumping a base64 wall.
      const payload = event.output ?? event.result
      const shaped = shapeToolResultContent(payload)
      const id = getToolCallId(event)
      finalizeToolUseState(id)
      // Use the same tolerant id extraction as the finalizer — a v4/nested
      // shape carrying only `toolCall.toolCallId` previously closed the
      // tool_use state but emitted `tool_use_id: ""` (an orphan result).
      out.push(buildToolResultMessage(id, shaped, Boolean(event.isError)))
      return out
    },
    "tool-error": (event, out) => {
      // v6 surfaces a thrown tool `execute` as a distinct event. Project it
      // as an errored tool_result so the model can recover and the renderer
      // styles it as a failure.
      const err = event.error
      let msg
      if (err instanceof Error) msg = err.message
      else if (typeof err === "string") msg = err
      else {
        try {
          msg = JSON.stringify(err)
        } catch {
          msg = String(err) // circular error object — never throw here
        }
      }
      const errId = getToolCallId(event)
      finalizeToolUseState(errId)
      out.push(buildToolResultMessage(errId, msg, true))
      return out
    },
    "tool-output-available": (event, out) => {
      const payload = event.output ?? event.result
      finalizeToolUseState(getToolCallId(event))
      out.push(buildToolResultMessage(getToolCallId(event), shapeToolResultContent(payload), false))
      return out
    },
    "tool-output-error": (event, out) => {
      const message =
        typeof event.errorText === "string" && event.errorText
          ? event.errorText
          : "tool output error"
      finalizeToolUseState(getToolCallId(event))
      out.push(buildToolResultMessage(getToolCallId(event), message, true))
      return out
    },
    "tool-output-denied": (event, out) => {
      // v6 emits this when an approval gate denies a tool after the model
      // already produced the tool call. Answer the tool_use with an errored
      // tool_result so the renderer closes the call and the model can
      // continue from an explicit denial instead of a dangling invocation.
      const name = typeof event.toolName === "string" && event.toolName ? event.toolName : "tool"
      finalizeToolUseState(getToolCallId(event))
      out.push(buildToolResultMessage(event.toolCallId, `${name} output denied`, true))
      return out
    },
    file: (event, out) => {
      // Generated files are emitted as their own one-shot assistant
      // message (fresh id, never re-emitted) instead of being accumulated
      // into every subsequent snapshot — N files previously cost O(N²)
      // base64 bytes over the sidecar stdio pipe, one full re-embed per
      // file/tool/source event.
      const block = generatedFileToBlock(event)
      if (block) {
        out.push({
          type: "assistant",
          session_id: ctx.sdkSessionId,
          uuid: randomUUID(),
          parent_tool_use_id: null,
          message: {
            id: randomUUID(),
            type: "message",
            role: "assistant",
            model: ctx.model,
            content: [block],
            stop_reason: null,
            stop_sequence: null,
          },
        })
      }
      return out
    },
    source: handleSource,
    "source-url": handleSource,
    "source-document": handleSource,
    finish: (event, out) => {
      lastUsage = event.usage ?? event.totalUsage ?? null
      lastStopReason = finishReasonToStopReason(event?.finishReason)
      updateMessageMetadata(event?.messageMetadata)
      // Don't emit `result` here — `finish` is the closing event of the
      // fullStream; the caller invokes `.finish()` to emit the SDK
      // result message after the loop exits cleanly.
      return out
    },
    error: (event, out) => {
      // Errors are emitted by the dispatcher as a `session_ended` with
      // an error string — adapter doesn't translate them.
      return out
    },
    "reasoning-file": (event, out) => {
      // AI SDK 7 split files referenced inside a model's reasoning trace out
      // of `file` into their own part type. DELIBERATELY DROPPED: raw
      // chain-of-thought artifacts are never rendered or persisted (same
      // policy the `reasoning` parts follow — see the gpt-oss raw-analysis
      // handling). Models normally re-emit anything they actually intend as
      // output as a regular `file` part, so this loses nothing user-visible.
      // Handled explicitly rather than falling through to `default` so the
      // drop is a decision, not an oversight.
      return out
    },
  }

  return {
    /**
     * Clear the per-turn accumulator state so the next turn starts from a clean
     * slate. The adapter is created ONCE per session (it has to be, so the init
     * message is emitted only once), but its content buffers are turn-scoped:
     * without this reset, turn N+1's first `text-delta` appends to turn N's
     * still-populated `textBuf`, so the assistant snapshot re-emits the previous
     * turn's entire reply prepended to the new one — the "duplicate output"
     * regression. `initEmitted` is intentionally NOT reset (init stays a
     * once-per-session message); a fresh `messageId` keeps the renderer's
     * id-keyed dedup from merging the new turn into the old message.
     */
    reset() {
      messageId = randomUUID()
      clearMessageContent()
      messageMetadata = undefined
      lastUsage = null
      lastStopReason = null
      streamStartId = null
    },

    /**
     * Emit the canonical full `assistant` snapshot for the current in-progress
     * block, sealing the `stream_event` deltas streamed since the last boundary.
     * Text / reasoning deltas no longer each emit a full snapshot, so the leg's
     * final assistant message would otherwise never reach the renderer as a
     * replace-by-id canonical. The caller invokes this once per agent-loop leg
     * (after the leg's `fullStream` drains) and after any post-loop text append.
     * Returns `[]` when there's nothing buffered (a leg that emitted only
     * tool-results, whose boundary snapshots already sealed the content).
     *
     */
    sealAssistant() {
      if (
        !textBuf &&
        !reasoningBuf &&
        completedToolUses.length === 0 &&
        sourceCitations.length === 0
      ) {
        return []
      }
      return [buildAssistantSnapshot()]
    },

    /**
     * Update the model the adapter tags subsequent assistant snapshots with —
     * used when the renderer live-switches the model mid-session (ai-sdk path).
     * The one-time `system`/`init` message keeps the session's original model;
     * only `assistant` snapshots produced from here on reflect the new model.
     * A non-string / empty value is ignored so a bad control can't blank it.
     *
     */
    setModel(nextModel: unknown) {
      if (typeof nextModel === "string" && nextModel) ctx.model = nextModel
    },

    handle(value: unknown) {
      const event = value as AiStreamEvent
      const out: TranslatedEvent[] = []
      emitInitIfNeeded(out)

      const handler =
        event?.type && Object.hasOwn(handlers, event.type) ? handlers[event.type] : undefined
      return handler ? handler(event, out) : out
    },

    /**
     * Called once the upstream stream has completed cleanly. Produces the
     * trailing `result` SDKMessage with usage / cost / duration so the
     * renderer can attach metadata to the final assistant message.
     *
     */
    finish(info?: { totalCostUsd?: number; usage?: unknown }) {
      const out: TranslatedEvent[] = []
      emitInitIfNeeded(out)
      const usage = info?.usage ?? lastUsage ?? {}
      const result = {
        type: "result",
        subtype: "success",
        session_id: ctx.sdkSessionId,
        is_error: false,
        duration_ms: Date.now() - startedAt,
        duration_api_ms: Date.now() - startedAt,
        num_turns: 1,
        total_cost_usd: info?.totalCostUsd ?? 0,
        // Alias normalization lives in one place (mirrored at
        // `lib/ai/chat/usage-normalize.ts`, pinned by a parity test) so a new
        // provider field reaches every consumer instead of one of three copies.
        usage: normalizeUsageBlock(usage),
      }
      out.push(result)
      return out
    },
  }
}
