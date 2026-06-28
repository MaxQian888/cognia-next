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
//   { type: "tool-call", toolCallId, toolName, args|input }
//   { type: "tool-result", toolCallId, output|result }
//   { type: "tool-error", toolCallId, error }
//   { type: "source" | "source-url" | "source-document", url?, title?, ... }
//   { type: "finish", usage: { promptTokens, completionTokens, ... } }
//
// SDKMessage shapes we emit (mirrors @anthropic-ai/claude-agent-sdk):
//   { type: "system", subtype: "init", session_id, ... }   — emitted once at start
//   { type: "assistant", message: { id, content: BetaContentBlock[] }, session_id, uuid }
//   { type: "user", message: { content: [{ type: "tool_result", ... }] }, ... }
//   { type: "result", subtype, session_id, usage, total_cost_usd, duration_ms, num_turns }

import type { SDKMessage } from "@/lib/claude/types"

const randomUUID = (): string => globalThis.crypto.randomUUID()

/** Loose shape of an AI SDK fullStream part — every field optional/version-tolerant. */
interface AiSdkStreamPart {
  type?: string
  text?: string
  textDelta?: string
  delta?: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  input?: unknown
  output?: unknown
  result?: unknown
  isError?: boolean
  error?: unknown
  url?: string
  title?: string
  filename?: string
  sourceType?: string
  usage?: AiSdkUsage
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
  prompt_cache_hit_tokens?: number
  promptCacheHitTokens?: number
  reasoningTokens?: number
  reasoning_tokens?: number
}

type Citation =
  | { type: "url_citation"; url?: string; title?: string }
  | { type: "document"; document_title: string; title: string }

interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: unknown
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
  const completedToolUses: ToolUseBlock[] = []
  // Provider citations (web-search / url / document) accumulated from AI SDK
  // `source*` parts and projected onto the assistant text block in the Anthropic
  // `citations` shape, so the renderer's existing `extractAnthropicCitations`
  // pipeline surfaces them with no downstream change.
  const sourceCitations: Citation[] = []
  const sourceKeys = new Set<string>()
  let initEmitted = false
  let lastUsage: AiSdkUsage | null = null

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

  function buildAssistantSnapshot(): SDKMessage {
    const content: Array<Record<string, unknown>> = []
    // Emit a text block when there is text OR accumulated citations to carry.
    if (textBuf || sourceCitations.length) {
      const textBlock: Record<string, unknown> = { type: "text", text: textBuf }
      if (sourceCitations.length) textBlock.citations = sourceCitations.slice()
      content.push(textBlock)
    }
    if (reasoningBuf) content.push({ type: "thinking", thinking: reasoningBuf })
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
      completedToolUses.length = 0
      sourceCitations.length = 0
      sourceKeys.clear()
      lastUsage = null
    },

    setModel(nextModel: string): void {
      if (typeof nextModel === "string" && nextModel) ctx.model = nextModel
    },

    handle(rawEvent: unknown): SDKMessage[] {
      const event = (rawEvent ?? {}) as AiSdkStreamPart
      const out: SDKMessage[] = []
      emitInitIfNeeded(out)

      switch (event.type) {
        case "text-delta": {
          if (activeBlockKind === "tool_use") {
            // Boundary change — start a new message id so the renderer doesn't
            // merge text after a tool_use into the same block.
            messageId = randomUUID()
          }
          activeBlockKind = "text"
          // v6 high-level fullStream uses `text`; v4 used `textDelta`; the
          // low-level model stream uses `delta`. Accept all three.
          textBuf += event.text ?? event.textDelta ?? event.delta ?? ""
          out.push(buildAssistantSnapshot())
          return out
        }
        case "reasoning":
        case "reasoning-delta": {
          activeBlockKind = "reasoning"
          reasoningBuf += event.text ?? event.textDelta ?? event.delta ?? ""
          out.push(buildAssistantSnapshot())
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
          // Tool results arrive as a synthetic user message with `tool_result`
          // blocks. v6 carries the payload in `output`; v4 used `result`.
          const payload = event.output ?? event.result
          const shaped = shapeToolResultContent(payload)
          out.push(buildToolResultMessage(event.toolCallId, shaped, Boolean(event.isError)))
          return out
        }
        case "tool-error": {
          const err = event.error
          const msg =
            err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err)
          out.push(buildToolResultMessage(event.toolCallId, msg, true))
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
          lastUsage = event.usage ?? null
          // Don't emit `result` here — the caller invokes `.finish()` after the
          // loop exits cleanly.
          return out
        }
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
        usage: {
          input_tokens: usage.promptTokens ?? usage.inputTokens ?? 0,
          output_tokens: usage.completionTokens ?? usage.outputTokens ?? 0,
          ...(typeof usage.contextInputTokens === "number"
            ? { context_input_tokens: usage.contextInputTokens }
            : {}),
          cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
          cache_read_input_tokens:
            usage.cacheReadInputTokens ??
            usage.cachedInputTokens ??
            usage.prompt_cache_hit_tokens ??
            usage.promptCacheHitTokens ??
            0,
          reasoning_tokens: usage.reasoningTokens ?? usage.reasoning_tokens ?? 0,
        },
      }
      out.push(result as unknown as SDKMessage)
      return out
    },
  }
}
