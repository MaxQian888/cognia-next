// Translate Vercel AI SDK stream events into the SDKMessage shapes that
// `lib/claude/adapter.ts` (`applySdkEvent`) consumes. This is the renderer-side
// TypeScript port of `sidecar/dispatch/event-adapter.mjs`: the standalone
// (BYOK) mobile chat engine runs `streamText` in the webview and feeds its
// `fullStream` events through this mapper, so every downstream consumer — the
// chat store, message renderer, usage accounting — stays unchanged because the
// emitted wire shape is identical to the sidecar's.
//
// The only substantive change vs the `.mjs` is the id source: `node:crypto`
// `randomUUID` → the WebCrypto `crypto.randomUUID` available in the webview.
// Keep this file behaviourally in lockstep with `event-adapter.mjs`.
//
// Vercel AI SDK `result.fullStream` events we care about (subset):
//   { type: "text-delta", text|textDelta|delta: string }
//   { type: "reasoning" | "reasoning-delta", text|textDelta|delta: string }
//   { type: "file", file: GeneratedFile }
//   { type: "tool-input-start"|"tool-input-delta"|"tool-input-end", id, ... }
//   { type: "tool-call", toolCallId, toolName, args|input }
//   { type: "tool-result", toolCallId, output|result }
//   { type: "tool-error", toolCallId, error }
//   { type: "source" | "source-url" | "source-document", url?, title?, ... }
//   { type: "finish", usage|totalUsage: { promptTokens, completionTokens, inputTokens, ... } }
//
// SDKMessage shapes we emit (mirrors @anthropic-ai/claude-agent-sdk):
//   { type: "system", subtype: "init", session_id, ... }   — emitted once at start
//   { type: "assistant", message: { id, content: BetaContentBlock[] }, session_id, uuid }
//   { type: "user", message: { content: [{ type: "tool_result", ... }] }, ... }
//   { type: "result", subtype, session_id, usage, total_cost_usd, duration_ms, num_turns }

import type { SDKMessage } from "@cognia/agent-config-types"
import { normalizeUsageBlock } from "./usage-normalize"

const randomUUID = (): string => globalThis.crypto.randomUUID()

/** Loose shape of an AI SDK fullStream part — every field optional/version-tolerant. */
interface AiSdkStreamPart {
  type?: string
  id?: string
  messageId?: string
  messageMetadata?: unknown
  approvalId?: string
  signature?: string
  text?: string
  textDelta?: string
  delta?: string
  toolCallId?: string
  toolName?: string
  toolCall?: {
    toolCallId?: string
    toolName?: string
    args?: unknown
    input?: unknown
    providerExecuted?: boolean
    providerMetadata?: Record<string, Record<string, unknown>>
    toolMetadata?: Record<string, unknown>
    dynamic?: boolean
    title?: string
    invalid?: boolean
    error?: unknown
  }
  inputTextDelta?: string
  args?: unknown
  input?: unknown
  providerExecuted?: boolean
  providerMetadata?: Record<string, Record<string, unknown>>
  toolMetadata?: Record<string, unknown>
  dynamic?: boolean
  title?: string
  invalid?: boolean
  output?: unknown
  result?: unknown
  errorText?: string
  isError?: boolean
  error?: unknown
  file?: { base64?: unknown; mediaType?: unknown }
  data?: string
  mediaType?: string
  url?: string
  filename?: string
  sourceType?: string
  usage?: AiSdkUsage
  totalUsage?: AiSdkUsage
}

type ProviderMetadata = Record<string, Record<string, unknown>>

function isRawAnalysis(event: AiSdkStreamPart): boolean {
  return event.providerMetadata?.cognia?.reasoningSource === "raw-analysis"
}

/** Usage surfaced by AI SDK v4/v6 (and openai-compatible providers). */
interface AiSdkUsage {
  promptTokens?: number
  completionTokens?: number
  inputTokens?: number
  outputTokens?: number
  contextInputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  cachedInputTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  prompt_cache_hit_tokens?: number
  promptCacheHitTokens?: number
  reasoningTokens?: number
  reasoning_tokens?: number
  outputTokenDetails?: {
    textTokens?: number
    reasoningTokens?: number
  }
}

