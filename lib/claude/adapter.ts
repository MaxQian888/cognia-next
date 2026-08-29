// Translates SDKMessage events from the Claude Agent SDK (via the sidecar)
// into UIMessage parts in the shape AI SDK Elements expect.

import type { UIMessage } from "ai"
import type {
  BetaContentBlock,
  BetaFileBlock,
  BetaMessage,
  BetaToolResultBlock,
  BetaToolUseBlock,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
  SdkMessageType,
  SdkSystemSubtype,
  SendContent,
  SendContentBlock,
} from "@cognia/agent-config-types"
import type {
  A2UIPart,
  McpResultBlock,
  SourcesPart,
  SourcesPartItem,
  ToolUseSummaryPart,
} from "./parts-extensions"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { attachUsageToLastAssistant } from "@/lib/chat/message-run-metadata"
import type { HookNoticePartData } from "./hooks"
import { registerUndoSnapshot } from "./compaction-undo"
import { persistOpticalArchive, type OpticalBoundaryMeta } from "./optical-archive-persist"
import { extractA2UIFromResponse } from "@/lib/a2ui/parser"
import {
  extractAnthropicCitations,
  extractFootnoteSources,
  extractTwinRagSources,
  mergeSources,
  type TwinRetrievedChunk,
} from "./citations"
import { emitFinishedSpan } from "@cognia/agent-trace/emitter"
import { artifactPartFromToolResult } from "@/lib/artifacts/tool-part"

type Parts = UIMessage["parts"]
type Part = Parts[number]

export interface UsageInfo {
  inputTokens?: number
  outputTokens?: number
  /**
   * Authoritative tokens currently occupying the live context. External agents
   * such as Codex report this independently from per-turn billable usage.
   */
  contextTokens?: number
  /** Authoritative live model context-window size, when the provider reports it. */
  contextWindow?: number
  /**
   * Prompt tokens occupying the *current* context window after the turn, when
   * that differs from `inputTokens`. On the ai-sdk channel a turn runs a manual
   * agent loop of several legs, and `inputTokens` SUMS every leg's prompt (the
   * correct cumulative-billing figure, since the API re-charges each leg). The
   * window, however, holds only the LAST leg's prompt — so window math must use
   * this field when present. `undefined` on single-result channels (native
   * Anthropic), where `inputTokens` already equals the window prompt.
   */
  contextInputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  /**
   * Cache-creation tokens split by TTL, when the provider reports it. Anthropic
   * bills a 5-minute write at 1.25× base input and a 1-hour write at 2×, so the
   * two cannot share `cacheCreationInputTokens` without under-billing the
   * 1-hour case. `undefined` when the provider reports only the flat total.
   */
  cacheCreation5mInputTokens?: number
  cacheCreation1hInputTokens?: number
  /**
   * Server-side tool invocation counts (`usage.server_tool_use`), normalized to
   * bare tool names. These are billed per call independently of tokens — web
   * search is $10 per 1,000 requests — so a turn's cost is incomplete without
   * them. `undefined` when the provider reported none.
   */
  serverToolUse?: Record<string, number>
  /**
   * Reasoning / "thinking" tokens reported separately by the provider (a subset
   * of output tokens, already billed at the output rate). Surfaced for
   * observability; `undefined` when the provider bundles thinking into output
   * (native Anthropic) or the model doesn't reason.
   */
  reasoningTokens?: number
  totalCostUsd?: number
  durationMs?: number
}

function buildAssistantParts(message: BetaMessage): Parts {
  const parts: Parts = []
  for (const block of message.content) {
    const expanded = blockToParts(block)
    for (const part of expanded) parts.push(part)
  }
  const sources = collectSourcesFromMessage(message)
  if (sources) parts.push(sources as unknown as Part)
  return parts
}

function preserveStepStartParts(preview: UIMessage | undefined, finalParts: Parts): Parts {
  if (!preview) return finalParts
  const stepStarts = preview.parts.filter(
    (part) => (part as { type?: string }).type === "step-start"
  )
  if (stepStarts.length === 0) return finalParts
  return [...stepStarts, ...finalParts]
}

/**
 * Walk every text block of the assistant message and combine
 *  - Anthropic Citations API entries
 *  - markdown footnote definitions
 * into a single SourcesPart appended at the tail. Twin-RAG / twin-style
 * sources are injected separately by the chat hook on `turnComplete` via
 * {@link mergeTwinSourcesIntoLastAssistant}, since they come from the
 * runtime context (`SendOptions.twinContext`) not the SDK event stream.
 */
function collectSourcesFromMessage(message: BetaMessage): SourcesPart | null {
  const anthropic = extractAnthropicCitations(message.content as unknown as BetaContentBlock[])
  let footnotes: ReturnType<typeof extractFootnoteSources> = []
  for (const block of message.content) {
    if (block.type !== "text") continue
    const text = (block as Extract<BetaContentBlock, { type: "text" }>).text ?? ""
    if (!text) continue
    const found = extractFootnoteSources(text)
    if (found.length) footnotes = footnotes.concat(found)
  }
  const merged = mergeSources(anthropic, footnotes)
  if (merged.length === 0) return null
  return { type: "sources", sources: merged }
}

/**
 * Detect A2UI content inside a free-text block. When found, splits the text
 * into pre / a2ui / post parts so the surface renders inline at the same
 * position the model emitted it.
 *
 * Order matters: the explicit ```a2ui fence is treated as a hard signal,
 * generic ```json fences fall back to `detectA2UIContent` heuristics inside
 * `extractA2UIFromResponse`. Markdown code-fences for other languages (html,
 * react, mermaid, …) are left untouched and rendered by the markdown layer.
 */
function blockToParts(block: BetaContentBlock): Part[] {
  if (block.type === "text") {
    const b = block as Extract<BetaContentBlock, { type: "text" }>
    const text = b.text ?? ""
    // splitTextForA2UI returns [] for the empty string, but downstream
    // consumers expect every text block to map to at least one Part — fall
    // back to an empty-string text Part to preserve that 1:1 contract.
    if (!text) {
      return [textPart("", b.providerMetadata)]
    }
    return splitTextForA2UI(text, b.providerMetadata)
  }
  const single = blockToPart(block)
  return single ? [single] : []
}

