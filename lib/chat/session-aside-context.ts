import type { UIMessage } from "ai"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { normalizeToolName, summarizeToolCall, type ToolPartLike } from "@/lib/chat/tool-summary"
import {
  coerceResultText,
  describeToolResult,
  resultErrorPreview,
} from "@/lib/chat/tool-result-summary"

/**
 * How much of the main conversation a sidechat is told about.
 *
 * The aside exists so the user can check something adjacent without spending
 * turns in the main thread — it needs enough context to answer "this thing we
 * were just discussing", not the whole history. Feeding it everything would
 * make each aside turn cost as much as a main one, which defeats the point.
 *
 * The window counts messages that have something to say. It used to count raw
 * rows, so a run of tool-only assistant rows (a read, a grep, a test run) used
 * up the window while contributing nothing — and those rows are exactly where
 * the main thread learned its facts.
 */
export const ASIDE_CONTEXT_MAX_MESSAGES = 24

/**
 * Character budget for the rendered transcript. A rough proxy for tokens (~4
 * chars each), deliberately conservative: this rides on EVERY aside send.
 */
export const ASIDE_CONTEXT_MAX_CHARS = 8000

/** How much of one tool result is quoted. Enough for the fact, not the dump. */
export const ASIDE_TOOL_RESULT_EXCERPT_CHARS = 280

/** Tool facts quoted per message; a burst of fifty reads is summarized by its tail. */
export const ASIDE_TOOL_FACTS_PER_MESSAGE = 8

const ROLE_LABEL: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
}

function isToolPart(part: unknown): part is ToolPartLike {
  if (!part || typeof part !== "object") return false
  const type = (part as { type?: unknown }).type
  return typeof type === "string" && (type === "dynamic-tool" || type.startsWith("tool-"))
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * One tool call as a fact line: what was called on what, and what came back —
 * an excerpt of the output, the size of a diff, or the error. English, like all
 * model-facing scaffolding.
 */
export function asideToolFact(part: ToolPartLike): string {
  const summary = summarizeToolCall(part)
  const name = summary.name || normalizeToolName(part)
  const head = summary.target ? `${name} ${clip(summary.target, 120)}` : name
  if (part.state === "output-error") {
    const errorText = (part as { errorText?: unknown }).errorText
    const preview = resultErrorPreview(errorText ?? (part as { output?: unknown }).output, 200)
    return `[tool ${head} failed${preview ? `: ${preview}` : ""}]`
  }
  if (part.state !== "output-available") return `[tool ${head}: no result yet]`
  const descriptor = describeToolResult(part)
  if (descriptor?.kind === "diff") {
    return `[tool ${head}: +${descriptor.added} −${descriptor.removed} lines]`
  }
  const output = clip(
    coerceResultText((part as { output?: unknown }).output),
    ASIDE_TOOL_RESULT_EXCERPT_CHARS
  )
  return output ? `[tool ${head} → ${output}]` : `[tool ${head}: done]`
}

/** One message as the aside reads it, or "" when it has nothing to contribute. */
export function renderAsideMessage(message: UIMessage): string {
  const text = extractPlainText(message.parts)
  const facts = message.parts.filter(isToolPart).map(asideToolFact)
  const keptFacts = facts.slice(-ASIDE_TOOL_FACTS_PER_MESSAGE)
  const lines = [
    ...(facts.length > keptFacts.length
      ? [`[${facts.length - keptFacts.length} earlier tool calls omitted]`]
      : []),
    ...keptFacts,
    ...(text ? [text] : []),
  ]
  if (lines.length === 0) return ""
  return `${ROLE_LABEL[message.role] ?? message.role}: ${lines.join("\n")}`
}

/**
 * Render the tail of a conversation as plain-text context for its sidechat.
 *
 * `messages` should be what the user sees — the visible branch, not every
 * sibling an edit or regenerate left behind (`selectVisibleMessages`).
 *
 * Trims from the OLDEST end on both limits, so the most recent exchange — the
 * one the user is most likely asking about — always survives. Returns an empty
 * string for a conversation with nothing quotable, which the caller passes
 * through as "no context" rather than an empty header.
 */
export function buildAsideContext(
  messages: readonly UIMessage[],
  opts: { maxMessages?: number; maxChars?: number } = {}
): string {
  const maxMessages = opts.maxMessages ?? ASIDE_CONTEXT_MAX_MESSAGES
  const maxChars = opts.maxChars ?? ASIDE_CONTEXT_MAX_CHARS
  if (messages.length === 0 || maxMessages <= 0 || maxChars <= 0) return ""

  let blocks = messages
    .map(renderAsideMessage)
    .filter((block) => block.length > 0)
    .slice(-maxMessages)
  let rendered = blocks.join("\n\n")
  // Drop whole messages rather than cutting one mid-sentence: a half message
  // reads as though the speaker was interrupted, which the model then imitates.
  while (rendered.length > maxChars && blocks.length > 1) {
    blocks = blocks.slice(1)
    rendered = blocks.join("\n\n")
  }
  // A single message over budget is still better truncated than dropped — it is
  // the most recent thing said.
  return rendered.length > maxChars ? rendered.slice(-maxChars) : rendered
}
