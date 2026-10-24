/**
 * Streaming preview of an A2UI fence that is still being generated.
 *
 * The finalized pipeline (`extractA2UIBlocks` → `a2ui` message part) only sees
 * a fence once it is closed and its JSON is complete. While the model is still
 * writing, this module turns the prefix it has produced so far into the same
 * validated A2UI messages, so the chat can draw the structure as it arrives.
 *
 * Two rules keep a preview honest:
 * - Scalars are never truncated. A half-written string, number or key is cut
 *   back to the previous complete value instead of being repaired, so a preview
 *   never shows `12` where the model is writing `123`. An object may arrive
 *   with a subset of its keys (a component gains props as they stream), and a
 *   component that does not yet name its `id` and `component` is held back.
 * - It renders into its own inline surface (`A2UI_PREVIEW_SURFACE_PREFIX`),
 *   never into the surface the sealed message will create. The preview is
 *   read-only and is deleted when the sealed part replaces it.
 */

import { parseA2UIInput } from "./parser"
import type { A2UIServerMessage } from "@/types/a2ui/schema"

/** Deepest nesting a preview follows; real surfaces sit far below it. */
export const A2UI_PREVIEW_MAX_DEPTH = 64

// Surface ids reserved for in-flight previews; plugins and persistence skip
// them, and the parser refuses them in model-written payloads.
export { A2UI_PREVIEW_SURFACE_PREFIX, isA2UIPreviewSurfaceId } from "./parser"

export interface CompletedPartialJson {
  /** JSON text that parses, or null when no complete value exists yet. */
  json: string | null
  /** True when the input already was one complete JSON value. */
  complete: boolean
}

/**
 * Close a truncated JSON prefix at its last structurally complete point.
 *
 * Safe cut points are: right after an opening bracket (an empty container is a
 * valid value), right before a separating comma, and right after a closing
 * bracket. Everything after the last safe point is dropped and the brackets
 * still open at that point are closed.
 */
export function completePartialJson(text: string): CompletedPartialJson {
  const start = text.search(/[{[]/)
  if (start === -1) return { json: null, complete: false }

  const stack: string[] = []
  let inString = false
  let escaped = false
  let cutIndex = -1
  let cutStack: string[] = []

  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === "{" || char === "[") {
      stack.push(char)
      // Bounds both the stack copy below and the work a pathological prefix
      // (thousands of `[`) can cost on every throttled parse.
      if (stack.length > A2UI_PREVIEW_MAX_DEPTH) return { json: null, complete: false }
      cutIndex = index + 1
      cutStack = [...stack]
    } else if (char === "}" || char === "]") {
      const open = stack.pop()
      if (open !== (char === "}" ? "{" : "[")) return { json: null, complete: false }
      if (stack.length === 0) {
        return { json: text.slice(start, index + 1), complete: true }
      }
      cutIndex = index + 1
      cutStack = [...stack]
    } else if (char === ",") {
      cutIndex = index
      cutStack = [...stack]
    }
  }

  if (cutIndex === -1) return { json: null, complete: false }
  let json = text.slice(start, cutIndex)
  // A cut right after `{"key":` cannot happen (the colon is not a cut point),
  // but a cut after an object's opening brace followed by nothing is fine.
  for (let depth = cutStack.length - 1; depth >= 0; depth--) {
    json += cutStack[depth] === "{" ? "}" : "]"
  }
  return { json, complete: false }
}

export interface StreamingA2UIPreview {
  messages: A2UIServerMessage[]
  /** The fence body already was complete JSON (it may still be streaming text after it). */
  complete: boolean
}

/**
 * Parse the visible prefix of an `a2ui` fence into preview messages addressed
 * to `previewSurfaceId`. Returns null while nothing renderable has arrived, or
 * when the prefix is not A2UI at all.
 *
 * JSONL bodies (one protocol message per line) keep every finished line and
 * complete the line in progress.
 */