function splitTextForA2UI(
  text: string,
  providerMetadata?: Record<string, Record<string, unknown>>
): Part[] {
  if (!text) return []
  // Fast-path: skip the regex if no a2ui marker in sight.
  if (!/```a2ui|"createSurface"|"updateComponents"|"surface"\s*:/i.test(text)) {
    return [textPart(text, providerMetadata)]
  }
  const extracted = extractA2UIFromResponse(text)
  if (!extracted) return [textPart(text, providerMetadata)]
  // We don't get back the exact span the parser consumed, so we strip the
  // first ```a2ui|json fence (if any) to expose surrounding prose. When the
  // payload is raw JSON without a fence we keep the plain text part empty.
  const fenceRe = /```(?:a2ui|json)?\s*\n?[\s\S]*?\n?```/i
  const fenceMatch = text.match(fenceRe)
  const before = fenceMatch ? text.slice(0, fenceMatch.index ?? 0) : ""
  const after = fenceMatch ? text.slice((fenceMatch.index ?? 0) + fenceMatch[0].length) : ""
  const a2ui: A2UIPart = {
    type: "a2ui",
    surfaceId: extracted.surfaceId,
    content: fenceMatch ? fenceMatch[0] : text,
    source: "codeblock",
  }
  const out: Part[] = []
  if (before.trim()) out.push(textPart(before, providerMetadata))
  out.push(a2ui as unknown as Part)
  if (after.trim()) out.push(textPart(after, providerMetadata))
  return out
}

function textPart(text: string, providerMetadata?: Record<string, Record<string, unknown>>): Part {
  return {
    type: "text",
    text,
    state: "done",
    ...providerMetadataPart({ providerMetadata }),
  } as unknown as Part
}

function providerMetadataPart(block: {
  providerMetadata?: Record<string, Record<string, unknown>>
}): { providerMetadata?: Record<string, Record<string, unknown>> } {
  return block.providerMetadata ? { providerMetadata: block.providerMetadata } : {}
}

function blockToPart(block: BetaContentBlock): Part | null {
  switch (block.type) {
    case "text": {
      const b = block as Extract<BetaContentBlock, { type: "text" }>
      return {
        type: "text",
        text: b.text ?? "",
        state: "done",
        ...providerMetadataPart(b),
      } as unknown as Part
    }
    case "thinking": {
      const b = block as Extract<BetaContentBlock, { type: "thinking" }>
      return {
        type: "reasoning",
        text: b.thinking ?? "",
        state: "done",
        ...providerMetadataPart(b),
      } as unknown as Part
    }
    case "file": {
      const b = block as BetaFileBlock
      const source = b.source
      if (typeof b.url === "string" && typeof b.media_type === "string") {
        return {
          type: "file",
          url: b.url,
          mediaType: b.media_type,
          ...(b.filename ? { filename: b.filename } : {}),
        } as unknown as Part
      }
      if (
        !source ||
        source.type !== "base64" ||
        typeof source.media_type !== "string" ||
        typeof source.data !== "string"
      ) {
        return null
      }
      return {
        type: "file",
        url: `data:${source.media_type};base64,${source.data}`,
        mediaType: source.media_type,
        ...(b.filename ? { filename: b.filename } : {}),
      } as unknown as Part
    }
    case "tool_use": {
      const b = block as BetaToolUseBlock
      // Deliberately NOT the place an artifact part is emitted: the call has
      // not run yet, so any id here is the model's guess and the card would
      // point at a row that does not exist. See `updateToolPart` below.
      const state =
        b.state === "input-streaming" || b.state === "approval-requested"
          ? b.state
          : "input-available"
      return {
        type: `tool-${b.name}`,
        toolCallId: b.id,
        state,
        input: b.input,
        ...(b.providerExecuted !== undefined ? { providerExecuted: b.providerExecuted } : {}),
        ...(b.providerMetadata ? { providerMetadata: b.providerMetadata } : {}),
        ...(b.toolMetadata ? { toolMetadata: b.toolMetadata } : {}),
        ...(b.dynamic !== undefined ? { dynamic: b.dynamic } : {}),
        ...(b.title ? { title: b.title } : {}),
        ...(b.invalid !== undefined ? { invalid: b.invalid } : {}),
        ...(b.error !== undefined ? { error: b.error } : {}),
        ...(b.approval ? { approval: b.approval } : {}),
      } as unknown as Part
    }
    default:
      return null
  }
}

/** Human-scale byte size for the media placeholders below. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Compact stand-in for a media/resource block in the flattened `output` string.
 *
 * The real payload is preserved structurally on `part.mcpContent`
 * (`extractMcpContentBlocks`) and rendered by the cards. `output` is only ever
 * printed — by the tool cards, the activity-row summaries, the markdown/HTML
 * exporters, share, and the CLI handoff — so inlining base64 there produced an
 * unreadable wall AND a second full copy of every image in the `messages`
 * table. Returns null for blocks we can't summarise, which keep the JSON dump.
 */
function describeNonTextBlock(block: Record<string, unknown>): string | null {
  const type = block.type
  if (type === "image" || type === "audio") {
    const source = block.source as { data?: unknown; media_type?: unknown } | undefined
    const data = typeof block.data === "string" ? block.data : source?.data
    const mime =
      (typeof block.mimeType === "string" ? block.mimeType : undefined) ??
      (typeof source?.media_type === "string" ? source.media_type : undefined)
    // base64 → decoded bytes: 4 chars carry 3 bytes, minus any `=` padding.
    const size =
      typeof data === "string" && !data.startsWith("data:")
        ? Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
        : undefined
    const head = mime ? `${type} ${mime}` : String(type)
    return size !== undefined ? `[${head} · ${formatBytes(size)}]` : `[${head}]`
  }
  if (type === "resource") {
    const resource = block.resource as { uri?: unknown; mimeType?: unknown } | undefined
    const label =
      (typeof resource?.uri === "string" ? resource.uri : undefined) ??
      (typeof resource?.mimeType === "string" ? resource.mimeType : undefined)
    return label ? `[resource ${label}]` : "[resource]"
  }
  return null
}

function flattenToolResultContent(content: BetaToolResultBlock["content"]): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c
        if (c && typeof c === "object") {
          if ((c as { type?: string }).type === "text") {
            return (c as { type: "text"; text: string }).text
          }
          return describeNonTextBlock(c as Record<string, unknown>) ?? JSON.stringify(c)
        }
        return ""
      })
      .join("")
  }
  return JSON.stringify(content)
}

/**
 * Preserve the structured MCP content blocks off a tool-result, but ONLY when
 * at least one block is not plain text (image / resource / audio). Pure-text
 * results stay on the flattened-string path — no behavior change, no
 * persistence bloat. Returns undefined when there's nothing richer than text.
 * (gap3 — see `parts-extensions.ts:McpResultBlock`.)
 */
function extractMcpContentBlocks(
  content: BetaToolResultBlock["content"]
): McpResultBlock[] | undefined {
  if (!Array.isArray(content)) return undefined
  const blocks = content.filter(
    (c) => typeof c === "object" && c !== null && typeof (c as { type?: unknown }).type === "string"
  ) as McpResultBlock[]
  if (blocks.length === 0) return undefined
  return blocks.some((b) => b.type !== "text") ? blocks : undefined
}

/**
 * Apply a single SDK event to the existing UI message list.
 * Returns the (possibly new) array; never mutates inputs.
 */
export function applySdkEvent(
  messages: UIMessage[],
  evt: SDKMessage
): { messages: UIMessage[]; turnComplete: boolean; result?: SDKResultMessage } {
  switch (evt.type) {
    case "assistant":
      return {
        messages: appendAssistantMessage(messages, evt as SDKAssistantMessage),
        turnComplete: false,
      }
    case "user":
      return {
        messages: applyToolResults(messages, evt as SDKUserMessage),
        turnComplete: false,
      }
    case "stream_event":
      // Token-level streaming (opts.includePartialMessages). Accumulate text /
      // thinking deltas into an in-progress assistant message keyed by the
      // `message_start` id. The authoritative full `assistant` message arrives
      // later and replaces this preview via appendAssistantMessage's
      // replace-by-id (same Anthropic message id). Tool_use blocks stream too:
      // `content_block_start` paints the row the instant the model names the
      // tool, and `content_block_stop` fills in the parsed input.
      return {
        messages: applyStreamEvent(messages, evt as unknown as SDKPartialAssistantMessage),
        turnComplete: false,
      }
    case "result": {
      const result = evt as SDKResultMessage
      return {
        messages: attachSdkUsageToLastAssistant(messages, result),
        turnComplete: true,
        result,
      }
    }
    case "system":
      return applySystemEvent(messages, evt)
    case "rate_limit_event": {
      // A rate-limit notice describes a *live* condition, not something that
      // happened at a point in the transcript, so every event first drops any
      // previous marker and then re-posts one only if the limit is still
      // restrictive (`allowed_warning` / `rejected`).
      //
      // Dropping unconditionally is what makes the notice self-clearing. The
      // SDK emits this event whenever the info changes — including back to
      // `allowed` — so recovery reliably removes the marker. Previously
      // `allowed` was a no-op rather than a clear, which left a single past
      // warning pinned in the persisted transcript forever: it survived
      // reloads and still read "limit reached", with a `resetsAt` in the past.
      //
      // It also subsumes the old `collapsePrev` de-spam, which only fired when
      // the notice was the *last* message — never true once an assistant turn
      // followed it, so warnings accumulated one marker per turn.
      const info = (evt as unknown as { rate_limit_info?: RateLimitInfo }).rate_limit_info
      const cleared = dropSessionNotices(messages, "rate-limit")
      if (!info || info.status === "allowed") {
        return { messages: cleared, turnComplete: false }
      }
      return {
        messages: appendSessionNotice(cleared, {
          type: "session-notice",
          variant: "rate-limit",
          uuid: (evt as unknown as { uuid?: string }).uuid,
          status: info.status,
          rateLimitType: info.rateLimitType,
          resetsAt: info.resetsAt,
        }),
        turnComplete: false,
      }
    }

    // Mapped to canonical events by `sidecar/dispatch/sdk-canonical-events.mjs`.
    // These lifecycle/status messages render no transcript row of their own.
    case "tool_progress":
    case "auth_status":
    case "prompt_suggestion":
    case "conversation_reset":
      return { messages, turnComplete: false }

    case "tool_use_summary": {
      const summaryEvent = evt as unknown as {
        summary?: unknown
        preceding_tool_use_ids?: unknown
      }
      return {
        messages: applyToolUseSummary(messages, {
          summary: typeof summaryEvent.summary === "string" ? summaryEvent.summary : "",
          toolCallIds: Array.isArray(summaryEvent.preceding_tool_use_ids)
            ? summaryEvent.preceding_tool_use_ids.map(String)
            : [],
        }),
        turnComplete: false,
      }
    }

    default:
      // A message type this build predates. Tolerated at runtime — dropping a
      // row beats crashing the transcript — while `HandledSdkMessageType`
      // below makes it a compile error to leave a KNOWN type here.
      return { messages, turnComplete: false }
  }
}

function sameToolCallIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Insert or update a persisted aggregate tool summary in the relevant assistant turn. */
export function applyToolUseSummary(
  messages: UIMessage[],
  input: ToolUseSummaryPart["data"]
): UIMessage[] {
  const summary = input.summary.trim()
  if (!summary) return messages
  const part: ToolUseSummaryPart = {
    type: "data-tool-summary",
    data: { summary, toolCallIds: [...input.toolCallIds] },
  }

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const existingIndex = messages[messageIndex].parts.findIndex((candidate) => {
      if ((candidate as { type?: string }).type !== "data-tool-summary") return false
      const ids = (candidate as unknown as ToolUseSummaryPart).data?.toolCallIds
      return Array.isArray(ids) && sameToolCallIds(ids, input.toolCallIds)
    })
    if (existingIndex >= 0) {
      const message = messages[messageIndex]
      const parts = [...message.parts]
      parts[existingIndex] = part as unknown as Part
      return messages.map((candidate, index) =>
        index === messageIndex ? { ...message, parts } : candidate
      )
    }
  }

  const correlatedIds = new Set(input.toolCallIds)
  let targetMessageIndex = -1
  let insertAt = -1
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    if (messages[messageIndex].role !== "assistant") continue
    for (let partIndex = messages[messageIndex].parts.length - 1; partIndex >= 0; partIndex--) {
      const toolCallId = (messages[messageIndex].parts[partIndex] as { toolCallId?: unknown })
        .toolCallId
      if (typeof toolCallId === "string" && correlatedIds.has(toolCallId)) {
        targetMessageIndex = messageIndex
        insertAt = partIndex + 1
        break
      }
    }
    if (targetMessageIndex >= 0) break
  }

  if (targetMessageIndex < 0) {
    targetMessageIndex = messages.findLastIndex((message) => message.role === "assistant")
    if (targetMessageIndex < 0) return messages
    insertAt = messages[targetMessageIndex].parts.length
  }

  const message = messages[targetMessageIndex]
  const parts = [
    ...message.parts.slice(0, insertAt),
    part as unknown as Part,
    ...message.parts.slice(insertAt),
  ]
  return messages.map((candidate, index) =>
    index === targetMessageIndex ? { ...message, parts } : candidate
  )
}

/**
 * The `SDKMessage.type` values `applySdkEvent` names above.
 *
 * `SDKMessage` is an open union (it ends in a catch-all so a newer host can't
 * break the build), which means `switch` can never narrow to `never` and a
 * conventional exhaustiveness check is silently vacuous — that is exactly how
 * 30 of the 39 union members went unhandled for eight SDK releases. So
 * exhaustiveness is asserted against the closed discriminant vocabulary
 * instead, which `check:sdk-surface` pins to the installed `sdk.d.ts`.
 */
type HandledSdkMessageType =
  | "assistant"
  | "user"
  | "stream_event"
  | "result"
  | "system"
  | "rate_limit_event"
  | "tool_progress"
  | "tool_use_summary"
  | "auth_status"
  | "prompt_suggestion"
  | "conversation_reset"

/** Compile error the moment the SDK grows a message type nothing handles. */
const _everySdkMessageTypeIsHandled: Exclude<SdkMessageType, HandledSdkMessageType> extends never
  ? true
  : never = true
void _everySdkMessageTypeIsHandled

/**
 * What `evt` narrows to under `case "system"`. `SDKSystemMessage` declares
 * `[k: string]: unknown`, so every payload field reads as `unknown`; this is
 * the typed view of the fields the reducer actually consumes.
 *
 * `hook_fire` is in here and NOT in `SdkSystemSubtype` on purpose: the Rust
 * hook runtime synthesizes it (`src-tauri/src/claude/sidecar.rs:emit_hook_fire`)
 * and it rides the same channel, but it is not part of the SDK surface the
 * gate checks.
 */
interface SystemEventFields {
  subtype?: string
  uuid?: string
  tool_name?: string
  decision_reason?: string
  message?: string
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number }
  hook_event?: string
  outcome?: "blocked" | "context" | "warning"
  block?: string
  additional_context?: string
  warnings?: string[]
  // `hook_audit` fields (`sidecar/dispatch/agent-hooks.mjs:buildHookAuditPayload`).
  hookId?: string
  hookEvent?: string
  provider?: string
  handlerType?: string
  policyClass?: string
  latencyMs?: number
  redacted?: boolean
  blockReason?: string
  error?: string
}

/**
 * Land one `hook_audit` envelope as an agent-trace span.
 *
 * The sidecar has emitted these for every matched handler for a long time and
 * this adapter dropped them on the floor — so "why didn't my hook fire?" had no
 * answer anywhere in the product. That question gets much more common now that
 * a group can also be narrowed by `agents`, because there are two ways to miss.
 *
 * Rides the existing trace surface (`/logs` → Traces) rather than a new panel,
 * and reuses the same `plugin-hook` span surface the plugin-hook dispatcher
 * already emits on. Best-effort: a telemetry failure must never affect a turn.
 */
function emitHookAuditSpan(evt: SystemEventFields, sessionId: string): void {
  try {
    const startTime = Date.now() - Math.max(0, evt.latencyMs ?? 0)
    emitFinishedSpan({
      operationName: "execute_tool",
      providerName: "cognia.hook",
      sessionId: sessionId || "hook-runtime",
      surface: "plugin-hook",
      toolName: evt.hookEvent ?? evt.hook_event ?? "hook",
      startTime,
      durationMs: Math.max(0, evt.latencyMs ?? 0),
      status: evt.blockReason ? "error" : evt.error ? "error" : "ok",
      ...(evt.error || evt.blockReason
        ? {
            errorType: evt.blockReason ? "hook_blocked" : "hook_error",
            errorMessage: evt.blockReason ?? evt.error,
          }
        : {}),
      events: [
        {
          name: "hook.audit",
          at: startTime,
          attributes: {
            ...(evt.hookId ? { hookId: evt.hookId } : {}),
            ...(evt.handlerType ? { handlerType: evt.handlerType } : {}),
            ...(evt.policyClass ? { policyClass: evt.policyClass } : {}),
            ...(evt.provider ? { provider: evt.provider } : {}),
            ...(evt.redacted !== undefined ? { redacted: evt.redacted } : {}),
          },
        },
      ],
    })
  } catch {
    // Telemetry is never allowed to break the turn it describes.
  }
}

