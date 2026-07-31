/**
 * Search-text projection — the single definition of "what a message's searchable
 * body is".
 *
 * Built on `lib/inbox/extract-plain-text.ts:extractPlainText`, which already
 * covers `text` / `markdown` / `code` / `image` alt / `a2ui` plain-text mirror.
 * That projection is the Inbox's, and it deliberately stops at human-readable
 * conversation. Chat-history search needs three more families, because an agent
 * session's most locatable content lives in them:
 *
 *   • `reasoning` — the model's own thinking, often the only place a decision is
 *     spelled out.
 *   • `file` filenames — "the PDF I attached".
 *   • `sources` titles + urls — "that link the answer cited".
 *   • `tool-*` / `dynamic-tool` names + INPUTS — "that command I ran", "that
 *     file I read". Inputs only: tool *outputs* are the huge ones (a file read
 *     can be tens of KB) and indexing them would both dwarf the corpus and bury
 *     real prose under tool logs.
 *
 * Why not `summarizeToolCall` (`lib/chat/tool-summary.ts`): its `target` is
 * `clampTarget`-ed to 72 chars so an activity row stays single-line. Search must
 * not inherit that clamp — a flag late in a long command would be unfindable.
 * The tool *naming* logic is reused from there via `normalizeToolName`.
 *
 * Pure and DOM-free: same walk runs in the renderer, in the idle indexer, and
 * behind the companion RPC on a host, so every surface agrees on what is
 * searchable.
 */

import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { normalizeToolName, type ToolPartLike } from "@/lib/chat/tool-summary"

/**
 * Hard ceiling on one message's projected text.
 *
 * An agent that pastes a whole file into a message would otherwise consume the
 * resident-corpus budget by itself (see `lib/chat/search/corpus.ts`). 8k chars
 * is ~2x the longest prose message observed in practice while still bounding the
 * pathological case.
 */
export const PROJECTED_TEXT_MAX_CHARS = 8_000

/** Per-field ceiling when harvesting strings out of a tool call's input. */
export const TOOL_INPUT_FIELD_MAX_CHARS = 1_000

/** How deep to walk a tool input looking for strings. */
const TOOL_INPUT_MAX_DEPTH = 3

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Collect string values out of a tool call's input, depth-limited and
 * cycle-safe. Field order follows `Object.keys`, which is insertion order for
 * the JSON-derived objects tool inputs always are.
 */
function harvestInputStrings(
  value: unknown,
  depth: number,
  seen: Set<object>,
  out: string[]
): void {
  if (depth > TOOL_INPUT_MAX_DEPTH) return
  if (typeof value === "string") {
    if (value) out.push(value.slice(0, TOOL_INPUT_FIELD_MAX_CHARS))
    return
  }
  if (!isObject(value)) return
  // A tool input arrives as JSON, but it is handed to us as a live object that
  // callers may have decorated — guard the cycle rather than trusting that.
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    // An array is a list of siblings, not a nesting level. Counting it would put
    // `MultiEdit`'s real shape — `input.edits[i].old_string` — out of reach.
    for (const entry of value) harvestInputStrings(entry, depth, seen, out)
    return
  }
  for (const key of Object.keys(value)) {
    harvestInputStrings(value[key], depth + 1, seen, out)
  }
}

/** Text contributed by the part types `extractPlainText` does not cover. */
function extraTextFor(part: Record<string, unknown>): string {
  const type = part.type

  if (type === "reasoning") return asString(part.text)

  if (type === "file") return asString(part.filename)

  if (type === "sources") {
    const sources = part.sources
    if (!Array.isArray(sources)) return ""
    const buf: string[] = []
    for (const source of sources) {
      if (!isObject(source)) continue
      const title = asString(source.title)
      const url = asString(source.url)
      if (title) buf.push(title)
      if (url) buf.push(url)
    }
    return buf.join(" ")
  }

  if (type === "dynamic-tool" || (typeof type === "string" && type.startsWith("tool-"))) {
    const buf: string[] = [normalizeToolName(part as unknown as ToolPartLike)]
    harvestInputStrings(part.input, 1, new Set<object>(), buf)
    return buf.join(" ")
  }

  return ""
}

/**
 * Project a message's `parts` into the one string search matches against.
 *
 * Whitespace-collapsed, trimmed, and truncated to {@link PROJECTED_TEXT_MAX_CHARS}.
 * Walks in document order — the snippet builder reads context around a match, so
 * a projection that appended all tool calls at the tail would produce snippets
 * that read as gibberish.
 */
export function projectSearchText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""

  const buf: string[] = []
  let length = 0
  for (const raw of parts) {
    if (!isObject(raw)) continue
    // Delegate per-part rather than calling `extractPlainText(parts)` once up
    // front: a single ordered pass is what keeps snippets readable.
    const piece = extractPlainText([raw]) || extraTextFor(raw)
    if (!piece) continue
    buf.push(piece)
    // +1 for the join space. Bail as soon as the cap can no longer grow, so a
    // message with thousands of parts does not walk them all for nothing.
    length += piece.length + 1
    if (length >= PROJECTED_TEXT_MAX_CHARS) break
  }

  return buf.join(" ").replace(/\s+/g, " ").trim().slice(0, PROJECTED_TEXT_MAX_CHARS)
}
