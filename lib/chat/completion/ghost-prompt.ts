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
}

const SYSTEM_PROMPT = [
  "You are an inline autocomplete engine for a chat message box, like GitHub",
  "Copilot but for prose. Given the recent conversation and a partial message",
  "the user is typing TO an assistant, predict the most likely continuation of",
  "that message. Respond with ONLY the continuation text that comes immediately",
  "after the partial input — do NOT restate what they already typed, no quotes,",
  "no markdown, no commentary. Include a leading space if the continuation",
  "starts a new word. If you cannot confidently continue, respond with nothing.",
].join(" ")

/** Build the `{ system, prompt }` pair for `LlmClient.complete`. */
export function buildGhostPrompt(ctx: GhostContext): { system: string; prompt: string } {
  const lines: string[] = []
  const recent = (ctx.recentMessages ?? [])
    .slice(-RECENT_CONTEXT)
    .filter((m) => m.text.trim().length > 0)
  if (recent.length > 0) {
    lines.push("Recent conversation:")
    for (const m of recent) {
      const label = m.role === "assistant" ? "Assistant" : "User"
      lines.push(`${label}: ${m.text.slice(0, MESSAGE_SNIPPET)}`)
    }
    lines.push("")
  }
  lines.push("Partial message to continue:")
  lines.push(ctx.draft)
  return { system: SYSTEM_PROMPT, prompt: lines.join("\n") }
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
  let s = stripFences(raw).replace(/^[\r\n]+/, "")
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
