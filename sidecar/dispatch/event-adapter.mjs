// Translate Vercel AI SDK stream events into the SDKMessage shapes that
// `lib/claude/adapter.ts` consumes. Keeping this in one module is the core
// of the multi-provider port — everything downstream of the sidecar stays
// unchanged because the wire shape is preserved.
//
// Vercel AI SDK events we care about (subset of `result.fullStream`):
//   { type: "text-delta", textDelta: string }
//   { type: "reasoning", textDelta: string }     // o1/o3 / claude thinking
//   { type: "tool-call", toolCallId, toolName, args }
//   { type: "tool-result", toolCallId, result }
//   { type: "finish", finishReason, usage: { promptTokens, completionTokens, totalTokens } }
//   { type: "error", error }
//
// SDKMessage shapes we emit (mirrors @anthropic-ai/claude-agent-sdk):
//   { type: "system", subtype: "init", session_id, ... }   — emitted once at start
//   { type: "assistant", message: { id, content: BetaContentBlock[] }, session_id, uuid }
//   { type: "result", subtype, session_id, usage, total_cost_usd, duration_ms, num_turns }

import { randomUUID } from "node:crypto"

/**
 * Shape a tool-result payload for the renderer's `tool_result` content block.
 *
 * Text/plugin results stay a plain string (unchanged behavior). But an image
 * result (the built-in `read` on an image file returns an MCP `CallToolResult`,
 * `{ content:[{ type:'image', data, mimeType }, …] }`) must NOT be JSON-
 * stringified — that buries a multi-KB base64 blob in the transcript and hides
 * it from the TUI's image extractor (`cli/.../format/result-images.ts`), which
 * needs the structured blocks to render the picture inline and elide the base64.
 * So when image blocks are present we forward the MCP content array verbatim
 * (the extractor already understands the `{ type:'image', data, mimeType }`
 * shape, matching the Anthropic path which also delivers array content).
 *
 * @param {unknown} payload
 * @returns {string | Array<any>}
 */
export function shapeToolResultContent(payload) {
  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray(/** @type {any} */ (payload).content) &&
    /** @type {any} */ (payload).content.some(
      (b) => b && b.type === "image" && typeof b.data === "string"
    )
  ) {
    return /** @type {any} */ (payload).content
  }
  return typeof payload === "string" ? payload : JSON.stringify(payload)
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
 * @param {{
 *   sessionId: string,
 *   sdkSessionId: string,
 *   model?: string,
 *   provider: string,
 *   startedAt?: number,
 * }} ctx
 */