type Citation =
  | { type: "url_citation"; url?: string; title?: string }
  | { type: "document"; document_title: string; title: string }

interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: unknown
  state?: "input-streaming" | "approval-requested"
  approval?: { id: string; signature?: string }
  providerExecuted?: boolean
  providerMetadata?: Record<string, Record<string, unknown>>
  toolMetadata?: Record<string, unknown>
  dynamic?: boolean
  title?: string
  invalid?: boolean
  error?: unknown
}

interface GeneratedFileBlock {
  type: "file"
  source?: { type: "base64"; media_type: string; data: string }
  url?: string
  media_type?: string
  filename?: string
}

export interface SdkEventMapperContext {
  sessionId: string
  sdkSessionId: string
  model?: string
  provider: string
  startedAt?: number
}

export interface SdkEventMapper {
  /** Reset per-turn accumulator state; call at the head of every turn/leg. */
  reset(): void
  /** Update the model tagged on subsequent assistant snapshots. */
  setModel(model: string): void
  /** Translate one AI SDK fullStream event into zero or more SDKMessages. */
  handle(event: unknown): SDKMessage[]
  /** Emit the canonical full `assistant` snapshot sealing the streamed deltas. */
  sealAssistant(): SDKMessage[]
  /** Emit the trailing `result` SDKMessage once the stream completes cleanly. */
  finish(info?: { totalCostUsd?: number; usage?: AiSdkUsage }): SDKMessage[]
}

/**
 * Shape a tool-result payload for the renderer's `tool_result` content block.
 *
 * Text/plugin results stay a plain string. An image result (e.g. the built-in
 * `read` on an image returns an MCP `CallToolResult` `{ content:[{ type:'image',
 * data, mimeType }] }`) is forwarded verbatim so the renderer can show it inline
 * instead of JSON-stringifying a base64 wall.
 */
export function shapeToolResultContent(payload: unknown): string | unknown[] {
  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { content?: unknown }).content) &&
    (payload as { content: Array<{ type?: string; data?: unknown }> }).content.some(
      (b) => b && b.type === "image" && typeof b.data === "string"
    )
  ) {
    return (payload as { content: unknown[] }).content
  }
  return typeof payload === "string" ? payload : JSON.stringify(payload)
}

function isMergeableMetadataObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp)
  )
}

function mergeMessageMetadata(base: unknown, overrides: unknown): unknown {
  if (overrides == null) return base
  if (!isMergeableMetadataObject(base) || !isMergeableMetadataObject(overrides)) return overrides

  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(overrides)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue

    const overrideValue = overrides[key]
    if (overrideValue === undefined) continue

    const baseValue = base[key]
    result[key] =
      isMergeableMetadataObject(baseValue) && isMergeableMetadataObject(overrideValue)
        ? mergeMessageMetadata(baseValue, overrideValue)
        : overrideValue
  }
  return result
}

/**
 * Build a stateful translator. Call `.handle(event)` for each AI SDK fullStream
 * event; it returns zero or more SDKMessages to emit. Call `.finish(info?)` once
 * the upstream stream completes to produce the trailing result message.
 *
 * State machine: accumulate text-delta / reasoning chunks into a single assistant
 * content block and emit a fresh `assistant` snapshot every time the block
 * boundary changes (text → reasoning → tool_use). Each emitted snapshot carries
 * the same `id` until the boundary changes, so the renderer's id-keyed dedup
 * replaces the in-progress version with the final one.
 */
