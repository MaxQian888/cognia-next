/**
 * Pure-function parser for the leading `@<name>` mention in a team workspace
 * message. Used by the team chat composer to decide which teammate / virtual
 * runtime should receive a freshly typed message.
 *
 * Rules:
 *   - Only the **first** non-whitespace token of the message is considered.
 *   - The token must start with `@` and the name continues until the next
 *     whitespace.
 *   - Names are matched case-insensitively against the supplied list of
 *     candidates (real teammate names + the reserved `claude` / `codex`
 *     virtuals).
 *   - On a successful match, the rest of the message (with leading whitespace
 *     trimmed) is returned as the prompt for the runtime.
 *   - On a missed match (e.g. `@unknown ...` or no `@` at all), the parser
 *     returns `target: null` so the caller can prompt the user to pick an
 *     agent before sending.
 */

export interface MentionCandidate {
  /** Stable id for the target — a teammate id or a virtual id. */
  id: string
  /** Display name typed in `@<name>`. */
  name: string
}

export interface ParsedMention {
  /** Lowercased name that matched, or null when nothing matched. */
  matchedName: string | null
  /** Candidate id that matched, or null. */
  matchedId: string | null
  /** Message body to forward to the runtime (leading mention stripped). */
  remainder: string
  /** True when the user typed `@<something>` but no candidate matched it. */
  unknownMention: boolean
  /** Raw `@<name>` token the user typed (including the leading `@`). */
  rawToken: string | null
}

/**
 * Parse the leading mention from `text` against the supplied `candidates`.
 *
 * Empty / whitespace-only text returns a no-mention result. Multiple
 * candidates with the same lowercased name resolve to the first one in the
 * input list (callers should de-dup upstream — `lib/agent-team/runtime-targets`
 * does this).
 */
export function parseLeadingMention(
  text: string,
  candidates: readonly MentionCandidate[]
): ParsedMention {
  const empty: ParsedMention = {
    matchedName: null,
    matchedId: null,
    remainder: text,
    unknownMention: false,
    rawToken: null,
  }

  if (!text) return empty

  // Skip leading whitespace.
  let i = 0
  while (i < text.length && /\s/.test(text[i] ?? "")) i++
  if (i >= text.length) return { ...empty, remainder: "" }

  if (text[i] !== "@") return empty

  // Consume `@` then everything up to the next whitespace.
  const tokenStart = i
  i++
  const nameStart = i
  while (i < text.length && !/\s/.test(text[i] ?? "")) i++
  const name = text.slice(nameStart, i)

  // `@` alone (or `@ ...`) is not a mention.
  if (name.length === 0) return empty

  const rawToken = text.slice(tokenStart, i)
  const remainder = text.slice(i).replace(/^\s+/, "")
  const lookup = name.toLowerCase()

  const match = candidates.find((c) => c.name.toLowerCase() === lookup)
  if (!match) {
    return {
      matchedName: null,
      matchedId: null,
      remainder,
      unknownMention: true,
      rawToken,
    }
  }

  return {
    matchedName: match.name,
    matchedId: match.id,
    remainder,
    unknownMention: false,
    rawToken,
  }
}
