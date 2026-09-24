/**
 * Reading the route out of a message: which runtime its leading `@handle`
 * names, and the content with that token taken out again.
 *
 * Only the FIRST non-whitespace token of the typed text counts. The context
 * envelope the composer puts in front of it (`lib/chat/prompt-preamble.ts`) is
 * skipped first, so a referenced document that happens to start with `@codex`
 * cannot re-route a turn, and a staged reference cannot hide the route either.
 *
 * Pure: no store, no React.
 */

import type { SendContent } from "@cognia/agent-config-types"
import { splitPromptPreamble } from "@/lib/chat/prompt-preamble"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { TurnRoute } from "./types"

export interface MentionCandidate {
  /** Stable id for the target — a teammate id or a virtual id. */
  id: string
  /** Name typed after `@`. */
  name: string
}

export interface ParsedMention {
  /** The candidate name that matched, as the candidate spells it, or null. */
  matchedName: string | null
  /** Candidate id that matched, or null. */
  matchedId: string | null
  /** Message body after the leading token (leading whitespace trimmed). */
  remainder: string
  /** True when the user typed `@<something>` but no candidate matched it. */
  unknownMention: boolean
  /** Raw `@<name>` token the user typed (including the leading `@`). */
  rawToken: string | null
}

/**
 * Parse the leading `@<name>` of `text` against `candidates`,
 * case-insensitively. Restored from the retired team-workspace parser, whose
 * rules the chat route keeps unchanged:
 *   - only the first non-whitespace token is considered;
 *   - the name runs to the next whitespace;
 *   - `@` alone is not a mention;
 *   - candidates sharing a lowercased name resolve to the first one.
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

  let i = 0
  while (i < text.length && /\s/.test(text[i] ?? "")) i++
  if (i >= text.length) return { ...empty, remainder: "" }

  if (text[i] !== "@") return empty

  const tokenStart = i
  i++
  const nameStart = i
  while (i < text.length && !/\s/.test(text[i] ?? "")) i++
  const name = text.slice(nameStart, i)

  if (name.length === 0) return empty

  const rawToken = text.slice(tokenStart, i)
  const remainder = text.slice(i).replace(/^\s+/, "")
  const lookup = name.toLowerCase()

  const match = candidates.find((c) => c.name.toLowerCase() === lookup)
  if (!match) {
    return { matchedName: null, matchedId: null, remainder, unknownMention: true, rawToken }
  }
  return {
    matchedName: match.name,
    matchedId: match.id,
    remainder,
    unknownMention: false,
    rawToken,
  }
}

/** A route resolved from a message, plus what the message says without it. */
export interface ParsedRoute {
  route: TurnRoute
  target: MentionTarget
  /** The typed text after the handle, leading whitespace trimmed. */
  remainder: string
  /** The token as typed, e.g. `@Codex`. */
  rawToken: string
}

/** The route a target stands for. */
export function routeForTarget(target: MentionTarget): TurnRoute {
  if (target.kind === "virtual") {
    return {
      target: { kind: "runtime", runtime: target.runtime === "claude" ? "claude" : "codex" },
      handle: target.handle,
      label: target.name,
    }
  }
  return {
    target: { kind: "squadMember", squadId: target.squadId, teammateId: target.id },
    handle: target.handle,
    label: target.name,
  }
}

/**
 * The route `text` is addressed to, or null when its leading token names no
 * target. `text` may carry the context envelope; it is skipped.
 */
export function parseLeadingRoute(
  text: string,
  targets: readonly MentionTarget[]
): ParsedRoute | null {
  const { body } = splitPromptPreamble(text)
  const parsed = parseLeadingMention(
    body,
    targets.map((target) => ({ id: target.handle, name: target.handle }))
  )
  if (!parsed.matchedId || !parsed.rawToken) return null
  const target = targets.find((candidate) => candidate.handle === parsed.matchedId)
  if (!target) return null
  return {
    route: routeForTarget(target),
    target,
    remainder: parsed.remainder,
    rawToken: parsed.rawToken,
  }
}

/**
 * Is `tokenStart` the first non-whitespace position of `value`? The composer
 * offers route rows only there, matching what the send path will read.
 */
export function isLeadingTokenPosition(value: string, tokenStart: number): boolean {
  return tokenStart >= 0 && value.slice(0, tokenStart).trim().length === 0
}

/** Remove a leading `@handle` from typed text, or null when it does not lead. */
function stripFromTypedText(typed: string, handle: string): string | null {
  const parsed = parseLeadingMention(typed, [{ id: handle, name: handle }])
  return parsed.matchedId ? parsed.remainder : null
}

/**
 * `content` with its leading `@handle` taken out, for the runtime that answers.
 *
 * The transcript keeps what the user typed (the `@codex` chip is how they see
 * where the turn went); only the payload loses it, because the token is an
 * instruction to Cognia, not to the model. The envelope and every non-text
 * block are left exactly as they were.
 *
 * `attachmentCount` is how many leading blocks are attachments (the send
 * manifest's length, the same offset `userPromptText` reads the typed text
 * at). An attachment can be a text block too — an extracted document, an OCR
 * result — and it is neither what the user typed nor something a route may
 * edit, so the typed text is the first text block AFTER them.
 *
 * Returns `content` unchanged when the handle does not lead, and when removing
 * it would leave nothing at all to send.
 */
export function stripLeadingRouteToken(
  content: SendContent,
  handle: string,
  attachmentCount = 0
): SendContent {
  if (typeof content === "string") {
    const next = stripText(content, handle)
    return next === null || next.trim().length === 0 ? content : next
  }
  const index = content.findIndex(
    (block, position) => position >= attachmentCount && block.type === "text"
  )
  if (index < 0) return content
  const block = content[index] as { type: "text"; text: string }
  const next = stripText(block.text, handle)
  if (next === null) return content
  const out = [...content]
  if (next.trim().length === 0) {
    // The token was the whole text block: drop it, as long as something else
    // (an attachment) is still left to send.
    if (content.length === 1) return content
    out.splice(index, 1)
    return out
  }
  out[index] = { ...block, text: next }
  return out
}

function stripText(text: string, handle: string): string | null {
  const { preamble, body } = splitPromptPreamble(text)
  const stripped = stripFromTypedText(body, handle)
  if (stripped === null) return null
  if (preamble === null) return stripped
  // Same join `composeTurnText` uses, so the envelope reads as it was built.
  return stripped ? `${preamble}\n\n${stripped}` : preamble
}
