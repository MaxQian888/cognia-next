/**
 * Pure mapper that turns a stream of `ExternalAgentEvent`s into the
 * `UIMessage.parts[]` shape used by the chat renderer. Decoupling the
 * adapter from the manager keeps the rendering layer testable without
 * spinning up an ACP subprocess.
 *
 * The function is stateless: each invocation takes the *current* parts
 * array plus a new event, and returns the next array. The chat hook
 * accumulates this into a single assistant `UIMessage`.
 *
 * Supported tracks (one part per channel):
 *   - text          ← `message_delta { type:"text" }`
 *   - reasoning     ← `thinking` + `message_delta { type:"thinking" }`
 *   - tool-<name>   ← `tool_use_start` / `tool_use_end`
 *   - tool result   ← `tool_result` patched into the matching tool part
 *   - artifact      ← tool_use with name `artifact_create` / `artifact_update`
 *
 * Events the function does NOT route into parts (permission_request,
 * plan_update, commands_update, …) are returned unchanged so the caller
 * can route them through dedicated UI channels (e.g. the existing
 * pendingApprovals store).
 */

import type { UIMessage } from "ai"
import type {
  ExternalAgentEvent,
  ExternalAgentCommentaryDeltaEvent,
  ExternalAgentHookFireEvent,
  ExternalAgentMessageDeltaEvent,
  ExternalAgentThinkingEvent,
  ExternalAgentToolCallUpdateEvent,
  ExternalAgentToolResultEvent,
  ExternalAgentToolUseEndEvent,
  ExternalAgentToolUseStartEvent,
} from "@/types/agent/external-agent"
import { artifactPartFromToolResult } from "@/lib/artifacts/tool-part"

type Part = UIMessage["parts"][number]

interface MutablePart {
  type: string
  text?: string
  state?: string
  toolCallId?: string
  input?: unknown
  output?: unknown
  errorText?: string
  [key: string]: unknown
}

/**
 * Apply a single event to `parts` and return the next array. Pure; never
 * mutates the input. When the event has no parts-side effect, the input
 * reference is returned so callers can cheaply detect "no change".
 */
export function applyExternalAgentEventToParts(
  parts: readonly Part[],
  event: ExternalAgentEvent
): Part[] {
  switch (event.type) {
    case "message_delta":
      return applyMessageDelta(parts, event as ExternalAgentMessageDeltaEvent)
    case "thinking":
      return applyThinking(parts, event as ExternalAgentThinkingEvent)
    case "commentary_delta":
      return applyCommentaryDelta(parts, event as ExternalAgentCommentaryDeltaEvent)
    case "tool_use_start":
      return applyToolUseStart(parts, event as ExternalAgentToolUseStartEvent)
    case "tool_call_update":
      return applyToolCallUpdate(parts, event as ExternalAgentToolCallUpdateEvent)
    case "tool_use_end":
      return applyToolUseEnd(parts, event as ExternalAgentToolUseEndEvent)
    case "tool_result":
      return applyToolResult(parts, event as ExternalAgentToolResultEvent)
    case "hook_fire":
      return applyHookFire(parts, event as ExternalAgentHookFireEvent)
    default:
      return parts as Part[]
  }
}

// Project a consequential hook fire into an inline `hook-notice` part, sitting
// where it fired among the turn's other parts (e.g. right where a blocked tool
// would have been). Renders via MessageRenderer's `hook-notice` part case,
// reusing the same row UI as the built-in agent's hook notices.
function applyHookFire(parts: readonly Part[], event: ExternalAgentHookFireEvent): Part[] {
  const part: MutablePart = {
    type: "hook-notice",
    event: event.event,
    toolName: event.toolName,
    outcome: event.outcome,
    block: event.block,
    additionalContext: event.additionalContext,
    warnings: event.warnings ?? [],
  }
  return [...parts, part as unknown as Part]
}

/**
 * Convenience helper for tests / callers with a full event stream — applies
 * events in order and returns the final parts array.
 */
export function buildPartsFromExternalAgentEvents(events: readonly ExternalAgentEvent[]): Part[] {
  let parts: Part[] = []
  for (const event of events) {
    parts = applyExternalAgentEventToParts(parts, event)
  }
  return parts
}

// ---- per-event helpers ---------------------------------------------------

function applyMessageDelta(parts: readonly Part[], event: ExternalAgentMessageDeltaEvent): Part[] {
  if (!event.delta || typeof event.delta.text !== "string") return parts as Part[]
  if (event.delta.type === "thinking") {
    return appendToOrCreateLast(parts, "reasoning", event.delta.text)
  }
  return appendToOrCreateLast(parts, "text", event.delta.text)
}

function applyThinking(parts: readonly Part[], event: ExternalAgentThinkingEvent): Part[] {
  if (typeof event.thinking !== "string") return parts as Part[]
  return appendToOrCreateLast(parts, "reasoning", event.thinking)
}

function applyCommentaryDelta(
  parts: readonly Part[],
  event: ExternalAgentCommentaryDeltaEvent
): Part[] {
  const messageId = event.messageId
  let index = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] as MutablePart
    const data = part.data as Record<string, unknown> | undefined
    if (
      part.type === "data-commentary" &&
      (messageId === undefined || data?.messageId === messageId)
    ) {
      index = i
      break
    }
  }

  if (index < 0 && !event.text) return parts as Part[]
  const previous =
    index >= 0
      ? (((parts[index] as MutablePart).data as Record<string, unknown> | undefined) ?? {})
      : {}
  const next: MutablePart = {
    type: "data-commentary",
    data: {
      ...previous,
      ...(messageId ? { messageId } : {}),
      text: `${typeof previous.text === "string" ? previous.text : ""}${event.text}`,
      state: event.done ? "done" : "streaming",
      ...(event.source ? { source: event.source } : {}),
    },
  }
  if (index < 0) return [...parts, next as unknown as Part]
  return [...parts.slice(0, index), next as unknown as Part, ...parts.slice(index + 1)]
}

