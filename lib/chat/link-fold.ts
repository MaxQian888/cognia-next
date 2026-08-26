/**
 * Folding a pasted URL down to the short label the reader actually needs, and
 * putting the full URL back on the way out.
 *
 * ## Why the TEXT changes, and not just the paint
 *
 * The composer is a plain `<textarea>` with a painted overlay behind it. The
 * overlay is a character-for-character mirror — it can style a span, but it can
 * never render a glyph the textarea does not have, because every pill after a
 * mismatch would drift off its token. So "show `svenstaro/genact` instead of
 * `https://github.com/svenstaro/genact`" cannot be a rendering trick: the short
 * form has to BE the text, with the full URL held aside.
 *
 * That is the same bargain `paste-collapse.ts` already makes for oversized
 * pastes, and the same one `templateBinding` makes for parameter values.
 *
 * ## What that costs, and how each cost is paid
 *
 *  - **Send** — {@link expandFoldedLinks} runs on the outgoing text, so the
 *    model (and the link-context reader) always sees the real URL.
 *  - **Copy / cut** — the composer expands the selection before it reaches the
 *    clipboard, so copying a folded link yields the URL, not the label.
 *  - **Reload** — the map rides the draft row, next to `templateBinding`, for
 *    the same reason: it cannot live in the text.
 *  - **Editing the label** — an edited token no longer matches its entry, so it
 *    goes out as the literal text it now is. The overlay stops painting it as a
 *    link at the same moment, which is the visible half of that contract.
 */

import { findUrlSpans } from "./link-token"

/** Short label → the exact URL text it replaced. */
export type FoldedLinks = Record<string, string>

/**
 * Look a token up in the map WITHOUT consulting `Object.prototype`.
 *
 * Every lookup key here is a whitespace-delimited token of the user's own
 * message, and the map is a plain object literal (it has to be — it is
 * persisted as JSON on the draft row). A plain `links[token]` therefore answers
 * a message containing the word `toString` with `Object.prototype.toString`,
 * and the caller, seeing something truthy, splices a native function's source
 * into the outgoing prompt. Own keys only, always.
 */
function ownLink(links: FoldedLinks, token: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(links, token) ? links[token] : undefined
}

/**
 * Is `token` one of the folded labels in `links`?
 *
 * Exported so no caller has to reach for `token in links` and re-open the
 * prototype hole {@link ownLink} exists to close: `in` answers TRUE for
 * `constructor`, `toString`, `valueOf` and friends, which would make ordinary
 * English words read as links to the tokenising parsers while this module's
 * own span finder — which uses `ownLink` — paints nothing for them.
 */
export function isFoldedLink(links: FoldedLinks, token: string): boolean {
  return ownLink(links, token) !== undefined
}

/**
 * The characters every folded label starts with.
 *
 * Their only job is to reserve room the site's icon can be painted into. The
 * overlay is a character-for-character mirror of the textarea, so an icon
 * cannot simply be inserted between glyphs — it would shift every pill after it
 * off its token. Real characters in the text sit in both layers at exactly the
 * same place, and the overlay paints over them (the glyphs themselves render
 * transparent, so what you see is the icon).
 *
 * TWO cells, not one: a monospace cell is 0.6em wide, and an icon squeezed into
 * that is both unreadable and flush against the label. Two cells give the mark
 * a legible size AND a gap before the text.
 *
 * Deliberately plain BMP characters with no emoji presentation: an emoji glyph
 * ignores `color: transparent` and would show through the icon.
 */
export const LINK_MARKER = "\u00b7\u00b7"

/** The label as it appears in the text, icon cell included. */
export function foldedToken(label: string): string {
  return `${LINK_MARKER}${label}`
}

/** The readable half of a folded token — what `describeLink` produced. */
export function stripLinkMarker(token: string): string {
  return token.startsWith(LINK_MARKER) ? token.slice(LINK_MARKER.length) : token
}

/** Trailing characters a user types AFTER a token, which are not part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/u

/**
 * Opening characters a user types BEFORE a token, which are not part of it.
 *
 * Load-bearing, not symmetry for its own sake: `findUrlSpans` trims an
 * unbalanced closer off a URL run, so `(https://github.com/a/b)` folds to
 * `(<label>)` — one whitespace token whose head is only reachable after BOTH
 * ends are stripped. Matching the trailing end alone dropped the map entry in
 * the same call that created it, and the URL went out as prose.
 */