export function createEventAdapter(ctx) {
  const startedAt = ctx.startedAt ?? Date.now()
  let messageId = randomUUID()
  /** @type {"text"|"reasoning"|"tool_use"|null} */
  let activeBlockKind = null
  /** @type {string} */
  let textBuf = ""
  /** @type {string} */
  let reasoningBuf = ""
  /** @type {Array<{ type: "tool_use", id: string, name: string, input: any }>} */
  const completedToolUses = []
  // Provider citations (web-search / url / document sources) accumulated from
  // AI SDK `source`/`source-url`/`source-document` stream parts and projected
  // onto the assistant text block in the Anthropic `citations` shape, so the
  // renderer's existing `extractAnthropicCitations` pipeline surfaces them with
  // no downstream change. Previously these parts had no case and were dropped.
  /** @type {Array<{ type: string, url?: string, title?: string }>} */
  const sourceCitations = []
  const sourceKeys = new Set()
  let initEmitted = false
  let lastUsage = null
  // The messageId a `stream_event` `message_start` was already emitted for. Lets
  // the delta path seed the renderer's in-progress assistant preview exactly once
  // per assistant message (idempotent on the renderer, but avoids redundant
  // frames). Reset whenever `messageId` rotates (turn boundary / tool_use split).
  let streamStartId = null

  /**
   * Convert an AI SDK source stream part into an Anthropic-shaped citation.
   * Handles v6 `source-url`/`source-document` and the older
   * `source` + `sourceType` form. Returns null when there's nothing citable.
   */
  function sourceToCitation(event) {
    const isUrl =
      event.type === "source-url" || (event.type === "source" && event.sourceType === "url")
    const isDoc =
      event.type === "source-document" ||
      (event.type === "source" && event.sourceType === "document")
    const title =
      typeof event.title === "string" && event.title
        ? event.title
        : typeof event.filename === "string" && event.filename
          ? event.filename
          : undefined
    if (isUrl || (!isDoc && typeof event.url === "string")) {
      const url = typeof event.url === "string" ? event.url : undefined
      if (!url && !title) return null
      return { type: "url_citation", url, title: title ?? url }
    }
    if (isDoc) {
      if (!title) return null
      return { type: "document", document_title: title, title }
    }
    return null
  }

  function emitInitIfNeeded(out) {
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

  function buildToolResultMessage(toolCallId, content, isError) {
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

  // --- Incremental stream frames --------------------------------------------
  // Text / reasoning deltas are emitted as `stream_event` partial-message frames
  // (the same shape the Anthropic `includePartialMessages` path uses) instead of
  // a full assistant snapshot per delta. The renderer's `applyStreamEvent`
  // (`lib/claude/adapter.ts`) seeds an in-progress assistant message on
  // `message_start` and grows it on each `content_block_delta`; a later full
  // `assistant` snapshot (block boundary or `sealAssistant()` at leg end) replaces
  // it by id. This turns the previous O(n²) "re-serialize the whole textBuf per
  // delta" into O(n) — each frame carries only the new chunk.
  function streamEnvelope(streamEvent) {
    return {
      type: "stream_event",
      session_id: ctx.sdkSessionId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      event: streamEvent,
    }
  }

  /** Emit `message_start` once per assistant messageId (idempotent downstream). */
  function emitStreamStartIfNeeded(out) {
    if (streamStartId === messageId) return
    streamStartId = messageId
    out.push(streamEnvelope({ type: "message_start", message: { id: messageId } }))
  }

  /** A `content_block_delta` for a text or thinking chunk. */
  function streamDelta(kind, chunk) {
    return streamEnvelope({
      type: "content_block_delta",
      delta:
        kind === "thinking_delta"
          ? { type: "thinking_delta", thinking: chunk }
          : { type: "text_delta", text: chunk },
    })
  }

  function buildAssistantSnapshot() {
    const content = []
    // Emit a text block when there is text OR accumulated citations to carry
    // (web search may surface sources alongside the answer text); attach the
    // citations in the Anthropic shape the renderer already understands.
    if (textBuf || sourceCitations.length) {
      const textBlock = { type: "text", text: textBuf }
      if (sourceCitations.length) textBlock.citations = sourceCitations.slice()
      content.push(textBlock)
    }
    if (reasoningBuf) content.push({ type: "thinking", thinking: reasoningBuf })
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
        stop_reason: null,
        stop_sequence: null,
      },
    }
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
      activeBlockKind = null
      textBuf = ""
      reasoningBuf = ""
      completedToolUses.length = 0
      sourceCitations.length = 0
      sourceKeys.clear()
      lastUsage = null
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
     * @returns {Array<any>}
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
     * @param {string} nextModel
     */
    setModel(nextModel) {
      if (typeof nextModel === "string" && nextModel) ctx.model = nextModel
    },

    /**
     * @param {any} event
     * @returns {Array<any>}
     */
    handle(event) {
      const out = []
      emitInitIfNeeded(out)

      switch (event?.type) {
        case "text-delta": {
          if (activeBlockKind === "tool_use") {
            // Boundary change — start a new message id so the renderer
            // doesn't merge text after a tool_use into the same block.
            messageId = randomUUID()
            streamStartId = null
          }
          activeBlockKind = "text"
          // v6 high-level fullStream uses `text`; v4 used `textDelta`; the
          // low-level model stream uses `delta`. Accept all three.
          const chunk = event.text ?? event.textDelta ?? event.delta ?? ""
          textBuf += chunk
          emitStreamStartIfNeeded(out)
          if (chunk) out.push(streamDelta("text_delta", chunk))
          return out
        }
        case "reasoning":
        case "reasoning-delta": {
          activeBlockKind = "reasoning"
          const chunk = event.text ?? event.textDelta ?? event.delta ?? ""
          reasoningBuf += chunk
          emitStreamStartIfNeeded(out)
          if (chunk) out.push(streamDelta("thinking_delta", chunk))
          return out
        }
        case "tool-call": {
          activeBlockKind = "tool_use"
          completedToolUses.push({
            type: "tool_use",
            id: event.toolCallId ?? randomUUID(),
            name: event.toolName ?? "unknown",
            input: event.args ?? event.input ?? {},
          })
          out.push(buildAssistantSnapshot())
          return out
        }
        case "tool-result": {
          // Mirror the Anthropic SDK shape: tool results arrive as a synthetic
          // user message with `tool_result` content blocks. v6 carries the
          // payload in `output`; v4 used `result`. Image results keep their
          // structured blocks (see `shapeToolResultContent`) so the TUI renders
          // them inline instead of dumping a base64 wall.
          const payload = event.output ?? event.result
          const shaped = shapeToolResultContent(payload)
          out.push(buildToolResultMessage(event.toolCallId, shaped, Boolean(event.isError)))
          return out
        }
        case "tool-error": {
          // v6 surfaces a thrown tool `execute` as a distinct event. Project it
          // as an errored tool_result so the model can recover and the renderer
          // styles it as a failure.
          const err = event.error
          const msg =
            err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err)
          out.push(buildToolResultMessage(event.toolCallId, msg, true))
          return out
        }
        case "source":
        case "source-url":
        case "source-document": {
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
        case "finish": {
          lastUsage = event.usage ?? null
          // Don't emit `result` here — `finish` is the closing event of the
          // fullStream; the caller invokes `.finish()` to emit the SDK
          // result message after the loop exits cleanly.
          return out
        }
        case "error": {
          // Errors are emitted by the dispatcher as a `session_ended` with
          // an error string — adapter doesn't translate them.
          return out
        }
        default:
          return out
      }
    },

    /**
     * Called once the upstream stream has completed cleanly. Produces the
     * trailing `result` SDKMessage with usage / cost / duration so the
     * renderer can attach metadata to the final assistant message.
     *
     * @param {{ totalCostUsd?: number, usage?: any } | undefined} info
     * @returns {Array<any>}
     */
    finish(info) {
      const out = []
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
        usage: {
          input_tokens: usage.promptTokens ?? usage.inputTokens ?? 0,
          output_tokens: usage.completionTokens ?? usage.outputTokens ?? 0,
          // Window-prompt size (last agent-loop leg) when it differs from the
          // summed `input_tokens`; lets the renderer report true context-window
          // occupancy instead of the cumulative-billing total. Omitted (0) on
          // single-leg turns where the two coincide.
          ...(typeof usage.contextInputTokens === "number"
            ? { context_input_tokens: usage.contextInputTokens }
            : {}),
          cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
          // Cache-read candidates, most-normalized first: AI SDK v6 maps
          // OpenAI-compatible `prompt_tokens_details.cached_tokens` to
          // `cachedInputTokens`; DeepSeek additionally reports raw
          // `prompt_cache_hit_tokens` (their context-caching-on-disk hit
          // counter). Surfacing these makes per-turn cache hit rate
          // observable for every openai-protocol provider.
          cache_read_input_tokens:
            usage.cacheReadInputTokens ??
            usage.cachedInputTokens ??
            usage.prompt_cache_hit_tokens ??
            usage.promptCacheHitTokens ??
            0,
          // Reasoning / "thinking" tokens, when the provider breaks them out
          // (AI SDK v6 surfaces `reasoningTokens` for OpenAI o-series/gpt-5,
          // DeepSeek-reasoner, …). A SUBSET of output_tokens — already billed
          // at the output rate — surfaced for observability. 0 when absent.
          reasoning_tokens: usage.reasoningTokens ?? usage.reasoning_tokens ?? 0,
        },
      }
      out.push(result)
      return out
    },
  }
}
