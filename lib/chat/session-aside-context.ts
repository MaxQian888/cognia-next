import type { UIMessage } from "ai"
import { renderTranscript } from "@/lib/chat/branch-session"

/**
 * How much of the main conversation a sidechat is told about.
 *
 * The aside exists so the user can check something adjacent without spending
 * turns in the main thread — it needs enough context to answer "this thing we
 * were just discussing", not the whole history. Feeding it everything would
 * make each aside turn cost as much as a main one, which defeats the point.
 */
export const ASIDE_CONTEXT_MAX_TURNS = 12

/**
 * Character budget for the rendered transcript. A rough proxy for tokens (~4
 * chars each), deliberately conservative: this rides on EVERY aside send.
 */
export const ASIDE_CONTEXT_MAX_CHARS = 8000

/**
 * Render the tail of a conversation as plain-text context for its sidechat.
 *
 * Trims from the OLDEST end on both limits, so the most recent exchange — the
 * one the user is most likely asking about — always survives. Returns an empty
 * string for a conversation with nothing quotable, which the caller passes
 * through as "no context" rather than an empty header.
 */
export function buildAsideContext(
  messages: readonly UIMessage[],
  opts: { maxTurns?: number; maxChars?: number } = {}
): string {
  const maxTurns = opts.maxTurns ?? ASIDE_CONTEXT_MAX_TURNS
  const maxChars = opts.maxChars ?? ASIDE_CONTEXT_MAX_CHARS
  if (messages.length === 0 || maxTurns <= 0 || maxChars <= 0) return ""

  let tail = messages.slice(-maxTurns)
  let rendered = renderTranscript([...tail])
  // Drop whole messages rather than cutting one mid-sentence: a half message
  // reads as though the speaker was interrupted, which the model then imitates.
  while (rendered.length > maxChars && tail.length > 1) {
    tail = tail.slice(1)
    rendered = renderTranscript([...tail])
  }
  // A single message over budget is still better truncated than dropped — it is
  // the most recent thing said.
  return rendered.length > maxChars ? rendered.slice(-maxChars) : rendered
}
