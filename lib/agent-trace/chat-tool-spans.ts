/**
 * Bridge between Claude SDK `tool_use` / `tool_result` content blocks and
 * agent-trace `execute_tool` child spans.
 *
 * Lifecycle:
 *   - `assistant` event arrives with `tool_use` blocks → for each block we
 *     `startSpan({ operationName: 'execute_tool', parentSpanId, toolName, ... })`
 *     and stash `(toolUseId → spanId)` in a per-session map.
 *   - `user` event arrives with `tool_result` blocks → for each block we
 *     look up the cached spanId, call `endSpan` with the error status (the
 *     SDK sets `is_error: true` for failed tool calls).
 *
 * Why a separate file: keeps `hooks/chat/use-claude-chat.ts` change small
 * and lets us unit-test the block extraction without spinning up the chat
 * hook's full mock surface.
 */

import { endSpan, startSpan } from "./emitter"

/** Subset of the SDK message shape the bridge needs. We don't import
 * `@anthropic-ai/claude-agent-sdk` types here to keep the module light. */
export interface SdkMessageLike {
  type: string
  message?: {
    content?: unknown
  }
}

/** Map of `tool_use_id` → `spanId`, keyed by sessionId so concurrent
 * sessions don't collide. Cleared on session end via `clearToolSpans`. */
const pendingToolSpans = new Map<string, Map<string, string>>()

/**
 * Inspect one SDK event for tool blocks and emit / finalise the matching
 * `execute_tool` child spans. Returns the number of spans opened or closed
 * so the caller can short-circuit logging when nothing happened.
 */
export function handleSdkEventForToolSpans(args: {
  sessionId: string
  traceId: string
  parentSpanId: string
  event: SdkMessageLike
}): number {
  if (!args.sessionId || !args.parentSpanId || !args.event) return 0
  const content = extractContentArray(args.event)
  if (!content) return 0

  let mutated = 0
  if (args.event.type === "assistant") {
    for (const block of content) {
      if (!isToolUseBlock(block)) continue
      const spanId = openToolSpan({
        sessionId: args.sessionId,
        traceId: args.traceId,
        parentSpanId: args.parentSpanId,
        toolUseId: block.id,
        toolName: block.name,
      })
      if (spanId) mutated += 1
    }
  } else if (args.event.type === "user") {
    for (const block of content) {
      if (!isToolResultBlock(block)) continue
      const closed = closeToolSpan({
        sessionId: args.sessionId,
        toolUseId: block.tool_use_id,
        isError: block.is_error === true,
        resultPreview: flattenToolResultPreview(block.content),
      })
      if (closed) mutated += 1
    }
  }
  return mutated
}

/** Drop any open tool spans for a session. Called when the turn ends so
 * stale entries don't leak across sessions. Idempotent; safe to call when
 * nothing is open. */
export function clearToolSpansForSession(sessionId: string): void {
  pendingToolSpans.delete(sessionId)
}

/** Test-only: drop all pending entries. */
export function __resetToolSpansForTesting(): void {
  pendingToolSpans.clear()
}

/** Test-only: count of in-flight tool spans for one session. */
export function __pendingToolSpanCountForTesting(sessionId: string): number {
  return pendingToolSpans.get(sessionId)?.size ?? 0
}

interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input?: unknown
}

interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return v.type === "tool_use" && typeof v.id === "string" && typeof v.name === "string"
}

function isToolResultBlock(value: unknown): value is ToolResultBlock {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return v.type === "tool_result" && typeof v.tool_use_id === "string"
}

function extractContentArray(event: SdkMessageLike): unknown[] | null {
  const content = event.message?.content
  if (!Array.isArray(content)) return null
  return content
}

/** Opens a new execute_tool span; returns null when the `tool_use_id` is
 * already pending (defensive against the SDK re-delivering an event during
 * resume — we treat it as a no-op rather than open a second span). */
function openToolSpan(args: {
  sessionId: string
  traceId: string
  parentSpanId: string
  toolUseId: string
  toolName: string
}): string | null {
  const sessionMap = pendingToolSpans.get(args.sessionId) ?? new Map<string, string>()
  if (sessionMap.has(args.toolUseId)) return null

  const handle = startSpan({
    operationName: "execute_tool",
    providerName: providerFromToolName(args.toolName),
    sessionId: args.sessionId,
    surface: "chat",
    traceId: args.traceId,
    parentSpanId: args.parentSpanId,
    toolName: args.toolName,
    metadata: { toolUseId: args.toolUseId },
  })
  sessionMap.set(args.toolUseId, handle.spanId)
  pendingToolSpans.set(args.sessionId, sessionMap)
  return handle.spanId
}

function closeToolSpan(args: {
  sessionId: string
  toolUseId: string
  isError: boolean
  resultPreview?: string
}): boolean {
  const sessionMap = pendingToolSpans.get(args.sessionId)
  if (!sessionMap) return false
  const spanId = sessionMap.get(args.toolUseId)
  if (!spanId) return false
  sessionMap.delete(args.toolUseId)
  if (sessionMap.size === 0) pendingToolSpans.delete(args.sessionId)

  endSpan(spanId, {
    errorType: args.isError ? "tool_error" : undefined,
    errorMessage: args.isError && args.resultPreview ? args.resultPreview.slice(0, 512) : undefined,
    outputPreview: !args.isError ? args.resultPreview : undefined,
  })
  return true
}

/** Tool names with `mcp__` prefix or matching the built-in
 * cognia-plugin-tools bridge route through the plugin provider; everything
 * else (Read / Edit / Bash / Task / etc.) is Anthropic-native. */
function providerFromToolName(name: string): "anthropic" | "cognia.plugin" {
  if (name.startsWith("mcp__")) return "cognia.plugin"
  return "anthropic"
}

function flattenToolResultPreview(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.length > 0 ? content : undefined
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const c of content) {
      if (typeof c === "string") parts.push(c)
      else if (c && typeof c === "object") {
        const obj = c as Record<string, unknown>
        if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text)
      }
    }
    const joined = parts.join("\n").trim()
    return joined.length > 0 ? joined : undefined
  }
  return undefined
}
