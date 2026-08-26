/**
 * What counts as a link in the composer, in one place.
 *
 * Three very different consumers need the SAME answer and used to disagree:
 *
 *  - `link-context.ts` dereferences URLs at send time (it owns the fetching,
 *    redaction and block assembly — none of which lives here).
 *  - `parse-segments.ts` has to know that a URL token is inert: it neither
 *    anchors a `/command` chain nor breaks one, so `<url> /clear` still runs
 *    the command instead of collapsing into prose.
 *  - The chip overlay paints a pill under each URL span so a link reads as a
 *    recognised object in the text, not as a wall of punctuation.
 *
 * This module holds only the recognition rules — the regex, the trailing
 * punctuation trim, and the two predicates built on them. It has no
 * dependencies on purpose: the parser is a pure, zero-dep module and must stay
 * one.
 */

/**
 * Scheme-qualified URL run. Deliberately greedy up to the first whitespace or
 * markup character; the punctuation trim below then walks the tail back, which
 * is how `(see https://x.com/a).` yields `https://x.com/a`.
 */
const URL_CANDIDATE_SOURCE = "https?:\\/\\/[^\\s<>\"'`]+"

/** Fresh instance per call — a shared `/g` regex carries `lastIndex` state. */
function urlCandidateRe(): RegExp {
  return new RegExp(URL_CANDIDATE_SOURCE, "giu")
}

const SIMPLE_TRAILING_PUNCTUATION = /[.,;:!?]$/u
const CLOSING_PAIRS = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
] as const

function count(value: string, needle: string): number {
  return value.split(needle).length - 1
}

/**
 * Walk back sentence punctuation and unbalanced closers that a URL swept up
 * from the surrounding prose. Balanced pairs stay — a Wikipedia URL really can
 * end in `)`.
 */
export function trimUrlPunctuation(value: string): string {
  let next = value
  let changed = true
  // ONE loop over both rules, not one pass each: stripping an unbalanced closer
  // can expose a sentence period behind it (`…/a.)`), and a closer-then-period
  // order that ran the period rule only once left that period attached — on the
  // string that both the chip overlay paints and `normalizeHttpUrl` fetches.
  while (changed) {
    changed = false
    if (SIMPLE_TRAILING_PUNCTUATION.test(next)) {
      next = next.slice(0, -1)
      changed = true
      continue
    }
    for (const [open, close] of CLOSING_PAIRS) {
      if (next.endsWith(close) && count(next, close) > count(next, open)) {
        next = next.slice(0, -1)
        changed = true
      }
    }
  }
  return next
}

/** A URL run found in a larger string, with absolute indices. */
export interface UrlSpan {
  /** Exact source substring, punctuation already trimmed. */
  raw: string
  /** Inclusive start index in the scanned string. */
  start: number
  /** Exclusive end index in the scanned string. */
  end: number
}

/**
 * Every http(s) URL run in `text`, in source order. Overlapping spans are
 * impossible (the scan is linear), and each span's `raw` is exactly the text
 * between `start` and `end` — the chip overlay depends on that, since it is a
 * character-for-character mirror of the textarea.
 */
export function findUrlSpans(text: string): UrlSpan[] {
  const spans: UrlSpan[] = []
  for (const match of text.matchAll(urlCandidateRe())) {
    const start = match.index ?? 0
    const raw = trimUrlPunctuation(match[0])
    if (!raw) continue
    spans.push({ raw, start, end: start + raw.length })
  }
  return spans
}

/**
 * True when `token` is ENTIRELY a URL — the test the tokenising parsers use.
 *
 * Prefix-tolerant by design: the composer sees a URL one keystroke at a time,
 * so `https://gi` has to count as a link token already, or the popover would
 * flicker in and out while the user types the host. Nothing dangerous rides on
 * this predicate alone — a token only reaches command execution through
 * `isKnownCommand`, and only reaches the network through `normalizeHttpUrl`.
 */
export function isHttpUrlToken(token: string): boolean {
  if (!startsWithHttpScheme(token, 0)) return false
  // A bare scheme is not a link yet; the first host character makes it one.
  if (token.length <= (token.toLowerCase().startsWith("https://") ? 8 : 7)) return false
  return !/\s/.test(token)
}

/** True when `value` has an `http://` / `https://` scheme starting at `index`. */
export function startsWithHttpScheme(value: string, index: number): boolean {
  const head = value.slice(index, index + 8).toLowerCase()
  return head.startsWith("http://") || head.startsWith("https://")
}
