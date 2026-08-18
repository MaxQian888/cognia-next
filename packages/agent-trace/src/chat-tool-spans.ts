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

export const TOOL_SPAN_SYSTEM_EVENTS = {
  TOOL_CALL_STARTED: "system:tool:started",
  TOOL_CALL_COMPLETED: "system:tool:completed",
} as const

export type ToolSpanEventPublisher = (eventType: string, payload: unknown) => void

let toolSpanEventPublisher: ToolSpanEventPublisher | null = null

export function setToolSpanEventPublisher(publisher: ToolSpanEventPublisher | null): void {
  toolSpanEventPublisher = publisher
}

/** Subset of the SDK message shape the bridge needs. We don't import
 * `@anthropic-ai/claude-agent-sdk` types here to keep the module light. */
export interface SdkMessageLike {
  type: string
  message?: {
    content?: unknown
  }
  /**
   * Set by the SDK on frames produced INSIDE a subagent, naming the `Task`
   * tool call that spawned it. It is the only signal that separates a
   * subagent's tool calls from the parent turn's own, and dropping it is what
   * flattened every trace: a subagent's ten tool calls appeared as siblings of
   * the `Task` call rather than beneath it.
   */
  parent_tool_use_id?: string | null
}

const DEFAULT_STALE_TOOL_SPAN_MAX_AGE_MS = 30 * 60 * 1_000
let nowSource: () => number = () => Date.now()

interface PendingToolSpan {
  spanId: string
  openedAt: number
}

/**
 * Span id of every tool call seen for a session, kept past `endSpan` so a
 * subagent frame arriving after its `Task` tool closed can still name its
 * parent. Bounded per session and dropped wholesale by `clearToolSpansForSession`.
 */
const toolSpanIdsBySession = new Map<string, Map<string, string>>()

/** Cap on remembered parents per session — a long turn must not grow unbounded. */
const MAX_REMEMBERED_TOOL_SPANS = 500

/** Map of `tool_use_id` → pending span metadata, keyed by sessionId so
 * concurrent sessions don't collide. Cleared on session end via
 * `clearToolSpans`. */
const pendingToolSpans = new Map<string, Map<string, PendingToolSpan>>()

