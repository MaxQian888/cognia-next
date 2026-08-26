// Pure parser that splits a composer input string into an ordered list of
// command / free-text segments. This is the foundation for "multiple slash
// commands in one message + command/free-text mixing": a single submitted
// input can contain several `/command` lines interleaved with prose, and they
// are executed/expanded in order at submit time.
//
// Design rules (see docs/superpowers/specs and the composer plan):
//   1. A `/command` is recognised ONLY at the start of a line (start of input
//      or immediately after a newline, allowing leading whitespace). A slash
//      anywhere else is ordinary text — this keeps URLs, paths and math (`a/b`,
//      `http://x`) safe. Generalises `detectTrigger`'s start-of-input rule to
//      start-of-line.
//   2. A command consumes the rest of its physical line as `args` (matching
//      `applyTemplate`'s `$ARGUMENTS` / `$1..$9` model). Multiple commands =
//      multiple lines.
//   2b. EXCEPTION — same-line chaining: a line that is NOTHING BUT known
//      commands (`/compact /clear`) runs all of them, each with empty args.
//      The test is all-or-nothing over the whole line: every whitespace-
//      separated token must start with `/` and name a known command. One
//      ordinary token is enough to fall back to rule 2 verbatim, which is what
//      keeps `/review src/a.ts` and `/add-dir /usr/local` parsing as a single
//      command with args. Two guards matter: at least TWO tokens (a one-token
//      line must keep rule 2's `end: contentEnd`, which includes trailing
//      whitespace, and `[].every()` is vacuously true for a blank line), and a
//      non-empty command name (so a lone `/` never reaches `isKnownCommand`).
//   2c. LINKS ARE INERT inside a chain. A pasted `https://…` token neither
//      names a command nor breaks the chain, so `https://github.com/a/b /clear`
//      runs `/clear` and keeps the URL as text (where `link-context.ts` picks
//      it up as it always has). Without this the whole line collapsed to prose
//      and the command silently became part of the prompt — and because Enter
//      sends, a message that carries a link has nowhere else to put a command.
//      The `isKnownCommand` gate still guards everything: `https://x /usr/bin`
//      is prose, because `/usr` is not a command.
//      A link is inert only where it cannot be an ARGUMENT. Before the first
//      command it always is; after one it is inert only when a SECOND command
//      proves the line is a chain. `/remember https://…` is therefore one
//      command holding a URL (rule 1 args), not a chain that drops it, while
//      `/help https://… /clear` still chains.
//   3. An UNKNOWN line-start `/word` is treated as text (typos and literal
//      slash content are never silently dropped) — hence the injected
//      `isKnownCommand` predicate, which keeps this function pure/testable.
//   4. Segments are contiguous and cover the whole input, so an overlay can
//      paint them by index without a second tokeniser.
//
// `!shell` and `#memory` are intentionally NOT handled here — they remain
// whole-message prefix short-circuits in the composer's submit handler.

import { findTokenEnd, isMentionStart } from "./mention-boundary"
import { findUrlSpans, isHttpUrlToken, startsWithHttpScheme } from "@/lib/chat/link-token"

export interface CommandSegment {
  kind: "command"
  /** Command word after the leading slash (may contain `/` for nested names). */
  name: string
  /** Trimmed argument string (everything after the command word on its line). */
  args: string
  /** Exact source substring from the slash to end-of-line (for chip ranges). */
  raw: string
  /** Inclusive start index in the source (the leading `/`). */
  start: number
  /** Exclusive end index in the source (end-of-line content, before `\r`/`\n`). */
  end: number
}

export interface TextSegment {
  kind: "text"
  value: string
  start: number
  end: number
}

export interface MentionSegment {
  kind: "mention"
  /** Mention token after the leading `@` (e.g. a relative path or agent name). */
  name: string
  /** Exact source substring including the leading `@` (for chip ranges). */
  raw: string
  /** Inclusive start index in the source (the leading `@`). */
  start: number
  /** Exclusive end index in the source (the next whitespace, or input end). */
  end: number
}

export interface LinkSegment {
  kind: "link"
  /** Exact source substring (the whole URL, punctuation already trimmed). */
  raw: string
  /**
   * The URL this stands for. Same as `raw` for a URL written out in full;
   * different for a FOLDED link, whose text is a short label — the overlay
   * needs the real address to pick the site's icon.
   */
  url?: string
  /** Inclusive start index in the source (the scheme's first character). */
  start: number
  /** Exclusive end index in the source. */
  end: number
}