export function parseStreamingA2UI(
  code: string,
  previewSurfaceId: string
): StreamingA2UIPreview | null {
  const trimmed = code.trim()
  if (!trimmed) return null

  const candidates = collectCandidates(trimmed)
  if (!candidates) return null

  const messages: A2UIServerMessage[] = []
  for (const candidate of candidates.values) {
    const value = candidates.complete ? candidate : holdBackUnnamedComponents(candidate)
    // A neutral fallback: `retargetMessage` moves everything onto the preview
    // id afterwards, and the parser refuses reserved ids in its input.
    const parsed = parseA2UIInput(value, { fallbackSurfaceId: "preview" })
    messages.push(...parsed.messages)
  }

  const previewMessages = messages
    .filter((message) => PREVIEW_MESSAGE_TYPES.has(message.type))
    .map((message) => retargetMessage(message, previewSurfaceId))
    .map((message) => (candidates.complete ? message : provisional(message)))
  if (previewMessages.length === 0) return null
  return { messages: previewMessages, complete: candidates.complete }
}

/**
 * A preview only draws: deleting a surface or replaying a connector callback
 * from a half-written fence would act on the real store, so those wait for the
 * sealed message.
 */
const PREVIEW_MESSAGE_TYPES = new Set<string>([
  "createSurface",
  "updateComponents",
  "dataModelUpdate",
  "surfaceReady",
])

function isNamedComponent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === "string" && typeof entry.component === "string"
}

/**
 * What an unfinished prefix may change. A computed declaration whose operand
 * list is still streaming would compute the wrong value (`multiply(qty` of
 * `multiply(qty, price)`), so declarations wait for the complete fence. A data
 * update that has not reached its `merge` key yet must not replace the model
 * the earlier tokens drew, so it merges until the fence is complete.
 */
function provisional(message: A2UIServerMessage): A2UIServerMessage {
  if (message.type === "createSurface" && message.computed) {
    const { computed: _pending, ...rest } = message
    return rest
  }
  if (message.type === "dataModelUpdate") {
    const { computed: _pending, ...rest } = message
    return { ...rest, merge: true }
  }
  return message
}

/** Drop the trailing component(s) that have not yet streamed their id and type. */
function holdBackUnnamedComponents(value: unknown): unknown {
  // Only the top level is a list of messages (a JSON array body); a message's
  // own arrays are left alone, so this never recurses with the input's depth.
  if (Array.isArray(value)) return value.map(holdBackMessageComponents)
  return holdBackMessageComponents(value)
}

function holdBackMessageComponents(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.components)) return record
  return { ...record, components: record.components.filter(isNamedComponent) }
}

function collectCandidates(code: string): { values: unknown[]; complete: boolean } | null {
  const whole = completePartialJson(code)
  if (whole.complete && whole.json && whole.json.length === code.length) {
    return parseCandidate(whole.json, true)
  }

  // More than one top-level value means JSONL (or a value followed by more).
  const lines = code.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length > 1 && lines.slice(0, -1).every((line) => isCompleteJson(line))) {
    const values: unknown[] = []
    for (const line of lines.slice(0, -1)) values.push(JSON.parse(line))
    const last = completePartialJson(lines[lines.length - 1])
    if (last.json) {
      const parsed = safeParse(last.json)
      if (parsed !== undefined) values.push(parsed)
    }
    return { values, complete: last.complete }
  }

  if (!whole.json) return null
  return parseCandidate(whole.json, whole.complete)
}

function parseCandidate(json: string, complete: boolean) {
  const parsed = safeParse(json)
  if (parsed === undefined) return null
  return { values: [parsed], complete }
}

function isCompleteJson(line: string): boolean {
  const result = completePartialJson(line.trim())
  return result.complete && safeParse(line) !== undefined
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/** Point every message at the preview surface and keep it inline. */
function retargetMessage(message: A2UIServerMessage, surfaceId: string): A2UIServerMessage {
  if (!("surfaceId" in message)) return message
  if (message.type === "createSurface") {
    return { ...message, surfaceId, surfaceType: "inline", widget: undefined }
  }
  return { ...message, surfaceId } as A2UIServerMessage
}