function applySystemEvent(
  messages: UIMessage[],
  raw: Extract<SDKMessage, { type: "system" }> | { type: string; session_id: string }
): { messages: UIMessage[]; turnComplete: boolean } {
  const evt = raw as unknown as SystemEventFields

  switch (evt.subtype) {
    case "hook_fire":
      return {
        messages: appendHookNotice(messages, {
          type: "hook-notice",
          event: evt.hook_event ?? "",
          toolName: evt.tool_name,
          outcome: evt.outcome ?? "warning",
          block: evt.block,
          additionalContext: evt.additional_context,
          warnings: evt.warnings ?? [],
        }),
        turnComplete: false,
      }

    case "hook_audit":
      emitHookAuditSpan(evt, (raw as { session_id?: string }).session_id ?? "")
      return { messages, turnComplete: false }

    case "compact_boundary":
      return { messages: appendCompactBoundary(messages, evt), turnComplete: false }

    case "permission_denied": {
      // A hook-caused denial already renders as a `hook_fire` row; the deny
      // payload Rust writes is prefixed `"hook denied:"`. Suppress the generic
      // permission-denied notice so the same block isn't shown twice.
      const reason = evt.decision_reason || evt.message
      if (reason?.startsWith("hook denied:")) {
        return { messages, turnComplete: false }
      }
      return {
        messages: appendSessionNotice(messages, {
          type: "session-notice",
          variant: "permission-denied",
          uuid: evt.uuid,
          toolName: evt.tool_name,
          reason,
        }),
        turnComplete: false,
      }
    }

    // The remaining 26 subtypes carry no transcript row today — their canonical
    // projection is what downstream consumers read. Enumerated so the switch
    // stays exhaustive.
    case "init":
    case "status":
    case "api_retry":
    case "control_request_progress":
    case "model_refusal_fallback":
    case "model_refusal_no_fallback":
    case "local_command_output":
    case "hook_started":
    case "hook_progress":
    case "hook_response":
    case "plugin_install":
    case "task_notification":
    case "task_started":
    case "task_updated":
    case "task_progress":
    case "background_tasks_changed":
    case "thinking_tokens":
    case "session_state_changed":
    case "worker_shutting_down":
    case "commands_changed":
    case "notification":
    case "files_persisted":
    case "memory_recall":
    case "elicitation_complete":
    case "mirror_error":
    case "informational":
      return { messages, turnComplete: false }

    default:
      // Synthetic subtypes (handled above) and anything a newer host sends.
      return { messages, turnComplete: false }
  }
}

/**
 * The `system` subtypes `applySystemEvent` names — `hook_fire` excluded, since
 * it is synthetic and absent from `SdkSystemSubtype`.
 */
type HandledSystemSubtype =
  | "compact_boundary"
  | "permission_denied"
  | "init"
  | "status"
  | "api_retry"
  | "control_request_progress"
  | "model_refusal_fallback"
  | "model_refusal_no_fallback"
  | "local_command_output"
  | "hook_started"
  | "hook_progress"
  | "hook_response"
  | "plugin_install"
  | "task_notification"
  | "task_started"
  | "task_updated"
  | "task_progress"
  | "background_tasks_changed"
  | "thinking_tokens"
  | "session_state_changed"
  | "worker_shutting_down"
  | "commands_changed"
  | "notification"
  | "files_persisted"
  | "memory_recall"
  | "elicitation_complete"
  | "mirror_error"
  | "informational"

/**
 * Compile error the moment the SDK grows a `system` subtype nothing handles.
 * 28 of the 39 union members differ only by subtype, so without this the
 * type-level check above would cover barely a quarter of the surface.
 */
const _everySystemSubtypeIsHandled: Exclude<SdkSystemSubtype, HandledSystemSubtype> extends never
  ? true
  : never = true
void _everySystemSubtypeIsHandled

/** Subscription rate-limit info subset surfaced from `rate_limit_event`. */
interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected"
  rateLimitType?: string
  resetsAt?: number
}

/** Structured payload for the synthetic `session-notice` system message. */
export interface SessionNoticePartData {
  type: "session-notice"
  variant: "permission-denied" | "rate-limit"
  uuid?: string
  // permission-denied
  toolName?: string
  reason?: string
  // rate-limit
  status?: string
  rateLimitType?: string
  resetsAt?: number
}

/** True when a message is a session-notice marker of the given variant. */
function isSessionNoticeOf(message: UIMessage, variant: SessionNoticePartData["variant"]): boolean {
  if (message.role !== "system") return false
  const part = message.parts?.[0] as { type?: string; variant?: string } | undefined
  return part?.type === "session-notice" && part.variant === variant
}

/**
 * Drop every session-notice marker of one variant, wherever it sits in the
 * transcript. Used for notices that project a live condition rather than a past
 * event, so the transcript holds at most the latest one — and none once the
 * condition clears.
 *
 * `persistMessages` diffs by id and deletes what disappeared, so removing a
 * marker here also deletes its row. Returns the original array when nothing
 * matched, since the persist layer and the chat store both key off identity.
 */
function dropSessionNotices(
  messages: UIMessage[],
  variant: SessionNoticePartData["variant"]
): UIMessage[] {
  if (!messages.some((m) => isSessionNoticeOf(m, variant))) return messages
  return messages.filter((m) => !isSessionNoticeOf(m, variant))
}

/**
 * Append a non-conversational "session notice" marker (auto-deny / rate-limit)
 * to the transcript, mirroring the compact-boundary projection.
 */
function appendSessionNotice(messages: UIMessage[], data: SessionNoticePartData): UIMessage[] {
  const id = `notice-${data.variant}-${data.uuid ?? crypto.randomUUID()}`
  const marker: UIMessage = {
    id,
    role: "system",
    parts: [data as unknown as UIMessage["parts"][number]],
  }
  return [...messages, marker]
}

/**
 * Append a non-conversational "hook notice" marker projecting a consequential
 * hook fire into the transcript, mirroring `appendSessionNotice`. Only fired by
 * the adapter's `system`/`hook_fire` branch, which the Rust runtime emits solely
 * when a hook blocked, injected context, or warned.
 */
function appendHookNotice(messages: UIMessage[], data: HookNoticePartData): UIMessage[] {
  const marker: UIMessage = {
    id: `hook-${data.event}-${crypto.randomUUID()}`,
    role: "system",
    parts: [data as unknown as UIMessage["parts"][number]],
  }
  return [...messages, marker]
}

/**
 * Append a non-conversational divider marking where the SDK compacted the
 * context. Rendered by `MessageRenderer` as a centered "context compacted"
 * rule (it carries no usage / text so it skips all message chrome).
 */
function appendCompactBoundary(
  messages: UIMessage[],
  sys: {
    uuid?: string
    compact_metadata?: {
      trigger?: string
      pre_tokens?: number
      post_tokens?: number
      strategy?: string
      frozenSummaryDecision?: string
      // Generic-path undo snapshot (sidecar-format), present only when the
      // `captureUndoSnapshot` setting is on. Kept OUT of the persisted part —
      // it is moved into the in-memory undo registry instead.
      pre_messages?: unknown[]
      // Optical-strategy archive (ADR-0063): rendered frames + token stats.
      // Persisted to Dexie (durable, survives reload) rather than embedded in
      // the transcript part; the part only carries a reference id + frame count.
      optical?: OpticalBoundaryMeta
      // True when the optical strategy fell back to a text summary this boundary.
      opticalFallback?: boolean
    }
  }
): UIMessage[] {
  const meta = sys.compact_metadata
  const id = `compact-${sys.uuid ?? crypto.randomUUID()}`

  // Record the pre-compaction snapshot for undo (live-session-only, in-memory).
  let undoToken: string | undefined
  if (Array.isArray(meta?.pre_messages) && meta.pre_messages.length > 0) {
    undoToken = id
    registerUndoSnapshot({
      token: id,
      strategy: meta.strategy,
      tokensBefore: meta.pre_tokens,
      tokensAfter: meta.post_tokens,
      createdAt: Date.now(),
      snapshot: meta.pre_messages,
    })
  }

  // Persist the optical archive (durable) and reference it from the part.
  const opticalArchiveId = meta?.optical ? persistOpticalArchive(id, meta) : undefined

  const marker: UIMessage = {
    id,
    role: "system",
    parts: [
      {
        type: "compact-boundary",
        trigger: meta?.trigger,
        preTokens: meta?.pre_tokens,
        postTokens: meta?.post_tokens,
        strategy: meta?.strategy,
        ...(undoToken ? { undoToken } : {}),
        ...(opticalArchiveId ? { opticalArchiveId } : {}),
        ...(meta?.optical?.frameCount ? { opticalFrameCount: meta.optical.frameCount } : {}),
        ...(meta?.opticalFallback ? { opticalFallback: true } : {}),
      } as unknown as UIMessage["parts"][number],
    ],
  }
  return [...messages, marker]
}

