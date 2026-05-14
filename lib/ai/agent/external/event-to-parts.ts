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
  ExternalAgentMessageDeltaEvent,
  ExternalAgentThinkingEvent,
  ExternalAgentToolResultEvent,
  ExternalAgentToolUseEndEvent,
  ExternalAgentToolUseStartEvent,
} from "@/types/agent/external-agent"
import type { ArtifactPart } from "@/lib/claude/parts-extensions"

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
    case "tool_use_start":
      return applyToolUseStart(parts, event as ExternalAgentToolUseStartEvent)
    case "tool_use_end":
      return applyToolUseEnd(parts, event as ExternalAgentToolUseEndEvent)
    case "tool_result":
      return applyToolResult(parts, event as ExternalAgentToolResultEvent)
    default:
      return parts as Part[]
  }
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
  const artifact = artifactPartFromToolUse(event.toolName, event.rawInput ?? {})
  if (artifact) {
    return [...parts, artifact as unknown as Part]
  }
  const fresh: MutablePart = {
    type: `tool-${event.toolName}`,
    toolCallId: event.toolUseId,
    state: "input-available",
    input: event.rawInput ?? {},
  }
  return [...parts, fresh as unknown as Part]
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
  const updated: MutablePart = {
    ...cur,
    state: event.isError ? "output-error" : "output-available",
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

const ARTIFACT_KIND_ALLOWED = new Set([
  "code",
  "react",
  "html",
  "svg",
  "mermaid",
  "document",
  "chart",
  "math",
])

function artifactPartFromToolUse(
  toolName: string,
  rawInput: Record<string, unknown>
): ArtifactPart | null {
  if (toolName !== "artifact_create" && toolName !== "artifact_update") return null
  const artifactId =
    typeof rawInput.id === "string"
      ? rawInput.id
      : typeof rawInput.artifactId === "string"
        ? (rawInput.artifactId as string)
        : null
  const title = typeof rawInput.title === "string" ? rawInput.title : null
  if (!artifactId || !title) return null
  const kindRaw =
    typeof rawInput.type === "string"
      ? rawInput.type
      : typeof rawInput.kind === "string"
        ? rawInput.kind
        : "code"
  const kind = (ARTIFACT_KIND_ALLOWED.has(kindRaw) ? kindRaw : "code") as ArtifactPart["kind"]
  return { type: "artifact", artifactId, title, kind }
}