export function createSdkEventMapper(ctx: SdkEventMapperContext): SdkEventMapper {
  const startedAt = ctx.startedAt ?? Date.now()
  let messageId = randomUUID()
  let activeBlockKind: "text" | "reasoning" | "tool_use" | null = null
  let textBuf = ""
  let reasoningBuf = ""
  let textProviderMetadata: ProviderMetadata | undefined
  let reasoningProviderMetadata: ProviderMetadata | undefined
  let messageMetadata: unknown
  const completedToolUses: ToolUseBlock[] = []
  const streamedToolInputs = new Map<string, { text: string; name: string; input: unknown }>()
  // Provider citations (web-search / url / document) accumulated from AI SDK
  // `source*` parts and projected onto the assistant text block in the Anthropic
  // `citations` shape, so the renderer's existing `extractAnthropicCitations`
  // pipeline surfaces them with no downstream change.
  const sourceCitations: Citation[] = []
  const sourceKeys = new Set<string>()
  let initEmitted = false
  let lastUsage: AiSdkUsage | null = null
  // The messageId a `stream_event` `message_start` was already emitted for — the
  // delta path seeds the renderer's in-progress preview once per assistant
  // message. Reset whenever `messageId` rotates.
  let streamStartId: string | null = null

  function sourceToCitation(event: AiSdkStreamPart): Citation | null {
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

  function emitInitIfNeeded(out: SDKMessage[]): void {
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
    } as unknown as SDKMessage)
  }

  function buildToolResultMessage(
    toolCallId: string | undefined,
    content: string | unknown[],
    isError: boolean
  ): SDKMessage {
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
    } as unknown as SDKMessage
  }

  function generatedFileToBlock(event: AiSdkStreamPart): GeneratedFileBlock | null {
    if (typeof event.url === "string" && event.url && typeof event.mediaType === "string") {
      return { type: "file", url: event.url, media_type: event.mediaType }
    }
    const base64 =
      typeof event.file?.base64 === "string"
        ? event.file.base64
        : typeof event.data === "string"
          ? event.data
          : undefined
    const mediaType =
      typeof event.file?.mediaType === "string"
        ? event.file.mediaType
        : typeof event.mediaType === "string"
          ? event.mediaType
          : undefined
    if (!base64 || !mediaType) return null
    return {
      type: "file",
      source: { type: "base64", media_type: mediaType, data: base64 },
      ...(typeof event.filename === "string" && event.filename ? { filename: event.filename } : {}),
    }
  }

  function getToolCallId(event: AiSdkStreamPart): string | undefined {
    return typeof event.toolCallId === "string"
      ? event.toolCallId
      : typeof event.id === "string"
        ? event.id
        : typeof event.toolCall?.toolCallId === "string"
          ? event.toolCall.toolCallId
          : undefined
  }

  function getToolName(event: AiSdkStreamPart, fallback = "unknown"): string {
    return typeof event.toolName === "string"
      ? event.toolName
      : typeof event.toolCall?.toolName === "string"
        ? event.toolCall.toolName
        : fallback
  }

  function getToolInput(event: AiSdkStreamPart, fallback: unknown = {}): unknown {
    return event.args ?? event.input ?? event.toolCall?.args ?? event.toolCall?.input ?? fallback
  }

  function getToolMetadata(event: AiSdkStreamPart): Partial<ToolUseBlock> {
    const metadata: Partial<ToolUseBlock> = {}
    const toolCall = event.toolCall
    const providerExecuted =
      typeof event.providerExecuted === "boolean"
        ? event.providerExecuted
        : typeof toolCall?.providerExecuted === "boolean"
          ? toolCall.providerExecuted
          : undefined
    if (typeof providerExecuted === "boolean") metadata.providerExecuted = providerExecuted
    const providerMetadata =
      event.providerMetadata && typeof event.providerMetadata === "object"
        ? event.providerMetadata
        : toolCall?.providerMetadata && typeof toolCall.providerMetadata === "object"
          ? toolCall.providerMetadata
          : undefined
    if (providerMetadata) {
      metadata.providerMetadata = providerMetadata
    }
    const toolMetadata =
      event.toolMetadata && typeof event.toolMetadata === "object"
        ? event.toolMetadata
        : toolCall?.toolMetadata && typeof toolCall.toolMetadata === "object"
          ? toolCall.toolMetadata
          : undefined
    if (toolMetadata) {
      metadata.toolMetadata = toolMetadata
    }
    const dynamic =
      typeof event.dynamic === "boolean"
        ? event.dynamic
        : typeof toolCall?.dynamic === "boolean"
          ? toolCall.dynamic
          : undefined
    if (typeof dynamic === "boolean") metadata.dynamic = dynamic
    const title = typeof event.title === "string" ? event.title : toolCall?.title
    if (typeof title === "string") metadata.title = title
    const invalid =
      typeof event.invalid === "boolean"
        ? event.invalid
        : typeof toolCall?.invalid === "boolean"
          ? toolCall.invalid
          : undefined
    if (typeof invalid === "boolean") metadata.invalid = invalid
    if ("error" in event && event.error !== undefined) metadata.error = event.error
    else if (toolCall && "error" in toolCall && toolCall.error !== undefined) {
      metadata.error = toolCall.error
    }
    return metadata
  }

  function getProviderMetadata(event: AiSdkStreamPart): ProviderMetadata | undefined {
    return event.providerMetadata && typeof event.providerMetadata === "object"
      ? event.providerMetadata
      : undefined
  }

  function tryParseToolInput(text: string): unknown | undefined {
    if (!text.trim()) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  }

  function upsertToolUse(block: ToolUseBlock): void {
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
  function finalizeToolUseState(id: string | undefined): void {
    if (!id) return
    const tu = completedToolUses.find((t) => t.id === id)
    if (tu && tu.state) delete tu.state
  }

  function updateMessageMetadata(metadata: unknown): void {
    messageMetadata = mergeMessageMetadata(messageMetadata, metadata)
  }

  // --- Incremental stream frames --------------------------------------------
  // Text / reasoning deltas emit `stream_event` partial-message frames (the same
  // shape the Anthropic `includePartialMessages` path uses) rather than a full
  // assistant snapshot per delta. The renderer's `applyStreamEvent` seeds an
  // in-progress assistant message on `message_start` and grows it per
  // `content_block_delta`; a later full `assistant` snapshot (block boundary or
  // `sealAssistant()`) replaces it by id. O(n²) → O(n). Kept behaviourally in
  // lockstep with `sidecar/dispatch/event-adapter.mjs`.
  function streamEnvelope(streamEvent: Record<string, unknown>): SDKMessage {
    return {
      type: "stream_event",
      session_id: ctx.sdkSessionId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      event: streamEvent,
    } as unknown as SDKMessage
  }

  function emitStreamStartIfNeeded(out: SDKMessage[]): void {
    if (streamStartId === messageId) return
    streamStartId = messageId
    out.push(streamEnvelope({ type: "message_start", message: { id: messageId } }))
  }

  function streamDelta(kind: "text_delta" | "thinking_delta", chunk: string): SDKMessage {
    return streamEnvelope({
      type: "content_block_delta",
      delta:
        kind === "thinking_delta"
          ? { type: "thinking_delta", thinking: chunk }
          : { type: "text_delta", text: chunk },
    })
  }

  function buildAssistantSnapshot(): SDKMessage {
    const content: Array<Record<string, unknown>> = []
    // Emit a text block when there is text OR accumulated citations to carry.
    if (textBuf || sourceCitations.length) {
      const textBlock: Record<string, unknown> = { type: "text", text: textBuf }
      if (textProviderMetadata) textBlock.providerMetadata = textProviderMetadata
      if (sourceCitations.length) textBlock.citations = sourceCitations.slice()
      content.push(textBlock)
    }
    if (reasoningBuf) {
      const thinkingBlock: Record<string, unknown> = { type: "thinking", thinking: reasoningBuf }
      if (reasoningProviderMetadata) thinkingBlock.providerMetadata = reasoningProviderMetadata
      content.push(thinkingBlock)
    }
    for (const tu of completedToolUses) content.push(tu as unknown as Record<string, unknown>)
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
        ...(messageMetadata !== undefined ? { metadata: messageMetadata } : {}),
      },
    } as unknown as SDKMessage
  }

  return {
    /**
     * Clear per-turn accumulator state so the next turn starts clean. The mapper
     * may be created once per session; its content buffers are turn-scoped.
     * Without this reset, turn N+1's first `text-delta` appends to turn N's still
     * populated `textBuf`, so the assistant snapshot re-emits the previous turn's
     * reply prepended to the new one — the "duplicate output" regression. A fresh
     * `messageId` keeps the renderer's id-keyed dedup from merging the new turn
     * into the old message. `initEmitted` is intentionally NOT reset.
     */
    reset(): void {
      messageId = randomUUID()
      activeBlockKind = null
      textBuf = ""
      reasoningBuf = ""
      textProviderMetadata = undefined
      reasoningProviderMetadata = undefined
      messageMetadata = undefined
      completedToolUses.length = 0
      streamedToolInputs.clear()
      sourceCitations.length = 0
      sourceKeys.clear()
      lastUsage = null
      streamStartId = null
    },

    setModel(nextModel: string): void {
      if (typeof nextModel === "string" && nextModel) ctx.model = nextModel
    },

    /**
     * Emit the canonical full `assistant` snapshot sealing the `stream_event`
     * deltas streamed since the last boundary. The caller invokes this after the
     * `fullStream` drains (and after any post-loop text append) so the final
     * assistant message reaches the renderer as a replace-by-id canonical.
     * Returns `[]` when nothing is buffered. Lockstep with `event-adapter.mjs`.
     */
    sealAssistant(): SDKMessage[] {
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

    handle(rawEvent: unknown): SDKMessage[] {
      const event = (rawEvent ?? {}) as AiSdkStreamPart
      const out: SDKMessage[] = []
      emitInitIfNeeded(out)

      switch (event.type) {
        case "start": {
          if (typeof event.messageId === "string" && event.messageId) {
            messageId = event.messageId
            streamStartId = null
          }
          updateMessageMetadata(event.messageMetadata)
          return out
        }
        case "message-metadata": {
          updateMessageMetadata(event.messageMetadata)
          return out
        }
        case "text-start": {
          textProviderMetadata = getProviderMetadata(event) ?? textProviderMetadata
          return out
        }
        case "text-delta": {
          if (activeBlockKind === "tool_use") {
            // Boundary change — start a new message id so the renderer doesn't
            // merge text after a tool_use into the same block.
            messageId = randomUUID()
            streamStartId = null
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
        }
        case "text-end": {
          textProviderMetadata = getProviderMetadata(event) ?? textProviderMetadata
          return out
        }
        case "reasoning-start": {
          if (isRawAnalysis(event)) return out
          reasoningProviderMetadata = getProviderMetadata(event) ?? reasoningProviderMetadata
          return out
        }
        case "reasoning":
        case "reasoning-delta": {
          // Raw chain-of-thought is provider-internal state. Provenance-aware
          // middleware marks it before this persistence/rendering boundary.
          if (isRawAnalysis(event)) return out
          activeBlockKind = "reasoning"
          const chunk = event.text ?? event.textDelta ?? event.delta ?? ""
          reasoningBuf += chunk
          reasoningProviderMetadata = getProviderMetadata(event) ?? reasoningProviderMetadata
          emitStreamStartIfNeeded(out)
          if (chunk) out.push(streamDelta("thinking_delta", chunk))
          return out
        }
        case "reasoning-end": {
          if (isRawAnalysis(event)) return out
          reasoningProviderMetadata = getProviderMetadata(event) ?? reasoningProviderMetadata
          return out
        }
        case "start-step": {
          emitStreamStartIfNeeded(out)
          out.push(streamEnvelope({ type: "step_start" }))
          return out
        }
        case "finish-step": {
          out.push(streamEnvelope({ type: "step_finish" }))
          return out
        }
        case "tool-input-start": {
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
        }
        case "tool-input-delta": {
          activeBlockKind = "tool_use"
          const id = getToolCallId(event)
          if (!id) return out
          const prior = streamedToolInputs.get(id) ?? { text: "", name: "unknown", input: {} }
          // O(1) accumulation only — no whole-buffer re-parse and no full
          // assistant snapshot per chunk (mirrors the event-adapter.mjs O(n²)
          // fix; mid-stream parses virtually never succeed, so the per-delta
          // snapshots all carried `input: {}`). Parsed once at tool-input-end.
          prior.text += event.delta ?? event.inputTextDelta ?? ""
          streamedToolInputs.set(id, prior)
          return out
        }
        case "tool-input-end": {
          const id = getToolCallId(event)
          const prior = id ? streamedToolInputs.get(id) : undefined
          if (!id || !prior) return out
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
        }
        case "tool-input-available": {
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
        }
        case "tool-input-error": {
          const message =
            typeof event.errorText === "string" && event.errorText
              ? event.errorText
              : "tool input error"
          out.push(buildToolResultMessage(getToolCallId(event), message, true))
          return out
        }
        case "tool-call": {
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
        }
        case "tool-approval-request": {
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
        }
        case "tool-result": {
          // Tool results arrive as a synthetic user message with `tool_result`
          // blocks. v6 carries the payload in `output`; v4 used `result`.
          const payload = event.output ?? event.result
          const shaped = shapeToolResultContent(payload)
          finalizeToolUseState(getToolCallId(event))
          out.push(buildToolResultMessage(event.toolCallId, shaped, Boolean(event.isError)))
          return out
        }
        case "tool-error": {
          const err = event.error
          const msg =
            err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err)
          finalizeToolUseState(getToolCallId(event))
          out.push(buildToolResultMessage(event.toolCallId, msg, true))
          return out
        }
        case "tool-output-available": {
          const payload = event.output ?? event.result
          finalizeToolUseState(getToolCallId(event))
          out.push(
            buildToolResultMessage(getToolCallId(event), shapeToolResultContent(payload), false)
          )
          return out
        }
        case "tool-output-error": {
          const message =
            typeof event.errorText === "string" && event.errorText
              ? event.errorText
              : "tool output error"
          finalizeToolUseState(getToolCallId(event))
          out.push(buildToolResultMessage(getToolCallId(event), message, true))
          return out
        }
        case "tool-output-denied": {
          const name =
            typeof event.toolName === "string" && event.toolName ? event.toolName : "tool"
          finalizeToolUseState(getToolCallId(event))
          out.push(buildToolResultMessage(event.toolCallId, `${name} output denied`, true))
          return out
        }
        case "file": {
          // Generated files are emitted as their own one-shot assistant message
          // (fresh id, never re-emitted) instead of being accumulated into every
          // subsequent snapshot — N files previously cost O(N²) base64 bytes,
          // one full re-embed per file/tool/source event. Lockstep with
          // `sidecar/dispatch/event-adapter.mjs`.
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
            } as unknown as SDKMessage)
          }
          return out
        }
        case "source":
        case "source-url":
        case "source-document": {
          const cit = sourceToCitation(event)
          if (cit) {
            const key = (cit.type === "url_citation" ? cit.url : cit.title) || cit.title
            if (key && !sourceKeys.has(key)) {
              sourceKeys.add(key)
              sourceCitations.push(cit)
            }
          }
          out.push(buildAssistantSnapshot())
          return out
        }
        case "finish": {
          lastUsage = event.usage ?? event.totalUsage ?? null
          updateMessageMetadata(event.messageMetadata)
          // Don't emit `result` here — the caller invokes `.finish()` after the
          // loop exits cleanly.
          return out
        }
        case "reasoning-file":
          // AI SDK 7 split files referenced inside a model's reasoning trace out
          // of `file` into their own part type. DELIBERATELY DROPPED: raw
          // chain-of-thought artifacts are never rendered or persisted, matching
          // both the sidecar event-adapter and this mapper's `reasoning`
          // handling. Handled explicitly rather than falling through to
          // `default` so the drop is a decision, not an oversight.
          return out
        case "error":
        default:
          return out
      }
    },

    finish(info?: { totalCostUsd?: number; usage?: AiSdkUsage }): SDKMessage[] {
      const out: SDKMessage[] = []
      emitInitIfNeeded(out)
      const usage: AiSdkUsage = info?.usage ?? lastUsage ?? {}
      const result = {
        type: "result",
        subtype: "success",
        session_id: ctx.sdkSessionId,
        is_error: false,
        duration_ms: Date.now() - startedAt,
        duration_api_ms: Date.now() - startedAt,
        num_turns: 1,
        total_cost_usd: info?.totalCostUsd ?? 0,
        // Shared with the sidecar's `usage-normalize.mjs` mirror (pinned by
        // `usage-normalize.parity.test.ts`) so both dispatch paths surface the
        // same fields — including the cache-TTL split and server-tool counters.
        usage: normalizeUsageBlock(usage),
      }
      out.push(result as unknown as SDKMessage)
      return out
    },
  }
}
