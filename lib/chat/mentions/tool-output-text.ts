/**
 * A tool call's OUTPUT as readable text.
 *
 * Deliberately not part of `lib/chat/search/project-text.ts`. That module drops
 * outputs on purpose — a single file read is tens of KB, and indexing them
 * would bury real prose under tool logs in a corpus that has to stay resident.
 * That trade-off is right for *search* and exactly wrong for *reference*: the
 * whole reason to point at one message from another conversation is usually the
 * thing the tool returned.
 *
 * So this is a second, narrower projection with the opposite bias — one part,
 * on demand, at pick time — rather than a widening of the first.
 *
 * Pure and DOM-free: the renderers in `components/chat/message-parts/` know how
 * to *draw* these shapes, not how to flatten them, and a reference has to be
 * text before it can be a prompt.
 */

/** Per-output ceiling. The staged snapshot has its own, much larger, cap. */
export const TOOL_OUTPUT_MAX_CHARS = 8_000

/** How deep to walk a structured output looking for text. */
const MAX_DEPTH = 4

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** A part carrying a tool call, whatever dialect it arrived in. */
export interface ToolOutputPartLike {
  type?: unknown
  state?: unknown
  output?: unknown
  errorText?: unknown
}

/**
 * True for the part types that carry a tool result.
 *
 * Two dialects, both live: `tool-<name>` (SDK-declared tools) and
 * `dynamic-tool` (imported transcripts, CLI sessions, MCP). Same test
 * `project-text.ts` uses, so the two projections agree on what a tool part is.
 */
export function isToolPart(part: { type?: unknown }): boolean {
  const type = part.type
  return type === "dynamic-tool" || (typeof type === "string" && type.startsWith("tool-"))
}

/**
 * Flatten one MCP-style content block.
 *
 * `{ type: "text", text }` is the overwhelmingly common one. An image block has
 * no text to give, and saying so beats emitting `[object Object]` or silently
 * contributing nothing — a reference that drops a screenshot without a word
 * reads to the model as a tool that returned nothing.
 */
function contentBlockText(block: unknown): string {
  if (typeof block === "string") return block
  if (!isObject(block)) return ""
  if (typeof block.text === "string") return block.text
  const type = typeof block.type === "string" ? block.type : "content"
  if (type === "image" || type === "audio" || type === "resource") return `[${type}]`
  return ""
}

/**
 * Text inside an arbitrary output value.
 *
 * Depth-limited and cycle-safe, like `harvestInputStrings` in
 * `project-text.ts`. An output arrives as JSON but is handed over as a live
 * object callers may have decorated, so the cycle is guarded rather than
 * assumed away.
 */
function walk(value: unknown, depth: number, seen: Set<object>, out: string[]): void {
  if (depth > MAX_DEPTH) return
  if (typeof value === "string") {
    if (value) out.push(value)
    return
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value))
    return
  }
  if (!isObject(value)) return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    // An array is a list of siblings, not a nesting level — the same rule
    // `project-text.ts` applies, and for the same reason.
    for (const entry of value) walk(entry, depth, seen, out)
    return
  }
  // `content` is the MCP result shape and by far the most common one, so it is
  // read as blocks rather than walked as an anonymous object — that is what
  // keeps an image block announced instead of dropped.
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      const text = contentBlockText(block)
      if (text) out.push(text)
    }
    return
  }
  for (const key of Object.keys(value)) walk(value[key], depth + 1, seen, out)
}

/**
 * One tool part's result as text, or `""` when it has none yet.
 *
 * A failed call returns its error: "the command I ran and what it complained
 * about" is a thing people reference, and returning `""` for it would make a
 * referenced failure look like a call that never produced anything.
 */
export function projectToolOutputText(part: ToolOutputPartLike): string {
  if (part.state === "output-error") {
    const error = part.errorText
    // `JSON.stringify` of an absent error yields `""` — two quote characters,
    // which are truthy and would render as `Error: ""`. The emptiness test has
    // to happen before the encoding, not after it.
    if (error === undefined || error === null || error === "") return ""
    const text = typeof error === "string" ? error : JSON.stringify(error)
    return text ? `Error: ${text}`.slice(0, TOOL_OUTPUT_MAX_CHARS) : ""
  }
  if (part.output === undefined || part.output === null) return ""
  const out: string[] = []
  walk(part.output, 0, new Set<object>(), out)
  const joined = out.join("\n").trim()
  if (!joined) return ""
  return joined.length > TOOL_OUTPUT_MAX_CHARS
    ? `${joined.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n…[tool output truncated]`
    : joined
}