const LEADING_PUNCTUATION = /^[([{<'"]+/u

/**
 * Split a raw token into the part that could be a folded label and whatever
 * punctuation brackets it, so `svenstaro/genact.` and `(svenstaro/genact)`
 * both resolve. A token that is punctuation all the way through keeps its
 * whole self as the head — there is nothing else to look up.
 */
function splitAffixes(token: string): { lead: string; head: string; tail: string } {
  const lead = token.match(LEADING_PUNCTUATION)?.[0] ?? ""
  const rest = token.slice(lead.length)
  const tail = rest.match(TRAILING_PUNCTUATION)?.[0] ?? ""
  const head = rest.slice(0, rest.length - tail.length)
  return head ? { lead, head, tail } : { lead: "", head: token, tail: "" }
}

/** Is `token` (marker included) usable in place of `url`? */
export function isFoldableLabel(token: string, url: string): boolean {
  if (!stripLinkMarker(token) || /\s/.test(token)) return false
  // Nothing gained — leave the URL alone rather than churn the text.
  return token.length < url.length
}

export interface FoldLinksOptions {
  /**
   * Caret position. A URL the caret is still sitting in (or at the end of) is
   * being TYPED and must not fold under the user's cursor; pass -1 to force
   * every URL to fold, which is what leaving the box does. A pasted URL is NOT
   * forced: the caret lands at its end, so it settles on the next keystroke
   * past it (or on blur) like any other.
   */
  caret: number
  /** Already-folded links, carried forward and extended. */
  links: FoldedLinks
  /** Short label for a URL — `describeLink(url, settings).label`. */
  label: (url: string) => string
}

export interface FoldLinksResult {
  text: string
  links: FoldedLinks
  caret: number
  /** False when nothing folded — callers skip the state write entirely. */
  changed: boolean
}

/**
 * Replace every settled URL in `text` with its short label.
 *
 * A label already taken by a DIFFERENT URL is not reused: that URL simply stays
 * unfolded, which is visibly honest (the reader sees the full address) rather
 * than quietly pointing two labels at one target.
 */
export function foldLinks(text: string, opts: FoldLinksOptions): FoldLinksResult {
  const spans = findUrlSpans(text)
  if (spans.length === 0) {
    return { text, links: pruneFoldedLinks(text, opts.links), caret: opts.caret, changed: false }
  }

  const links: FoldedLinks = { ...opts.links }
  let out = ""
  let cursor = 0
  let caret = opts.caret
  let changed = false

  for (const span of spans) {
    const settled = opts.caret < span.start || opts.caret > span.end
    const token = settled ? foldedToken(opts.label(span.raw)) : ""
    const taken = ownLink(links, token) !== undefined && links[token] !== span.raw
    if (!settled || !isFoldableLabel(token, span.raw) || taken) continue
    out += text.slice(cursor, span.start) + token
    cursor = span.end
    links[token] = span.raw
    changed = true
    // Text before the caret got shorter — move the caret by the same amount so
    // it stays where the user left it.
    if (span.end <= opts.caret) caret -= span.raw.length - token.length
  }
  if (!changed) {
    return { text, links: pruneFoldedLinks(text, opts.links), caret: opts.caret, changed: false }
  }
  out += text.slice(cursor)
  return {
    text: out,
    links: pruneFoldedLinks(out, links),
    // The sentinel is carried through, NOT clamped. Clamping turned "there is
    // no caret to preserve" (blur, paste) into "put the caret at 0", and the
    // hook then moved it there for real — so returning to a box you had left
    // mid-message dropped you at the very start of it.
    caret: opts.caret < 0 ? opts.caret : Math.max(0, Math.min(caret, out.length)),
    changed: true,
  }
}

/** Drop entries whose token is no longer anywhere in `text`. */
export function pruneFoldedLinks(text: string, links: FoldedLinks): FoldedLinks {
  const present: FoldedLinks = {}
  for (const token of tokensOf(text)) {
    const { head } = splitAffixes(token.value)
    const direct = ownLink(links, token.value)
    if (direct !== undefined) present[token.value] = direct
    else {
      const viaHead = ownLink(links, head)
      if (viaHead !== undefined) present[head] = viaHead
    }
  }
  return present
}

interface TextToken {
  value: string
  start: number
  end: number
}

/** Whitespace-separated tokens of `text`, with absolute indices. */
function tokensOf(text: string): TextToken[] {
  const out: TextToken[] = []
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++
      continue
    }
    let end = i
    while (end < text.length && !/\s/.test(text[end])) end++
    out.push({ value: text.slice(i, end), start: i, end })
    i = end
  }
  return out
}

/**
 * Put the full URLs back. Matching is whole-token, so a label the user has
 * edited into something else is left exactly as they now have it — and trailing
 * punctuation they typed after a token is kept, not swallowed.
 */
export function expandFoldedLinks(text: string, links: FoldedLinks): string {
  if (!text || Object.keys(links).length === 0) return text
  let out = ""
  let cursor = 0
  for (const token of tokensOf(text)) {
    const direct = ownLink(links, token.value)
    const { lead, head, tail } = splitAffixes(token.value)
    const viaAffix = lead || tail ? ownLink(links, head) : undefined
    if (direct === undefined && viaAffix === undefined) continue
    out += text.slice(cursor, token.start)
    out += direct !== undefined ? direct : `${lead}${viaAffix}${tail}`
    cursor = token.end
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

export interface FoldedSpan {
  /** The label as it appears in the text. Named `raw` to match `UrlSpan`, so
   *  the overlay's span splitter takes either without a translation step. */
  raw: string
  url: string
  start: number
  end: number
}

/**
 * Where the folded labels sit in `text` — what the overlay paints as a link and
 * what the copy handler expands. Excludes trailing punctuation, so the styling
 * covers the label and not the sentence.
 */
export function foldedLinkSpans(text: string, links: FoldedLinks): FoldedSpan[] {
  if (Object.keys(links).length === 0) return []
  const spans: FoldedSpan[] = []
  for (const token of tokensOf(text)) {
    const direct = ownLink(links, token.value)
    if (direct !== undefined) {
      spans.push({ raw: token.value, url: direct, start: token.start, end: token.end })
      continue
    }
    const { lead, head, tail } = splitAffixes(token.value)
    const viaAffix = lead || tail ? ownLink(links, head) : undefined
    if (viaAffix !== undefined) {
      spans.push({
        raw: head,
        url: viaAffix,
        start: token.start + lead.length,
        end: token.start + lead.length + head.length,
      })
    }
  }
  return spans
}