function appendAssistantMessage(messages: UIMessage[], evt: SDKAssistantMessage): UIMessage[] {
  // We key UI messages by the Anthropic message id. If a prior partial-stream
  // version is in the list, replace it with the canonical full version.
  const id = evt.message.id ?? evt.uuid
  const idx = messages.findIndex((m) => m.id === id)
  const parts = preserveStepStartParts(messages[idx], buildAssistantParts(evt.message))
  const next: UIMessage = {
    id,
    role: "assistant",
    parts,
    ...(evt.message.metadata !== undefined ? { metadata: evt.message.metadata } : {}),
  }
  if (idx >= 0) {
    const copy = messages.slice()
    copy[idx] = next
    return copy
  }
  return [...messages, next]
}

/** Index of the most recent assistant message (the active streaming target). */
function findLastAssistantIndex(messages: UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return i
  }
  return -1
}

/**
 * Index of the most recent real user turn — the boundary the live streaming
 * target must sit after. Tool-result `user` payloads never reach the message
 * list as their own rows (they patch existing assistant parts), so this only
 * matches genuine user prompts, i.e. true turn boundaries.
 */
function findLastUserIndex(messages: UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i
  }
  return -1
}

/** Append a text / reasoning delta to the last like-typed part, or start one. */
function appendDelta(
  messages: UIMessage[],
  idx: number,
  partType: "text" | "reasoning",
  chunk: string
): UIMessage[] {
  const msg = messages[idx]
  const parts = (msg.parts ?? []).slice()
  let pIdx = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    const type = (parts[i] as { type?: string }).type
    if (type === partType) {
      pIdx = i
      break
    }
    // A tool call closes the text/reasoning block that preceded it. Without
    // this the text streaming *after* a tool_use would be appended to the text
    // part from *before* it, silently welding two separate blocks into one.
    if (typeof type === "string" && type.startsWith("tool-")) break
  }
  if (pIdx >= 0) {
    const prev = parts[pIdx] as unknown as { text?: string }
    parts[pIdx] = {
      type: partType,
      text: (prev.text ?? "") + chunk,
      state: "streaming",
    } as unknown as Part
  } else {
    parts.push({ type: partType, text: chunk, state: "streaming" } as unknown as Part)
  }
  const next = messages.slice()
  next[idx] = { ...msg, parts } as UIMessage
  return next
}

/**
 * Extract a partial live {@link UsageInfo} from a raw Anthropic streaming
 * event's `usage` block: `message_start` carries `input_tokens` + cache counts,
 * `message_delta` carries the running `output_tokens`. Snake_case per the SDK.
 * Returns null when no numeric usage is present (e.g. ai-sdk `message_start`
 * frames, which carry only an id).
 */
function liveUsageFromStreamEvent(raw: {
  type?: string
  message?: { usage?: Record<string, unknown> }
  usage?: Record<string, unknown>
}): Partial<UsageInfo> | null {
  const u = raw.type === "message_start" ? raw.message?.usage : raw.usage
  if (!u || typeof u !== "object") return null
  const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : undefined)
  const info: Partial<UsageInfo> = {
    inputTokens: num("input_tokens"),
    outputTokens: num("output_tokens"),
    cacheCreationInputTokens: num("cache_creation_input_tokens"),
    cacheReadInputTokens: num("cache_read_input_tokens"),
  }
  if (Object.values(info).every((v) => v === undefined)) return null
  return info
}

/**
 * Merge a partial live usage into the last assistant message's `metadata.usage`,
 * only ADDING fields the frame carries — a later frame (or the trailing `result`)
 * never gets a known value downgraded to undefined. Powers mid-turn ctx%.
 */
function mergeLiveUsage(messages: UIMessage[], partial: Partial<UsageInfo>): UIMessage[] {
  const idx = findLastAssistantIndex(messages)
  if (idx < 0) return messages
  const msg = messages[idx]
  const prior = ((msg as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<
    string,
    unknown
  >
  const usage: Record<string, unknown> = { ...((prior.usage as Record<string, unknown>) ?? {}) }
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) usage[k] = v
  }
  const out = messages.slice()
  out[idx] = {
    ...msg,
    ...({ metadata: { ...prior, usage } } as { metadata: Record<string, unknown> }),
  }
  return out
}

/**
 * In-flight `tool_use` input buffers, keyed `<messageId>#<blockIndex>`.
 *
 * The Agent SDK streams a tool call's arguments as a run of `input_json_delta`
 * fragments that are only valid JSON once the block closes, so the fragments
 * have to be accumulated somewhere across events. They deliberately live HERE
 * rather than on the part: `use-claude-chat` debounce-persists the message list
 * mid-stream, so parking a growing raw-JSON string on the part would write a
 * second full copy of every large `Write` / `Edit` payload into Dexie for the
 * duration of the call. Entries are dropped at `content_block_stop`.
 */
const streamingToolInputs = new Map<string, { toolCallId: string; text: string }>()

/**
 * Ceiling on live tool-input buffers. Every entry is normally freed by its
 * `content_block_stop`, but an aborted turn (user pressed stop, sidecar died)
 * never sends one. The cap keeps a long-lived renderer from leaking; the only
 * cost of a wrong eviction is a tool row whose input arrives with the canonical
 * `assistant` message instead of at `content_block_stop`.
 */
const MAX_STREAMING_TOOL_INPUTS = 128

/** Test seam — drops every in-flight tool-input buffer. */
export function resetStreamingToolInputs(): void {
  streamingToolInputs.clear()
}

