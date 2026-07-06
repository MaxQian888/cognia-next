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
  SendContent,
  SendContentBlock,
} from "./types"
import type {
  A2UIPart,
  ArtifactPart,
  McpResultBlock,
  SourcesPart,
  SourcesPartItem,
} from "./parts-extensions"
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

/**
 * Map a `tool_use` block's name + input to an ArtifactPart when the call
 * matches the `artifact_create` / `artifact_update` contract. Pure function —
 * does not write to `useArtifactStore`; callers that need the row created
 * (Tauri sidecar bridge, plugin API) handle the store side themselves.
 */
export function extractArtifactPartFromToolUse(block: BetaToolUseBlock): ArtifactPart | null {
  if (block.name !== "artifact_create" && block.name !== "artifact_update") return null
  const input = (block.input ?? {}) as Record<string, unknown>
  const artifactId =
    typeof input.id === "string"
      ? input.id
      : typeof input.artifactId === "string"
        ? input.artifactId
        : null
  const title = typeof input.title === "string" ? input.title : null
  if (!artifactId || !title) return null
  const kindRaw =
    typeof input.type === "string"
      ? input.type
      : typeof input.kind === "string"
        ? input.kind
        : "code"
  const allowed = new Set(["code", "react", "html", "svg", "mermaid", "document", "chart", "math"])
  const kind = (allowed.has(kindRaw) ? kindRaw : "code") as ArtifactPart["kind"]
  return { type: "artifact", artifactId, title, kind }
}

type Parts = UIMessage["parts"]
type Part = Parts[number]

export interface UsageInfo {
  inputTokens?: number
  outputTokens?: number
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
      const artifactPart = extractArtifactPartFromToolUse(b)
      if (artifactPart) {
        return artifactPart as unknown as Part
      }
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
          return JSON.stringify(c)
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
      // replace-by-id (same Anthropic message id). Tool_use blocks are left to
      // the final message — only text + reasoning drive the live preview.
      return {
        messages: applyStreamEvent(messages, evt as unknown as SDKPartialAssistantMessage),
        turnComplete: false,
      }
    case "result": {
      const result = evt as SDKResultMessage
      return {
        messages: attachUsageToLastAssistant(messages, result),
        turnComplete: true,
        result,
      }
    }
    case "system": {
      // System subtypes: `compact_boundary` (context compaction) and
      // `permission_denied` (a tool auto-denied without an interactive prompt —
      // classifier / dontAsk / deny rule). `init` and the rest are metadata the
      // UI ignores.
      const sys = evt as unknown as {
        subtype?: string
        uuid?: string
        compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number }
        tool_name?: string
        decision_reason?: string
        message?: string
        // hook_fire fields (synthetic event emitted by the Rust hook runtime —
        // see src-tauri/src/claude/sidecar.rs:emit_hook_fire)
        hook_event?: string
        outcome?: "blocked" | "context" | "warning"
        block?: string
        additional_context?: string
        warnings?: string[]
      }
      if (sys.subtype === "compact_boundary") {
        return { messages: appendCompactBoundary(messages, sys), turnComplete: false }
      }
      if (sys.subtype === "hook_fire") {
        return {
          messages: appendHookNotice(messages, {
            type: "hook-notice",
            event: sys.hook_event ?? "",
            toolName: sys.tool_name,
            outcome: sys.outcome ?? "warning",
            block: sys.block,
            additionalContext: sys.additional_context,
            warnings: sys.warnings ?? [],
          }),
          turnComplete: false,
        }
      }
      if (sys.subtype === "permission_denied") {
        // A hook-caused denial already renders as a `hook_fire` row; the deny
        // payload Rust writes is prefixed `"hook denied:"`. Suppress the generic
        // permission-denied notice so the same block isn't shown twice.
        const reason = sys.decision_reason || sys.message
        if (reason?.startsWith("hook denied:")) {
          return { messages, turnComplete: false }
        }
        return {
          messages: appendSessionNotice(messages, {
            type: "session-notice",
            variant: "permission-denied",
            uuid: sys.uuid,
            toolName: sys.tool_name,
            reason,
          }),
          turnComplete: false,
        }
      }
      return { messages, turnComplete: false }
    }
    case "rate_limit_event": {
      // Surface a notice only when the subscription rate limit is restrictive
      // (`allowed_warning` / `rejected`). The SDK emits this every turn with
      // `allowed` during normal use — ignore those to avoid transcript spam.
      const info = (evt as unknown as { rate_limit_info?: RateLimitInfo }).rate_limit_info
      if (!info || info.status === "allowed") {
        return { messages, turnComplete: false }
      }
      return {
        messages: appendSessionNotice(
          messages,
          {
            type: "session-notice",
            variant: "rate-limit",
            uuid: (evt as unknown as { uuid?: string }).uuid,
            status: info.status,
            rateLimitType: info.rateLimitType,
            resetsAt: info.resetsAt,
          },
          // Collapse consecutive rate-limit notices so a multi-turn warning
          // window leaves one (latest) marker rather than one per turn.
          true
        ),
        turnComplete: false,
      }
    }
    default:
      return { messages, turnComplete: false }
  }
}

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