export interface ParamSegment {
  kind: "param"
  /** Declared parameter id between the braces, with surrounding space trimmed. */
  paramId: string
  /** Exact source substring including both brace pairs (for chip ranges). */
  raw: string
  /** Inclusive start index in the source (the first `{`). */
  start: number
  /** Exclusive end index in the source (just past the last `}`). */
  end: number
}

export type InputSegment = CommandSegment | TextSegment

/**
 * Segment list that may additionally contain pill segments (overlay only).
 *
 * `ParamSegment`s are produced by `splitParamSegments` in
 * `lib/chat/template/param-segments.ts` rather than here: recognising one
 * requires knowing which spans of the input are code, which is a Markdown
 * concern this parser has no business learning. The union lives here because
 * the overlay consumes it, and because `pillDeleteRange` has to see every pill
 * kind in one list.
 */
export type RichSegment = InputSegment | MentionSegment | ParamSegment | LinkSegment

export interface ParseSegmentsOptions {
  /**
   * When true, `@mention` tokens are split out of text segments into their own
   * {@link MentionSegment}s (so the chip overlay can paint them). Off by default
   * so the submit-time consumer (`runSegments`) keeps the plain command/text
   * view it expects.
   */
  mentions?: boolean
  /**
   * Is this token a link? Defaults to {@link isHttpUrlToken}.
   *
   * The composer widens it: a pasted URL is FOLDED to a short label in the text
   * (`lib/chat/link-fold.ts`), so `svenstaro/genact` is every bit as much a link
   * as the URL it replaced — and must stay just as inert inside a command chain
   * (rule 2c), or folding a link would silently stop the command beside it from
   * running.
   */
  isLinkToken?: (token: string) => boolean
}

const isWhitespace = (ch: string): boolean => /\s/.test(ch)

/** First non-whitespace index in `[start, hardEnd)`, or -1 when all whitespace. */
function firstNonWhitespace(value: string, start: number, hardEnd: number): number {
  for (let i = start; i < hardEnd; i++) {
    if (!isWhitespace(value[i])) return i
  }
  return -1
}

/** Absolute `[start, end)` range of one whitespace-separated token. */
interface LineToken {
  start: number
  end: number
}

/**
 * Split `[start, hardEnd)` into whitespace-separated tokens with absolute
 * indices. Uses the shared {@link findTokenEnd} so the boundary rule can't drift
 * from `detectTrigger`'s.
 */
export function tokenizeLine(value: string, start: number, hardEnd: number): LineToken[] {
  const tokens: LineToken[] = []
  let i = start
  while (i < hardEnd) {
    if (isWhitespace(value[i])) {
      i++
      continue
    }
    const end = findTokenEnd(value, i, hardEnd)
    tokens.push({ start: i, end })
    i = end
  }
  return tokens
}

/**
 * True when every token in `tokens` is either a `/`-prefixed known command or
 * an inert link — the all-or-nothing test for same-line chaining (rules 2b and
 * 2c). Requires at least two tokens and at least one actual command; see the
 * header for why.
 *
 * WHERE the link sits decides whether it is inert. A link BEFORE the first
 * command is pasted context that a command follows (`<url> /clear` — rule 2c's
 * whole purpose). A link AFTER a command is that command's ARGUMENT unless a
 * second command proves the line is really a chain:
 *
 *   - `/remember https://…`      → not a chain. One command handed a URL; rule
 *                                  1 gives it `args` covering the rest of the
 *                                  line. Calling it a chain emitted `args: ""`
 *                                  and silently dropped the URL.
 *   - `/help https://… /clear`   → a chain. Two commands, so the link between
 *                                  them is context, not an argument.
 */
export function isCommandChain(
  value: string,
  tokens: readonly LineToken[],
  isKnownCommand: (name: string) => boolean,
  isLinkToken: (token: string) => boolean = isHttpUrlToken
): boolean {
  if (tokens.length < 2) return false
  let commands = 0
  let linksAfterFirstCommand = 0
  for (const tok of tokens) {
    if (isLinkToken(value.slice(tok.start, tok.end))) {
      if (commands > 0) linksAfterFirstCommand++
      continue
    }
    if (value[tok.start] !== "/") return false
    if (tok.end <= tok.start + 1) return false
    if (!isKnownCommand(value.slice(tok.start + 1, tok.end))) return false
    commands++
  }
  if (commands === 0) return false
  return linksAfterFirstCommand === 0 || commands >= 2
}

/**
 * Parse `input` into an ordered, contiguous list of command / text segments.
 * `isKnownCommand(name)` decides whether a line-start `/word` is a real command
 * (resolved against the live slash-command list) or just text.
 */
