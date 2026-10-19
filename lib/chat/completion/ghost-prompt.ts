/**
 * Pure prompt construction + response sanitisation for the composer's inline
 * "ghost text" autocomplete (the chat-composer cousin of the terminal's
 * `lib/terminal/completion/prompt.ts`).
 *
 * Unlike the terminal — which predicts a whole command *line* that must begin
 * with the typed prefix — the composer predicts the *continuation* of a prose
 * message the user is typing to an assistant. The model returns just the
 * suffix; `sanitizeGhost` cleans it into the dim text rendered after the
 * caret (single line, length-capped), or `null` when there's nothing useful.
 *
 * Kept model-free so the fiddly cleanup is unit-testable.
 */

import { resolvePrompt } from "@/lib/prompts/resolve"
import { definePrompt, type PromptResolutionContext } from "@/lib/prompts/types"

/** Hard cap on a single ghost suffix (chars). */
export const MAX_GHOST_LEN = 160
/** How many recent messages to feed the model as continuity context. */
const RECENT_CONTEXT = 6
/** Per-message context cap so a long history doesn't blow the prompt. */
const MESSAGE_SNIPPET = 500

export interface GhostMessage {
  role: "user" | "assistant"
  text: string
}

export interface GhostContext {
  /** The partial message the user has typed so far. */
  draft: string
  /** Recent conversation turns for continuity (most-recent last). */
  recentMessages?: readonly GhostMessage[]
  /** The owning session, so a session-scoped customization applies (ADR-0236). */
  promptContext?: PromptResolutionContext
}

/**
 * The completion prompt. Output contract as numbered rules rather than prose —
 * models follow constraints more reliably — plus the rules the paragraph
 * never stated: match the draft's language/register (a Chinese draft must not
 * grow an English tail), complete the apparent intent instead of trailing off
 * into polite filler, and stop at the first clause boundary so the 48-token
 * cap stays a backstop rather than the thing shaping the sentence. One
 * few-shot anchors the format better than another sentence of description.
 */
export const GHOST_TEXT_PROMPT = definePrompt({
  id: "completion.ghost-text",
  contractVersion: 1,
  kind: "feature-template",
  group: "completion",
  operation: "replace-template",
  scopes: ["account", "session"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app", "cli"],
  maxChars: 8_000,
  outputContract:
    "The reply is shown as dim text after the caret: one line, at most 160 characters, with an echoed draft prefix and the caret marker removed.",
  consumers: ["lib/chat/completion/ghost-prompt.ts"],
  defaultBody: `You write inline completions for a chat composer — ghost text that trails what the user is typing TO an assistant, like Copilot for prose.

You are given the recent conversation and the user's partial message. Predict the most likely continuation.

Rules:
- Reply with ONLY the characters that follow the partial input. No preamble, quotes, markdown, or explanation.
- Never repeat the partial input. Start mid-word if that is where the text breaks; add a leading space only when the next token is a new word.
- Match the draft's language, register and formatting — a Chinese draft gets a Chinese continuation, a technical draft stays technical.
- Complete the user's apparent intent. Prefer the concrete object the sentence is reaching for over generic filler.
- Finish the current clause or sentence — typically 3–20 words — and stop at the first natural boundary. Never start a second sentence.
- If the partial input is a slash command, already a complete thought, or you cannot predict a likely continuation, reply with nothing.

Example:
Conversation:
<turn who="user">can you pick up the deploy fix?</turn>
<turn who="assistant">merged an hour ago</turn>
Partial message: "can you also cherry-pick it▍"
Correct reply: " onto the release branch before tonight's cut?"`,
})

/** Keep the original intent and final outcome when a turn exceeds its budget. */
export function clipPredictionContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = "\n…\n"
  const headLength = Math.floor((maxChars - marker.length) / 3)
  const tailLength = maxChars - marker.length - headLength
  return text.slice(0, headLength) + marker + text.slice(-tailLength)
}

/**
 * Build the `{ system, prompt }` pair for `LlmClient.complete`. Synchronous:
 * it runs on a keystroke debounce, so it reads the loaded override snapshot
 * rather than waiting on the database.
 */
export function buildGhostPrompt(ctx: GhostContext): { system: string; prompt: string } {
  const lines: string[] = []
  const recent = (ctx.recentMessages ?? [])
    .slice(-RECENT_CONTEXT)
    .filter((m) => m.text.trim().length > 0)
  if (recent.length > 0) {
    lines.push("Recent conversation:")
    // Tagged turns, not "User:"/"Assistant:" labels — a draft can itself
    // contain those words (quoted transcripts happen), and a tag the model
    // was told the format of cannot be confused with message content.
    for (const m of recent) {
      lines.push(`<turn who="${m.role}">${clipPredictionContext(m.text, MESSAGE_SNIPPET)}</turn>`)
    }
    lines.push("")
  }
  // The ▍ marks the insertion point — "continue" is otherwise ambiguous
  // about where the text ends, and a model that echoes the marker is cleaned
  // up by `sanitizeGhost`.
  lines.push("Partial message to continue:")
  lines.push(`${ctx.draft}▍`)
  const system = resolvePrompt(GHOST_TEXT_PROMPT, { context: ctx.promptContext }).text
  return { system, prompt: lines.join("\n") }
}

/** Strip ``` fences, leaving the inner text. */
function stripFences(raw: string): string {
  return raw.replace(/```[a-zA-Z0-9]*\n?/g, "").replace(/```/g, "")
}

/**
 * Clean a raw model continuation against the typed `input`, returning the
 * single-line suffix to render as ghost text after the caret, or `null` when
 * the model produced nothing useful. Tolerates a model that echoes the input
 * prefix before continuing.
 */
export function sanitizeGhost(raw: string, input: string): string | null {
  if (!raw) return null
  // The caret marker belongs to the prompt, not the reply — a model that
  // echoes it must not leak it into the composer.
  let s = stripFences(raw)
    .replace(/▍/g, "")
    .replace(/^[\r\n]+/, "")
  const nl = s.search(/[\r\n]/)
  if (nl >= 0) s = s.slice(0, nl)
  // Model echoed (part of) the input — keep only what comes after it.
  if (input.length > 0 && s.startsWith(input)) s = s.slice(input.length)
  // Trailing whitespace is never useful in a ghost; a leading space may be.
  s = s.replace(/\s+$/, "")
  if (s.length === 0) return null
  if (s.length > MAX_GHOST_LEN) s = s.slice(0, MAX_GHOST_LEN)
  return s
}
