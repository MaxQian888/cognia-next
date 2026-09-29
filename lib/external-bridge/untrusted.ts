/**
 * External Bridge — untrusted-content fencing (ADR-0008 R7).
 *
 * Any text that originates OUTSIDE Cognia's own trust boundary — an external
 * coding agent's submission (inbound write tools), or knowledge returned to an
 * external agent that could later be fed back into a model (wiki bodies, RAG
 * snippets) — is wrapped in `<untrusted_content>` tags so a downstream LLM
 * consumer never treats it as instructions. This is Cognia's prompt-injection
 * defence for the MCP surface.
 *
 * Kept as a tiny shared module so the inbound handlers, the RAG handler, and
 * the wiki handlers all fence content identically instead of each hand-rolling
 * the same string.
 */

/** Opening fence tag. */
export const UNTRUSTED_OPEN = "<untrusted_content>"
/** Closing fence tag. */
export const UNTRUSTED_CLOSE = "</untrusted_content>"

/**
 * Any fence tag a body could carry to close the block early (or open a fake
 * one): case-insensitive, with whitespace around the slash and name, `_`, `-`
 * or whitespace between the words, and trailing attributes.
 */
const FENCE_TAG_PATTERN = /<\s*(\/?)\s*untrusted[\s_-]*content\b[^>]*>/gi

/**
 * Defuse every fence tag inside `text` so a body can never close the block it
 * sits in (`</untrusted_content>` then "instructions") or forge a new one. The
 * brackets become look-alike guillemets: still readable, no longer a tag.
 */
export function neutralizeUntrustedFences(text: string): string {
  return text.replace(FENCE_TAG_PATTERN, (_match, slash: string) =>
    slash ? "\u2039/untrusted_content\u203a" : "\u2039untrusted_content\u203a"
  )
}

/**
 * Wrap `text` in `<untrusted_content>` fences. The content sits on its own
 * lines so the fences are unambiguous even when the body itself contains
 * angle brackets; any fence tag INSIDE the body is neutralised first, so the
 * only real closing tag is the last line. Empty/whitespace input is still
 * fenced — an empty untrusted block is meaningful (it signals "this slot held
 * external content") and keeps the wrapping unconditional at the call sites.
 */
export function wrapUntrusted(text: string): string {
  return `${UNTRUSTED_OPEN}\n${neutralizeUntrustedFences(text)}\n${UNTRUSTED_CLOSE}`
}