function appendToOrCreateLast(
  parts: readonly Part[],
  type: "text" | "reasoning",
  text: string
): Part[] {
  if (!text) return parts as Part[]
  const last = parts[parts.length - 1] as MutablePart | undefined
  if (last && last.type === type) {
    const merged: MutablePart = {
      ...last,
      text: `${last.text ?? ""}${text}`,
      state: "done",
    }
    return [...parts.slice(0, -1), merged as unknown as Part]
  }
  const fresh: MutablePart = { type, text, state: "done" }
  return [...parts, fresh as unknown as Part]
}

function applyToolUseStart(parts: readonly Part[], event: ExternalAgentToolUseStartEvent): Part[] {
  const existingIndex = findToolIndexByCallId(parts, event.toolUseId)
  if (existingIndex >= 0) {
    const current = parts[existingIndex] as MutablePart
    const previousMetadata = (current.toolMetadata as Record<string, unknown> | undefined) ?? {}
    const toolMetadata = { ...previousMetadata, ...(event.toolMetadata ?? {}) }
    const updated: MutablePart = {
      ...current,
      ...(event.title ? { title: event.title } : {}),
      ...(event.rawInput ? { input: event.rawInput } : {}),
      ...(Object.keys(toolMetadata).length > 0 ? { toolMetadata } : {}),
    }
    return [
      ...parts.slice(0, existingIndex),
      updated as unknown as Part,
      ...parts.slice(existingIndex + 1),
    ]
  }

  // No artifact part here: a tool_use is seen before the call runs, so the id
  // in it is the model's guess rather than the one the host wrote. The part is
  // emitted from the result in `applyToolResult`.
  const fresh: MutablePart = {
    type: `tool-${event.toolName}`,
    toolCallId: event.toolUseId,
    state: "input-available",
    input: event.rawInput ?? {},
    ...(event.title ? { title: event.title } : {}),
    ...(event.toolMetadata ? { toolMetadata: event.toolMetadata } : {}),
  }
  return [...parts, fresh as unknown as Part]
}

function applyToolCallUpdate(
  parts: readonly Part[],
  event: ExternalAgentToolCallUpdateEvent
): Part[] {
  const idx = findToolIndexByCallId(parts, event.toolCallId)
  if (idx < 0) return parts as Part[]
  const cur = parts[idx] as MutablePart
  const previousMetadata = (cur.toolMetadata as Record<string, unknown> | undefined) ?? {}
  const toolMetadata = {
    ...previousMetadata,
    ...(event.kind ? { kind: event.kind } : {}),
    ...(event.locations ? { locations: event.locations } : {}),
  }
  const updated: MutablePart = {
    ...cur,
    ...(event.title ? { title: event.title } : {}),
    ...(event.rawInput ? { input: event.rawInput } : {}),
    ...(Object.keys(toolMetadata).length > 0 ? { toolMetadata } : {}),
  }
  return [...parts.slice(0, idx), updated as unknown as Part, ...parts.slice(idx + 1)]
}

function applyToolUseEnd(parts: readonly Part[], event: ExternalAgentToolUseEndEvent): Part[] {
  const idx = findToolIndexByCallId(parts, event.toolUseId)
  if (idx < 0) return parts as Part[]
  const cur = parts[idx] as MutablePart
  const updated: MutablePart = {
    ...cur,
    input: event.input ?? cur.input,
  }
  return [...parts.slice(0, idx), updated as unknown as Part, ...parts.slice(idx + 1)]
}

function applyToolResult(parts: readonly Part[], event: ExternalAgentToolResultEvent): Part[] {
  const idx = findToolIndexByCallId(parts, event.toolUseId)
  if (idx < 0) return parts as Part[]
  const cur = parts[idx] as MutablePart
  const previousMetadata = (cur.toolMetadata as Record<string, unknown> | undefined) ?? {}
  const toolMetadata = {
    ...previousMetadata,
    ...(event.toolMetadata ?? {}),
    ...(event.kind ? { kind: event.kind } : {}),
    ...(event.locations ? { locations: event.locations } : {}),
  }
  // A successful artifact/canvas tool replaces its tool card with the artifact
  // card — this is the first point where the host-written id is known.
  const artifactPart = event.isError
    ? null
    : artifactPartFromToolResult(
        // The result event carries no tool name; the part it is patching does.
        typeof cur.type === "string" ? cur.type.replace(/^tool-/, "") : "",
        event.result,
        { toolCallId: event.toolUseId }
      )
  if (artifactPart) {
    return [...parts.slice(0, idx), artifactPart as unknown as Part, ...parts.slice(idx + 1)]
  }

  const updated: MutablePart = {
    ...cur,
    state: event.isError ? "output-error" : "output-available",
    ...(event.title ? { title: event.title } : {}),
    ...(Object.keys(toolMetadata).length > 0 ? { toolMetadata } : {}),
    ...(event.rawInput ? { input: event.rawInput } : {}),
    output: event.result,
    errorText: event.isError ? errorTextOf(event.result) : cur.errorText,
  }
  return [...parts.slice(0, idx), updated as unknown as Part, ...parts.slice(idx + 1)]
}

function findToolIndexByCallId(parts: readonly Part[], toolUseId: string): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] as MutablePart
    if (p.toolCallId === toolUseId) return i
  }
  return -1
}

function errorTextOf(result: string | Record<string, unknown>): string {
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

// ---- artifact detection --------------------------------------------------