/** Parse an accumulated `input_json_delta` buffer, or undefined if incomplete. */
function tryParseToolInput(text: string): unknown | undefined {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Apply a `stream_event` (SDKPartialAssistantMessage) to the in-progress
 * assistant message. `message_start` seeds an empty assistant message keyed by
 * the Anthropic message id (and attaches live input/cache usage); each
 * `content_block_delta` (text_delta / thinking_delta) grows it; `message_delta`
 * merges the running output-token usage.
 *
 * Tool calls stream through the block lifecycle: `content_block_start` carries
 * the tool's id + name (its `input` is always `{}` at that point), so the row
 * is painted immediately in `input-streaming`; the `input_json_delta` run is
 * accumulated off-message; `content_block_stop` parses the buffer and promotes
 * the part to `input-available`. `message_stop` is ignored — the final
 * `assistant` message carries the canonical content and the `result` message
 * the authoritative usage.
 */
function applyStreamEvent(messages: UIMessage[], evt: SDKPartialAssistantMessage): UIMessage[] {
  const raw = evt.event as unknown as {
    type?: string
    index?: number
    message?: { id?: string; usage?: Record<string, unknown> }
    usage?: Record<string, unknown>
    content_block?: { type?: string; id?: string; name?: string }
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
  }
  if (!raw || typeof raw !== "object") return messages

  if (raw.type === "message_start") {
    const id = raw.message?.id
    if (!id) return messages
    let next = messages
    if (!messages.some((m) => m.id === id)) {
      next = [...messages, { id, role: "assistant", parts: [] } as UIMessage]
    }
    // Live context-usage refresh: the native Anthropic `message_start` carries the
    // turn's real input + cache token counts. Attaching them to the in-progress
    // assistant lets the ctx% indicator update mid-turn (the trailing `result`
    // usage replaces them authoritatively at turn end). ai-sdk `message_start`
    // frames carry no usage → this is a no-op there.
    const live = liveUsageFromStreamEvent(raw)
    return live ? mergeLiveUsage(next, live) : next
  }

  if (raw.type === "message_delta") {
    // Anthropic emits the running `output_tokens` on each `message_delta`; merge
    // it into the live usage so the ctx% window figure grows as the reply streams.
    const live = liveUsageFromStreamEvent(raw)
    return live ? mergeLiveUsage(messages, live) : messages
  }

  if (raw.type === "step_start") {
    const idx = findLastAssistantIndex(messages)
    if (idx < 0 || idx < findLastUserIndex(messages)) return messages
    const msg = messages[idx]
    const out = messages.slice()
    out[idx] = {
      ...msg,
      parts: [...msg.parts, { type: "step-start" } as unknown as Part],
    }
    return out
  }

  if (raw.type === "content_block_start") {
    const block = raw.content_block
    if (block?.type !== "tool_use") return messages
    const { id, name } = block
    if (!id || !name) return messages
    const idx = findLastAssistantIndex(messages)
    // Same turn guard the text deltas use: never graft this turn's tool call
    // onto the previous turn's finished reply.
    if (idx < 0 || idx < findLastUserIndex(messages)) return messages
    const msg = messages[idx]
    // A replayed / resumed stream can re-announce a block already on the
    // message. Re-seeding would duplicate the row and orphan the first one.
    if (msg.parts.some((p) => (p as { toolCallId?: string }).toolCallId === id)) return messages

    if (streamingToolInputs.size >= MAX_STREAMING_TOOL_INPUTS) streamingToolInputs.clear()
    streamingToolInputs.set(`${msg.id}#${raw.index ?? 0}`, { toolCallId: id, text: "" })

    const out = messages.slice()
    out[idx] = {
      ...msg,
      parts: [
        ...msg.parts,
        // No `input` yet — the arguments are still being generated. The row
        // renders as tool name + pending glyph until `content_block_stop`.
        { type: `tool-${name}`, toolCallId: id, state: "input-streaming" } as unknown as Part,
      ],
    } as UIMessage
    return out
  }

  if (raw.type === "content_block_stop") {
    const idx = findLastAssistantIndex(messages)
    if (idx < 0) return messages
    const msg = messages[idx]
    const key = `${msg.id}#${raw.index ?? 0}`
    const buffered = streamingToolInputs.get(key)
    if (!buffered) return messages
    streamingToolInputs.delete(key)

    const pIdx = msg.parts.findIndex(
      (p) => (p as { toolCallId?: string }).toolCallId === buffered.toolCallId
    )
    if (pIdx < 0) return messages
    const prev = msg.parts[pIdx] as unknown as Record<string, unknown>
    // The arguments are complete but the tool has not run: that is exactly
    // `input-available`, so the canonical `assistant` message that lands next
    // replaces this part with an identical one and the row never flickers.
    // A buffer that fails to parse (truncated stream) keeps `input` absent
    // rather than inventing one — the canonical message supplies the truth.
    const parsed = tryParseToolInput(buffered.text)
    const parts = msg.parts.slice()
    parts[pIdx] = {
      ...prev,
      state: "input-available",
      ...(parsed !== undefined ? { input: parsed } : {}),
    } as unknown as Part
    const out = messages.slice()
    out[idx] = { ...msg, parts } as UIMessage
    return out
  }

  if (raw.type === "content_block_delta") {
    const delta = raw.delta
    if (delta?.type === "input_json_delta") {
      // O(1) append only — no whole-buffer re-parse and no message-list copy
      // per chunk. Mid-stream parses virtually never succeed (the JSON is
      // truncated), and the row is already painted, so there is nothing to
      // re-render until the block closes.
      const idx = findLastAssistantIndex(messages)
      if (idx < 0) return messages
      const buffered = streamingToolInputs.get(`${messages[idx].id}#${raw.index ?? 0}`)
      if (buffered) buffered.text += delta.partial_json ?? ""
      return messages
    }
    let chunk = ""
    let partType: "text" | "reasoning" | null = null
    if (delta?.type === "text_delta") {
      chunk = delta.text ?? ""
      partType = "text"
    } else if (delta?.type === "thinking_delta") {
      chunk = delta.thinking ?? ""
      partType = "reasoning"
    }
    if (!partType || !chunk) return messages
    const idx = findLastAssistantIndex(messages)
    if (idx < 0) return messages
    // Turn guard: never grow an assistant message that predates the latest
    // user turn. When this turn's `message_start` was dropped or suppressed
    // (an aborted / resent send that "didn't go out"), the only assistant in
    // the list is the PRIOR turn's finished reply — appending here merges the
    // new turn's tokens into it ("greeting two" + the old greeting's tail).
    // Drop the orphaned delta instead; the canonical `assistant` message
    // (carrying the real id) seeds this turn's reply correctly when it lands.
    if (idx < findLastUserIndex(messages)) return messages
    return appendDelta(messages, idx, partType, chunk)
  }

  return messages
}

function applyToolResults(messages: UIMessage[], evt: SDKUserMessage): UIMessage[] {
  // Tool results are encoded as a synthetic user message whose content is a
  // list of `tool_result` blocks. Extract each and patch the matching tool
  // call part on a prior assistant message.
  const content = evt.message.content
  if (typeof content === "string" || !Array.isArray(content)) {
    // A real user turn (free-form text) — not relevant to the assistant-side
    // history because the UI already rendered the user's prompt locally.
    return messages
  }

  let next = messages
  let mutated = false

  for (const block of content) {
    if ((block as { type?: string }).type !== "tool_result") continue
    const tr = block as BetaToolResultBlock
    const updated = updateToolPart(next, tr)
    if (updated !== next) {
      next = updated
      mutated = true
    }
  }
  return mutated ? next : messages
}

/** Tool results arrive flattened to text; the artifact tools return JSON. */
function parseToolResultJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function updateToolPart(messages: UIMessage[], tr: BetaToolResultBlock): UIMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    const partIdx = msg.parts.findIndex(
      (p) =>
        typeof (p as { type?: string }).type === "string" &&
        (p as { type: string }).type.startsWith("tool-") &&
        (p as { toolCallId?: string }).toolCallId === tr.tool_use_id
    )
    if (partIdx < 0) continue

    const oldPart = msg.parts[partIdx] as unknown as {
      type: string
      toolCallId: string
      state: string
      input?: unknown
    }
    const outputText = flattenToolResultContent(tr.content)
    const mcpContent = tr.is_error ? undefined : extractMcpContentBlocks(tr.content)

    // An artifact/canvas tool that succeeded replaces its tool card with the
    // artifact card. This is the only point where the host-written id is
    // known — `createArtifact` mints it, so the model's `tool_use` input never
    // carried it.
    const artifactPart = tr.is_error
      ? null
      : artifactPartFromToolResult(
          oldPart.type.slice("tool-".length),
          parseToolResultJson(outputText),
          {
            toolCallId: oldPart.toolCallId,
          }
        )
    const newPart = (artifactPart ?? {
      ...oldPart,
      state: tr.is_error ? "output-error" : "output-available",
      ...(tr.is_error ? { errorText: outputText } : { output: outputText }),
      ...(mcpContent ? { mcpContent } : {}),
    }) as unknown as Part

    const newParts = msg.parts.slice()
    newParts[partIdx] = newPart
    const newMsg: UIMessage = { ...msg, parts: newParts }
    const newMessages = messages.slice()
    newMessages[i] = newMsg
    return newMessages
  }
  return messages
}

/**
 * Pull usage / cost numbers out of the SDK's result message and attach them
 * as `metadata.usage` on the most recent assistant message.
 *
 * The SDK sometimes nests usage one level deeper (`result.message.usage`),
 * so we look in both places. Cache token fields are snake_case in the SDK.
 *
 * Only the EXTRACTION is local: the walk-and-merge is
 * `attachUsageToLastAssistant` in `lib/chat/message-run-metadata.ts`, shared
 * with the external-agent lane so both write `metadata.usage` the same way.
 */
function attachSdkUsageToLastAssistant(
  messages: UIMessage[],
  result: SDKResultMessage
): UIMessage[] {
  const usage = extractUsage(result)
  if (!usage) return messages
  return attachUsageToLastAssistant(messages, usage as unknown as Record<string, unknown>)
}

