// Translates SDKMessage events from the Claude Agent SDK (via the sidecar)
// into UIMessage parts in the shape AI SDK Elements expect.

import type { UIMessage } from "ai"
import type {
  BetaContentBlock,
  BetaMessage,
  BetaToolResultBlock,
  BetaToolUseBlock,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SendContent,
  SendContentBlock,
} from "./types"
import type { A2UIPart, ArtifactPart, SourcesPart, SourcesPartItem } from "./parts-extensions"
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
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
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
      return [{ type: "text", text: "", state: "done" } as unknown as Part]
    }
    return splitTextForA2UI(text)
  }
  const single = blockToPart(block)
  return single ? [single] : []
}

function splitTextForA2UI(text: string): Part[] {
  if (!text) return []
  // Fast-path: skip the regex if no a2ui marker in sight.
  if (!/```a2ui|"createSurface"|"updateComponents"|"surface"\s*:/i.test(text)) {
    return [textPart(text)]
  }
  const extracted = extractA2UIFromResponse(text)
  if (!extracted) return [textPart(text)]
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
  if (before.trim()) out.push(textPart(before))
  out.push(a2ui as unknown as Part)
  if (after.trim()) out.push(textPart(after))
  return out
}

function textPart(text: string): Part {
  return { type: "text", text, state: "done" } as unknown as Part
}

function blockToPart(block: BetaContentBlock): Part | null {
  switch (block.type) {
    case "text": {
      const b = block as Extract<BetaContentBlock, { type: "text" }>
      return {
        type: "text",
        text: b.text ?? "",
        state: "done",
      } as unknown as Part
    }
    case "thinking": {
      const b = block as { type: "thinking"; thinking?: string }
      return {
        type: "reasoning",
        text: b.thinking ?? "",
        state: "done",
      } as unknown as Part
    }
    case "tool_use": {
      const b = block as BetaToolUseBlock
      const artifactPart = extractArtifactPartFromToolUse(b)
      if (artifactPart) {
        return artifactPart as unknown as Part
      }
      return {
        type: `tool-${b.name}`,
        toolCallId: b.id,
        state: "input-available",
        input: b.input,
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
    case "result": {
      const result = evt as SDKResultMessage
      return {
        messages: attachUsageToLastAssistant(messages, result),
        turnComplete: true,
        result,
      }
    }
    case "system": {
      // The SDK emits a `compact_boundary` system message when it compacts the
      // conversation (manual `/compact` or automatic at the threshold). Every
      // other system subtype (`init`, …) is metadata the UI ignores.
      const sys = evt as unknown as {
        subtype?: string
        uuid?: string
        compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number }
      }
      if (sys.subtype !== "compact_boundary") {
        return { messages, turnComplete: false }
      }
      return {
        messages: appendCompactBoundary(messages, sys),
        turnComplete: false,
      }
    }
    default:
      return { messages, turnComplete: false }
  }
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
    compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number }
  }
): UIMessage[] {
  const meta = sys.compact_metadata
  const id = `compact-${sys.uuid ?? crypto.randomUUID()}`
  const marker: UIMessage = {
    id,
    role: "system",
    parts: [
      {
        type: "compact-boundary",
        trigger: meta?.trigger,
        preTokens: meta?.pre_tokens,
        postTokens: meta?.post_tokens,
      } as unknown as UIMessage["parts"][number],
    ],
  }
  return [...messages, marker]
}

function appendAssistantMessage(messages: UIMessage[], evt: SDKAssistantMessage): UIMessage[] {
  const parts = buildAssistantParts(evt.message)
  // We key UI messages by the Anthropic message id. If a prior partial-stream
  // version is in the list, replace it with the canonical full version.
  const id = evt.message.id ?? evt.uuid
  const idx = messages.findIndex((m) => m.id === id)
  const next: UIMessage = {
    id,
    role: "assistant",
    parts,
  }
  if (idx >= 0) {
    const copy = messages.slice()
    copy[idx] = next
    return copy
  }
  return [...messages, next]
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
    const newPart = {
      ...oldPart,
      state: tr.is_error ? "output-error" : "output-available",
      ...(tr.is_error ? { errorText: outputText } : { output: outputText }),
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

  const info: UsageInfo = {
    inputTokens: num("input_tokens"),
    outputTokens: num("output_tokens"),
    cacheCreationInputTokens: num("cache_creation_input_tokens"),
    cacheReadInputTokens: num("cache_read_input_tokens"),
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
  return appendSourcesToLastAssistant(messages, [...chunkSources, ...styleSources])
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
  additions: SourcesPartItem[]
): UIMessage[] {
  if (additions.length === 0) return messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    const parts = msg.parts
    const sourcesIdx = parts.findIndex((p) => (p as { type?: string }).type === "sources")
    const existingPart = sourcesIdx >= 0 ? (parts[sourcesIdx] as unknown as SourcesPart) : null
    const existingSources = existingPart?.sources ?? []
    const merged = mergeSources(existingSources, additions)
    // Idempotent guard — same length + same ids means we already injected.
    if (
      merged.length === existingSources.length &&
      merged.every((s, idx) => s.id === existingSources[idx]?.id)
    ) {
      return messages
    }
    const nextPart: SourcesPart = { type: "sources", sources: merged }
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