export function parseSegments(
  input: string,
  isKnownCommand: (name: string) => boolean
): InputSegment[]
export function parseSegments(
  input: string,
  isKnownCommand: (name: string) => boolean,
  opts: ParseSegmentsOptions & { mentions: true }
): RichSegment[]
// Without `mentions`, the result is the plain command/text view — the options
// that only change PARSING (`isLinkToken`) must not widen the return type, or
// every submit-path caller would suddenly be handed pill segments it cannot use.
export function parseSegments(
  input: string,
  isKnownCommand: (name: string) => boolean,
  opts: ParseSegmentsOptions & { mentions?: false }
): InputSegment[]
export function parseSegments(
  input: string,
  isKnownCommand: (name: string) => boolean,
  opts?: ParseSegmentsOptions
): RichSegment[]
export function parseSegments(
  input: string,
  isKnownCommand: (name: string) => boolean,
  opts?: ParseSegmentsOptions
): RichSegment[] {
  const segments: InputSegment[] = []
  const isLinkToken = opts?.isLinkToken ?? isHttpUrlToken
  // Only a WIDENED predicate can recognise a link that has no scheme (the
  // composer's, which also matches folded labels). With the default one,
  // `startsWithHttpScheme` is already the complete test, so the token scan
  // below is pure waste and is skipped outright.
  const linkMayLackScheme = opts?.isLinkToken !== undefined
  const len = input.length
  if (len === 0) return segments

  let pendingStart: number | null = null
  const pushText = (start: number, end: number): void => {
    if (end > start) {
      segments.push({ kind: "text", value: input.slice(start, end), start, end })
    }
  }

  let i = 0
  while (i < len) {
    const nl = input.indexOf("\n", i)
    const lineEnd = nl === -1 ? len : nl // exclusive of the `\n`
    // Strip a trailing `\r` from the line content so CRLF endings don't leak
    // into command `raw`/`args`; the `\r\n` itself becomes following text.
    const contentEnd = lineEnd > i && input[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd

    const fnw = firstNonWhitespace(input, i, contentEnd)
    let isCommand = false
    // A line can open with a command (rules 1/2b) or with a link that a command
    // follows (rule 2c). Anything else is prose and skips the LINE tokeniser
    // entirely: a paragraph costs one character read for the `/`, then a scheme
    // probe, and — only for a caller whose predicate recognises scheme-less
    // links — a walk to the end of the line's first word.
    const opensCommand = fnw !== -1 && input[fnw] === "/"
    const opensLink =
      fnw !== -1 &&
      !opensCommand &&
      (startsWithHttpScheme(input, fnw) ||
        (linkMayLackScheme && isLinkToken(input.slice(fnw, findTokenEnd(input, fnw, contentEnd)))))
    if (opensCommand || opensLink) {
      const tokens = tokenizeLine(input, fnw, contentEnd)
      if (isCommandChain(input, tokens, isKnownCommand, isLinkToken)) {
        // Rule 2b — one segment per token, empty args. The whitespace BETWEEN
        // tokens is emitted as text so the segment list stays contiguous (the
        // chip overlay paints by index).
        isCommand = true
        if (pendingStart === null) pendingStart = i
        for (const tok of tokens) {
          // Link tokens stay inside the text run: they are context for the
          // prompt, not something to execute, and `link-context.ts` reads them
          // straight off the raw input.
          if (isLinkToken(input.slice(tok.start, tok.end))) continue
          pushText(pendingStart, tok.start)
          segments.push({
            kind: "command",
            name: input.slice(tok.start + 1, tok.end),
            args: "",
            raw: input.slice(tok.start, tok.end),
            start: tok.start,
            end: tok.end,
          })
          pendingStart = tok.end
        }
        // Trailing whitespace after the last command joins the next text run.
      } else if (opensCommand) {
        const wordEnd = findTokenEnd(input, fnw + 1, contentEnd)
        const name = input.slice(fnw + 1, wordEnd)
        if (name.length > 0 && isKnownCommand(name)) {
          isCommand = true
          // Flush any pending text plus this line's leading whitespace.
          if (pendingStart === null) pendingStart = i
          pushText(pendingStart, fnw)
          pendingStart = null
          segments.push({
            kind: "command",
            name,
            args: input.slice(wordEnd, contentEnd).trim(),
            raw: input.slice(fnw, contentEnd),
            start: fnw,
            end: contentEnd,
          })
          // The `\r`/`\n` (and everything after) starts a fresh text run.
          pendingStart = contentEnd
        }
      }
    }

    if (!isCommand && pendingStart === null) {
      pendingStart = i
    }
    i = nl === -1 ? len : nl + 1
  }

  if (pendingStart !== null) pushText(pendingStart, len)
  if (!opts?.mentions) return segments
  return splitMentionSegments(segments)
}

/**
 * Derive the mention-aware view from an already-parsed `InputSegment[]`: split
 * `@mention` tokens out of text segments while passing command segments through.
 * Lets a caller that already has the plain segments (e.g. the composer's
 * submit-path memo) get the overlay view without re-tokenizing the whole input.
 */
export function splitMentionSegments(segments: readonly InputSegment[]): RichSegment[] {
  return segments.flatMap(splitMentions)
}

/**
 * Derive the link-aware view: split every link out of the TEXT segments into
 * its own {@link LinkSegment}, leaving commands, mentions and params untouched.
 *
 * Two kinds of link reach this: raw `http(s)://…` runs found in the text, and
 * `extraSpans` — absolute ranges the caller already knows are links. The
 * composer passes the FOLDED ones (`foldedLinkSpans`), whose text is a short
 * label with no scheme to recognise; passing ranges rather than a predicate
 * keeps the "what counts as the end of a token" rule in one place instead of
 * two.
 *
 * Applied on top of {@link splitMentionSegments} rather than inside it because
 * only the chip overlay wants it — the submit path reads links straight off the
 * raw input and would be confused by a third pill kind. Contiguity and absolute
 * indices are preserved, which the overlay depends on.
 */
export function splitLinkSegments(
  segments: readonly RichSegment[],
  extraSpans: readonly { raw: string; url?: string; start: number; end: number }[] = []
): RichSegment[] {
  return segments.flatMap((seg) => {
    if (seg.kind !== "text") return [seg]
    const own = findUrlSpans(seg.value).map((span) => ({
      raw: span.raw,
      url: span.raw,
      start: seg.start + span.start,
      end: seg.start + span.end,
    }))
    const extra = extraSpans.filter(
      (span) =>
        span.start >= seg.start &&
        span.end <= seg.end &&
        !own.some((hit) => span.start < hit.end && hit.start < span.end)
    )
    const spans = [...own, ...extra].sort((a, b) => a.start - b.start)
    if (spans.length === 0) return [seg]
    const out: RichSegment[] = []
    let cursor = seg.start
    for (const span of spans) {
      if (span.start > cursor) {
        out.push({
          kind: "text",
          value: seg.value.slice(cursor - seg.start, span.start - seg.start),
          start: cursor,
          end: span.start,
        })
      }
      out.push({
        kind: "link",
        raw: span.raw,
        ...(span.url ? { url: span.url } : {}),
        start: span.start,
        end: span.end,
      })
      cursor = span.end
    }
    if (cursor < seg.end) {
      out.push({
        kind: "text",
        value: seg.value.slice(cursor - seg.start),
        start: cursor,
        end: seg.end,
      })
    }
    return out
  })
}

/**
 * Split any `@mention` tokens out of a text segment into their own
 * {@link MentionSegment}s, preserving absolute `start`/`end` indices and overall
 * contiguity. Non-text segments (commands) pass through untouched. When a text
 * segment contains no mention, the original segment is returned as-is.
 */
function splitMentions(seg: InputSegment): RichSegment[] {
  if (seg.kind !== "text") return [seg]
  const { value, start } = seg
  const out: RichSegment[] = []
  let cursor = 0 // first un-flushed index within `value`
  let i = 0
  while (i < value.length) {
    if (isMentionStart(value, i)) {
      const tokenEnd = findTokenEnd(value, i + 1, value.length)
      // A lone `@` (followed by whitespace/end) isn't a mention — leave as text.
      if (tokenEnd > i + 1) {
        if (i > cursor) {
          out.push({
            kind: "text",
            value: value.slice(cursor, i),
            start: start + cursor,
            end: start + i,
          })
        }
        out.push({
          kind: "mention",
          name: value.slice(i + 1, tokenEnd),
          raw: value.slice(i, tokenEnd),
          start: start + i,
          end: start + tokenEnd,
        })
        cursor = tokenEnd
        i = tokenEnd
        continue
      }
    }
    i++
  }
  if (out.length === 0) return [seg]
  if (cursor < value.length) {
    out.push({
      kind: "text",
      value: value.slice(cursor),
      start: start + cursor,
      end: start + value.length,
    })
  }
  return out
}