export function extractUsage(result: SDKResultMessage): UsageInfo | null {
  const top = result as unknown as {
    usage?: Record<string, unknown>
    message?: { usage?: Record<string, unknown> }
    duration_ms?: number
    total_cost_usd?: number
  }
  const raw = top.usage ?? top.message?.usage
  if (!raw && top.total_cost_usd === undefined) return null

  const num = (k: string) => {
    if (!raw) return undefined
    const v = raw[k]
    return typeof v === "number" ? v : undefined
  }

  const reasoning = num("reasoning_tokens")
  const contextInput = num("context_input_tokens")

  // Cache-TTL split and server-tool counters, emitted by the shared usage
  // normalizer (`lib/ai/chat/usage-normalize.ts` and its sidecar mirror). Both
  // are absent unless the provider actually reported them, so "no 1-hour
  // writes" stays distinguishable from "TTL not reported".
  const cacheCreationDetail = raw?.cache_creation as
    { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined
  const positive = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined

  const rawServerToolUse = raw?.server_tool_use as Record<string, unknown> | undefined
  let serverToolUse: Record<string, number> | undefined
  if (rawServerToolUse && typeof rawServerToolUse === "object") {
    const counts: Record<string, number> = {}
    for (const [tool, value] of Object.entries(rawServerToolUse)) {
      const n = positive(value)
      if (n !== undefined) counts[tool] = n
    }
    if (Object.keys(counts).length > 0) serverToolUse = counts
  }

  const info: UsageInfo = {
    inputTokens: num("input_tokens"),
    outputTokens: num("output_tokens"),
    // Only attach when the channel reported a window-prompt size that differs
    // from the (cumulative) input — i.e. the ai-sdk agent-loop path.
    contextInputTokens:
      typeof contextInput === "number" && contextInput !== num("input_tokens")
        ? contextInput
        : undefined,
    cacheCreationInputTokens: num("cache_creation_input_tokens"),
    cacheReadInputTokens: num("cache_read_input_tokens"),
    cacheCreation5mInputTokens: positive(cacheCreationDetail?.ephemeral_5m_input_tokens),
    cacheCreation1hInputTokens: positive(cacheCreationDetail?.ephemeral_1h_input_tokens),
    serverToolUse,
    // Only attach when the provider actually reported reasoning tokens (> 0) so
    // non-reasoning turns don't carry a noisy `reasoningTokens: 0`.
    reasoningTokens: typeof reasoning === "number" && reasoning > 0 ? reasoning : undefined,
    totalCostUsd: typeof top.total_cost_usd === "number" ? top.total_cost_usd : undefined,
    durationMs: typeof top.duration_ms === "number" ? top.duration_ms : undefined,
  }
  // Drop fully-empty objects rather than attaching a placeholder.
  if (Object.values(info).every((v) => v === undefined)) return null
  return info
}

/**
 * Helper for pushing a freshly-typed user prompt into the UI history.
 *
 * Accepts either plain text (the common case) or an array of multimodal
 * content blocks. Image blocks become `file` parts so the transcript renders
 * thumbnails.
 *
 * `manifest` (from `buildSendContent`) describes `content[i]` for the leading
 * attachment blocks. With it, two long-standing transcript defects go away:
 *
 *  - Images kept no `filename`, so the gallery and lightbox showed a generic
 *    "attachment" label for every picture the user sent.
 *  - A document was flattened to a `text` block for the model, and that same
 *    block was rendered verbatim in the USER'S OWN bubble — attaching a 50-page
 *    PDF dumped its entire extracted text into the conversation. Those blocks
 *    now become url-less `file` parts carrying the text, which the renderer
 *    shows as a collapsed "📎 report.pdf" card. Nothing extra is persisted: the
 *    text was already being stored, just without its provenance.
 */
export function makeUserMessage(
  content: SendContent,
  id?: string,
  manifest?: readonly AttachmentManifestEntry[]
): UIMessage {
  const messageId = id ?? `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  if (typeof content === "string") {
    return {
      id: messageId,
      role: "user",
      parts: [{ type: "text", text: content, state: "done" } as unknown as Part],
    }
  }

  const parts: Parts = []
  content.forEach((block, index) => {
    const entry = manifest?.[index]
    if (block.type === "text") {
      // Only a block the manifest claims is an attachment becomes a file card;
      // the user's own prose (and merged link context) stays a text part.
      if (entry?.kind === "document") {
        parts.push({
          type: "file",
          mediaType: entry.mediaType || "text/plain",
          filename: entry.filename,
          // No `url`: the original binary is deliberately NOT persisted (it
          // would balloon every message row). The extracted text is what the
          // model saw and what the card shows.
          text: block.text,
        } as unknown as Part)
        return
      }
      parts.push({
        type: "text",
        text: block.text,
        state: "done",
      } as unknown as Part)
    } else if (block.type === "image") {
      const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`
      parts.push({
        type: "file",
        url: dataUrl,
        mediaType: block.source.media_type,
        ...(entry?.filename ? { filename: entry.filename } : {}),
      } as unknown as Part)
    }
  })
  return {
    id: messageId,
    role: "user",
    parts,
  }
}