/**
 * Append a non-conversational "session notice" marker (auto-deny / rate-limit)
 * to the transcript, mirroring the compact-boundary projection. When
 * `collapsePrev` is set and the last message is a same-variant notice, it is
 * replaced rather than appended (used to de-spam per-turn rate-limit events).
 */
function appendSessionNotice(
  messages: UIMessage[],
  data: SessionNoticePartData,
  collapsePrev = false
): UIMessage[] {
  const id = `notice-${data.variant}-${data.uuid ?? crypto.randomUUID()}`
  const marker: UIMessage = {
    id,
    role: "system",
    parts: [data as unknown as UIMessage["parts"][number]],
  }
  if (collapsePrev && messages.length > 0) {
    const last = messages[messages.length - 1]
    const lastPart = last.parts?.[0] as { type?: string; variant?: string } | undefined
    if (
      last.role === "system" &&
      lastPart?.type === "session-notice" &&
      lastPart.variant === data.variant
    ) {
      const copy = messages.slice(0, -1)
      copy.push(marker)
      return copy
    }
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
    if ((parts[i] as { type?: string }).type === partType) {
      pIdx = i
      break
    }
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
 * Apply a `stream_event` (SDKPartialAssistantMessage) to the in-progress
 * assistant message. `message_start` seeds an empty assistant message keyed by
 * the Anthropic message id (and attaches live input/cache usage); each
 * `content_block_delta` (text_delta / thinking_delta) grows it; `message_delta`
 * merges the running output-token usage. Other raw events (content_block
 * start/stop, message_stop) are ignored — the final `assistant` message carries
 * the canonical content and the `result` message the authoritative usage.
 */
function applyStreamEvent(messages: UIMessage[], evt: SDKPartialAssistantMessage): UIMessage[] {
  const raw = evt.event as unknown as {
    type?: string
    message?: { id?: string; usage?: Record<string, unknown> }
    usage?: Record<string, unknown>
    delta?: { type?: string; text?: string; thinking?: string }
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

  if (raw.type === "content_block_delta") {
    const delta = raw.delta
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
    const newPart = {
      ...oldPart,
      state: tr.is_error ? "output-error" : "output-available",
      ...(tr.is_error ? { errorText: outputText } : { output: outputText }),
      ...(mcpContent ? { mcpContent } : {}),
    } as unknown as Part

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
 */
function attachUsageToLastAssistant(messages: UIMessage[], result: SDKResultMessage): UIMessage[] {
  const usage = extractUsage(result)
  if (!usage) return messages

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    const prior = ((msg as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<
      string,
      unknown
    >
    const merged: UIMessage = {
      ...msg,
      ...({ metadata: { ...prior, usage } } as { metadata: Record<string, unknown> }),
    }
    const out = messages.slice()
    out[i] = merged
    return out
  }
  return messages
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
 * content blocks (text + image). Image blocks become `file` parts in the
 * UIMessage so AI SDK Elements render thumbnails.
 */
export function makeUserMessage(content: SendContent, id?: string): UIMessage {
  const messageId = id ?? `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  if (typeof content === "string") {
    return {
      id: messageId,
      role: "user",
      parts: [{ type: "text", text: content, state: "done" } as unknown as Part],
    }
  }

  const parts: Parts = []
  for (const block of content) {
    if (block.type === "text") {
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
      } as unknown as Part)
    }
  }
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
  opts?: { twinDegraded?: boolean }
): UIMessage[] {
  const wantDegraded = opts?.twinDegraded
  // A degraded twin turn must still annotate the message even with zero
  // additions — that's the whole point of the warning. Only short-circuit when
  // there is genuinely nothing to do.
  if (additions.length === 0 && !wantDegraded) return messages
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
    const sourcesUnchanged =
      merged.length === existingSources.length &&
      merged.every((s, idx) => s.id === existingSources[idx]?.id)
    const degradedUnchanged = Boolean(existingPart?.twinDegraded) === Boolean(nextDegraded)
    // Idempotent guard — nothing to change in either sources or the flag.
    if (sourcesUnchanged && degradedUnchanged) {
      return messages
    }
    const nextPart: SourcesPart = {
      type: "sources",
      sources: merged,
      ...(nextDegraded ? { twinDegraded: true } : {}),
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
}

/**
 * Merge recalled long-term memories onto the last assistant message's
 * SourcesPart as `origin: "memory"` items. Mirrors
 * `mergeTwinSourcesIntoLastAssistant`; shares the idempotent fold helper.
 */
export function mergeMemorySourcesIntoLastAssistant(
  messages: UIMessage[],
  memoryContext: MemorySourcesContext | undefined | null
): UIMessage[] {
  if (!memoryContext || memoryContext.retrievedMemories.length === 0) return messages
  const memorySources: SourcesPartItem[] = memoryContext.retrievedMemories.map((m) => ({
    id: `memory-${m.id}`,
    title: m.text.length > 80 ? m.text.slice(0, 79).trimEnd() + "…" : m.text,
    snippet: m.text.length > 200 ? m.text.slice(0, 199).trimEnd() + "…" : m.text,
    origin: "memory",
    score: m.score,
  }))
  return appendSourcesToLastAssistant(messages, memorySources)
}