function nowMs(): number {
  return nowSource()
}

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

  // A frame from inside a subagent nests under the `Task` tool call that
  // spawned it; anything else hangs off the turn root.
  const parentSpanId = resolveParentSpanId(
    args.sessionId,
    args.event.parent_tool_use_id,
    args.parentSpanId
  )

  let mutated = 0
  if (args.event.type === "assistant") {
    if (content.some(isToolUseBlock)) {
      reapStaleToolSpans()
    }
    for (const block of content) {
      if (!isToolUseBlock(block)) continue
      const spanId = openToolSpan({
        sessionId: args.sessionId,
        traceId: args.traceId,
        parentSpanId,
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
  toolSpanIdsBySession.delete(sessionId)
}

/**
 * Span id previously opened for `toolUseId`, or `undefined` when this session
 * never saw that tool call.
 *
 * Exported so emitters that run INSIDE a tool call — an MCP round-trip, a
 * plugin's WASM invocation, a nested provider request — can name the tool span
 * as their parent instead of flattening onto the turn root.
 */
export function toolSpanIdFor(sessionId: string, toolUseId: string): string | undefined {
  return toolSpanIdsBySession.get(sessionId)?.get(toolUseId)
}

/**
 * Effective parent for a frame: the `Task` tool's span when the SDK marked the
 * frame as a subagent's, otherwise the caller-supplied turn root. An unknown
 * `parent_tool_use_id` (a resumed session whose opening frame we never saw)
 * falls back to the root rather than orphaning the span off the trace.
 */
function resolveParentSpanId(
  sessionId: string,
  parentToolUseId: string | null | undefined,
  fallback: string
): string {
  if (typeof parentToolUseId !== "string" || parentToolUseId.length === 0) return fallback
  return toolSpanIdFor(sessionId, parentToolUseId) ?? fallback
}

/** Remember a tool call's span id for later parent lookups, bounded per session. */
function rememberToolSpanId(sessionId: string, toolUseId: string, spanId: string): void {
  let known = toolSpanIdsBySession.get(sessionId)
  if (!known) {
    known = new Map<string, string>()
    toolSpanIdsBySession.set(sessionId, known)
  }
  known.set(toolUseId, spanId)
  // Insertion-ordered: evicting the oldest keys drops the tool calls least
  // likely to still be parenting live work.
  while (known.size > MAX_REMEMBERED_TOOL_SPANS) {
    const oldest = known.keys().next()
    if (oldest.done) break
    known.delete(oldest.value)
  }
}

/** Drop pending tool spans that never received a matching tool_result. These
 * can happen when the SDK resumes after an interrupted turn and does not
 * replay the result block for the old tool_use. */
export function reapStaleToolSpans(maxAgeMs = DEFAULT_STALE_TOOL_SPAN_MAX_AGE_MS): number {
  const now = nowMs()
  const maxAge =
    Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : DEFAULT_STALE_TOOL_SPAN_MAX_AGE_MS
  let dropped = 0

  for (const [sessionId, sessionMap] of pendingToolSpans) {
    for (const [toolUseId, pending] of sessionMap) {
      if (now - pending.openedAt > maxAge) {
        sessionMap.delete(toolUseId)
        dropped += 1
      }
    }
    if (sessionMap.size === 0) pendingToolSpans.delete(sessionId)
  }

  return dropped
}

/** Test-only: drop all pending entries. */
export function __resetToolSpansForTesting(): void {
  pendingToolSpans.clear()
  toolSpanIdsBySession.clear()
  nowSource = () => Date.now()
  toolSpanEventPublisher = null
}

/** Test-only: count of in-flight tool spans for one session. */
export function __pendingToolSpanCountForTesting(sessionId: string): number {
  return pendingToolSpans.get(sessionId)?.size ?? 0
}

/** Test-only: inject a deterministic clock without global Date monkey-patching. */
export function __setToolSpanNowForTesting(fn: (() => number) | null): void {
  nowSource = fn ?? (() => Date.now())
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
  const sessionMap = pendingToolSpans.get(args.sessionId) ?? new Map<string, PendingToolSpan>()
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
  sessionMap.set(args.toolUseId, { spanId: handle.spanId, openedAt: nowMs() })
  pendingToolSpans.set(args.sessionId, sessionMap)
  rememberToolSpanId(args.sessionId, args.toolUseId, handle.spanId)
  // Notify observability plugins of the per-tool start (ids + tool name only).
  publishToolSpanEvent(TOOL_SPAN_SYSTEM_EVENTS.TOOL_CALL_STARTED, {
    sessionId: args.sessionId,
    toolUseId: args.toolUseId,
    toolName: args.toolName,
    provider: providerFromToolName(args.toolName),
  })
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
  const pending = sessionMap.get(args.toolUseId)
  if (!pending) return false
  sessionMap.delete(args.toolUseId)
  if (sessionMap.size === 0) pendingToolSpans.delete(args.sessionId)

  endSpan(pending.spanId, {
    errorType: args.isError ? "tool_error" : undefined,
    errorMessage: args.isError && args.resultPreview ? args.resultPreview.slice(0, 512) : undefined,
    outputPreview: !args.isError ? args.resultPreview : undefined,
  })
  // Notify observability plugins of the per-tool completion (ids + isError
  // only — never the result preview / output, which can carry user content).
  publishToolSpanEvent(TOOL_SPAN_SYSTEM_EVENTS.TOOL_CALL_COMPLETED, {
    sessionId: args.sessionId,
    toolUseId: args.toolUseId,
    isError: args.isError,
  })
  return true
}

function publishToolSpanEvent(eventType: string, payload: unknown): void {
  if (!toolSpanEventPublisher) return
  try {
    toolSpanEventPublisher(eventType, payload)
  } catch {
    // Tool-span event publication is best-effort telemetry.
  }
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