/** Extract plain text from a SendContent payload. Handy for titling sessions. */
export function contentPreview(content: SendContent, max = 80): string {
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((b): b is Extract<SendContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join(" ")
  return text.length > max ? text.slice(0, max) + "…" : text
}

/**
 * Twin-side surface for the chat hook: the runtime context emitted by
 * `applyTwinContext` and stashed on `SendOptions.twinContext`. The chat hook
 * passes this verbatim to {@link mergeTwinSourcesIntoLastAssistant} when a
 * turn completes so the user sees what shaped the reply.
 */
export interface TwinSourcesContext {
  twinId: string
  retrievedChunks: TwinRetrievedChunk[]
  selectedStyleSamples: Array<{
    id: string
    contextLabel: string
    summary: string
    tone: string[]
  }>
  /**
   * True when the twin runtime degraded to a no-context send (embedding or
   * vector store unreachable). Surfaced on the assistant message's SourcesPart
   * (`twinDegraded`) so the chat user is warned the reply skipped retrieval —
   * otherwise a silent degrade looks identical to a grounded answer.
   */
  degraded?: boolean
}

/** Provider-search context stashed on the send options for this turn. */
export interface WebSearchSourcesContext {
  provider: string
  results: Array<{
    title: string
    url: string
    content: string
    score: number
  }>
}

/** Persist pre-search results as clickable sources on the completed reply. */
export function webSearchSourcesFromContext(
  context: WebSearchSourcesContext | undefined | null
): SourcesPartItem[] {
  if (!context || context.results.length === 0) return []
  return context.results.map((result, index) => ({
    id: `cognia-web-${context.provider}-${index}`,
    title: result.title || result.url,
    url: result.url,
    snippet:
      result.content.length > 200 ? `${result.content.slice(0, 199).trimEnd()}…` : result.content,
    origin: "cognia-web",
    score: result.score,
  }))
}

/** Persist pre-search results as clickable sources on the completed reply. */
export function mergeWebSearchSourcesIntoLastAssistant(
  messages: UIMessage[],
  context: WebSearchSourcesContext | undefined | null
): UIMessage[] {
  const sources = webSearchSourcesFromContext(context)
  if (sources.length === 0) return messages
  return appendSourcesToLastAssistant(messages, sources)
}

/**
 * Merge twin RAG + style sources onto the last assistant message's
 * SourcesPart. Returns a new messages array (or the same reference when
 * nothing changes, so callers can skip a re-persist). The fold is
 * idempotent — re-running with the same twinContext is a no-op because
 * `mergeSources` dedupes by `url || title`.
 *
 * Twin-rag items receive a `chunkRef` so the renderer can build a deep-link
 * back into `/twin?twinId=…&tab=sources&sourceId=…&chunkId=…`. Style items
 * carry no chunkRef (they're profile-level, not chunk-level).
 */
export function mergeTwinSourcesIntoLastAssistant(
  messages: UIMessage[],
  twinContext: TwinSourcesContext | undefined | null
): UIMessage[] {
  if (!twinContext) return messages
  const chunkSources = extractTwinRagSources(twinContext.retrievedChunks).map(
    (s, i): SourcesPartItem => {
      const chunk = twinContext.retrievedChunks[i]?.chunk
      return chunk
        ? {
            ...s,
            chunkRef: {
              twinId: twinContext.twinId,
              sourceId: chunk.sourceId,
              chunkId: chunk.vectorDocId,
            },
          }
        : s
    }
  )
  const styleSources: SourcesPartItem[] = twinContext.selectedStyleSamples.map((sample, i) => ({
    id: `twin-style-${sample.id || i}`,
    title: sample.contextLabel || sample.tone[0] || `Style sample ${i + 1}`,
    snippet:
      sample.summary.length > 200 ? sample.summary.slice(0, 199).trimEnd() + "…" : sample.summary,
    origin: "twin-style",
  }))
  return appendSourcesToLastAssistant(messages, [...chunkSources, ...styleSources], {
    twinDegraded: twinContext.degraded,
  })
}

/**
 * Shared fold: merge `additions` onto the most recent assistant message's
 * SourcesPart. Returns the same reference when nothing changes (so callers can
 * skip a re-persist). Idempotent — `mergeSources` dedupes by `url || title`, and
 * a same-length/same-id result short-circuits. Used by both the Twin and Memory
 * source merges.
 */
function appendSourcesToLastAssistant(
  messages: UIMessage[],
  additions: SourcesPartItem[],
  opts?: {
    twinDegraded?: boolean
    memoryBudget?: SourcesPart["memoryBudget"]
    memoryDegraded?: boolean
  }
): UIMessage[] {
  const wantDegraded = opts?.twinDegraded
  const wantMemoryDegraded = opts?.memoryDegraded
  // A degraded twin/memory turn must still annotate the message even with zero
  // additions — that's the whole point of the warning. Only short-circuit when
  // there is genuinely nothing to do.
  if (additions.length === 0 && !wantDegraded && !wantMemoryDegraded && !opts?.memoryBudget) {
    return messages
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    const parts = msg.parts
    const sourcesIdx = parts.findIndex((p) => (p as { type?: string }).type === "sources")
    const existingPart = sourcesIdx >= 0 ? (parts[sourcesIdx] as unknown as SourcesPart) : null
    const existingSources = existingPart?.sources ?? []
    const merged = mergeSources(existingSources, additions)
    // The `twinDegraded` flag is sticky: only the twin merge writes it (memory
    // passes no opts → preserve whatever's there), and a degraded turn is never
    // un-flagged by a later non-degraded merge.
    const nextDegraded =
      wantDegraded === undefined
        ? existingPart?.twinDegraded
        : wantDegraded || existingPart?.twinDegraded
    // Memory annotations mirror the twin flag's stickiness: only the memory
    // merge writes them (twin passes no memory opts → preserve what's there).
    const nextMemoryDegraded =
      wantMemoryDegraded === undefined
        ? existingPart?.memoryDegraded
        : wantMemoryDegraded || existingPart?.memoryDegraded
    const nextMemoryBudget = opts?.memoryBudget ?? existingPart?.memoryBudget
    const sourcesUnchanged =
      merged.length === existingSources.length &&
      merged.every((s, idx) => s.id === existingSources[idx]?.id)
    const degradedUnchanged = Boolean(existingPart?.twinDegraded) === Boolean(nextDegraded)
    const budgetUnchanged =
      existingPart?.memoryBudget === nextMemoryBudget ||
      (existingPart?.memoryBudget !== undefined &&
        nextMemoryBudget !== undefined &&
        existingPart.memoryBudget.limit === nextMemoryBudget.limit &&
        existingPart.memoryBudget.used === nextMemoryBudget.used &&
        existingPart.memoryBudget.truncated === nextMemoryBudget.truncated)
    const memoryAnnotationsUnchanged =
      Boolean(existingPart?.memoryDegraded) === Boolean(nextMemoryDegraded) && budgetUnchanged
    // Idempotent guard — nothing to change in sources or any annotation.
    if (sourcesUnchanged && degradedUnchanged && memoryAnnotationsUnchanged) {
      return messages
    }
    const nextPart: SourcesPart = {
      type: "sources",
      sources: merged,
      ...(nextDegraded ? { twinDegraded: true } : {}),
      ...(nextMemoryDegraded ? { memoryDegraded: true } : {}),
      ...(nextMemoryBudget ? { memoryBudget: nextMemoryBudget } : {}),
    }
    const nextParts =
      sourcesIdx >= 0
        ? [
            ...parts.slice(0, sourcesIdx),
            nextPart as unknown as Part,
            ...parts.slice(sourcesIdx + 1),
          ]
        : [...parts, nextPart as unknown as Part]
    const nextMsg: UIMessage = { ...msg, parts: nextParts }
    const nextMessages = messages.slice()
    nextMessages[i] = nextMsg
    return nextMessages
  }
  return messages
}

/** Recalled-memory context stashed on `SendOptions.memoryContext`. */
export interface MemorySourcesContext {
  retrievedMemories: Array<{ id: string; type: string; text: string; score: number }>
  /** Recall token budget of the injection pass (shown by the recalled chip). */
  budget?: { limit: number; used: number; truncated: boolean }
  /** True when retrieval degraded (BM25-only fallback or retrieval failure). */
  degraded?: boolean
}

/**
 * Merge recalled long-term memories onto the last assistant message's
 * SourcesPart as `origin: "memory"` items, plus the pass's budget/degraded
 * annotations. Mirrors `mergeTwinSourcesIntoLastAssistant`; shares the
 * idempotent fold helper.
 */
export function mergeMemorySourcesIntoLastAssistant(
  messages: UIMessage[],
  memoryContext: MemorySourcesContext | undefined | null
): UIMessage[] {
  if (!memoryContext) return messages
  if (memoryContext.retrievedMemories.length === 0 && !memoryContext.degraded) return messages
  const memorySources: SourcesPartItem[] = memoryContext.retrievedMemories.map((m) => ({
    id: `memory-${m.id}`,
    title: m.text.length > 80 ? m.text.slice(0, 79).trimEnd() + "…" : m.text,
    snippet: m.text.length > 200 ? m.text.slice(0, 199).trimEnd() + "…" : m.text,
    origin: "memory",
    score: m.score,
  }))
  return appendSourcesToLastAssistant(messages, memorySources, {
    memoryBudget: memorySources.length > 0 ? memoryContext.budget : undefined,
    memoryDegraded: memoryContext.degraded,
  })
}

export interface AgentKnowledgeSourcesContext {
  retrievedChunks: Array<{
    chunk: {
      id: string
      knowledgeBaseId: string
      sourceId: string
      content: string
      vectorDocId: string
    }
    score: number
  }>
  citations: Array<{
    knowledgeBaseId: string
    knowledgeBaseName: string
    sourceId: string
    sourceTitle: string
    chunkId: string
    score: number
  }>
}

export interface ProjectKnowledgeSourcesContext {
  retrievedChunks: Array<{
    fileId: string
    fileName?: string
    content: string
    score: number
  }>
  degraded?: boolean
}

/** Merge workspace-scoped knowledge excerpts into the same persisted SourcesPart. */
export function mergeProjectKnowledgeSourcesIntoLastAssistant(
  messages: UIMessage[],
  context: ProjectKnowledgeSourcesContext | undefined | null
): UIMessage[] {
  if (!context || context.retrievedChunks.length === 0) return messages
  const sources: SourcesPartItem[] = context.retrievedChunks.map((chunk) => ({
    id: `project-knowledge-${chunk.fileId}`,
    title: chunk.fileName?.trim() || chunk.fileId,
    snippet:
      chunk.content.length > 200 ? `${chunk.content.slice(0, 199).trimEnd()}…` : chunk.content,
    origin: "project-knowledge",
    score: chunk.score,
  }))
  return appendSourcesToLastAssistant(messages, sources)
}

/** Merge reusable Agent Knowledge Base citations into the assistant SourcesPart. */
export function mergeAgentKnowledgeSourcesIntoLastAssistant(
  messages: UIMessage[],
  context: AgentKnowledgeSourcesContext | undefined | null
): UIMessage[] {
  if (!context || context.retrievedChunks.length === 0) return messages
  const citationByChunkId = new Map(
    context.citations.map((citation) => [citation.chunkId, citation])
  )
  const sources: SourcesPartItem[] = context.retrievedChunks.map(({ chunk, score }) => {
    const citation = citationByChunkId.get(chunk.id)
    const knowledgeBaseName = citation?.knowledgeBaseName ?? chunk.knowledgeBaseId
    const sourceTitle = citation?.sourceTitle ?? chunk.sourceId
    return {
      id: `agent-kb-${chunk.id}`,
      title: `${knowledgeBaseName} / ${sourceTitle}`,
      snippet:
        chunk.content.length > 200 ? chunk.content.slice(0, 199).trimEnd() + "…" : chunk.content,
      origin: "agent-knowledge-base",
      score,
      knowledgeBaseRef: {
        knowledgeBaseId: chunk.knowledgeBaseId,
        sourceId: chunk.sourceId,
        chunkId: chunk.id,
      },
    }
  })
  return appendSourcesToLastAssistant(messages, sources)
}
