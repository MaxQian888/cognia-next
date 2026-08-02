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
//   3. An UNKNOWN line-start `/word` is treated as text (typos and literal
//      slash content are never silently dropped) — hence the injected
//      `isKnownCommand` predicate, which keeps this function pure/testable.
//   4. Segments are contiguous and cover the whole input, so an overlay can
//      paint them by index without a second tokeniser.
//
// `!shell` and `#memory` are intentionally NOT handled here — they remain
// whole-message prefix short-circuits in the composer's submit handler.

import { findTokenEnd, isMentionStart } from "./mention-boundary"

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

export type InputSegment = CommandSegment | TextSegment

/** Segment list that may additionally contain mention pills (overlay only). */
export type RichSegment = InputSegment | MentionSegment

export interface ParseSegmentsOptions {
  /**
   * When true, `@mention` tokens are split out of text segments into their own
   * {@link MentionSegment}s (so the chip overlay can paint them). Off by default
   * so the submit-time consumer (`runSegments`) keeps the plain command/text
   * view it expects.
   */
  mentions?: boolean
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
 * True when every token in `tokens` is a `/`-prefixed known command — the
 * all-or-nothing test for same-line chaining (rule 2b). Requires at least two
 * tokens; see the header for why.
 */
export function isCommandChain(
  value: string,
  tokens: readonly LineToken[],
  isKnownCommand: (name: string) => boolean
): boolean {
  if (tokens.length < 2) return false
  return tokens.every(
    (tok) =>
      value[tok.start] === "/" &&
      tok.end > tok.start + 1 &&
      isKnownCommand(value.slice(tok.start + 1, tok.end))
  )
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
  opts: { mentions: true }
): RichSegment[]
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
    if (fnw !== -1 && input[fnw] === "/") {
      const tokens = tokenizeLine(input, fnw, contentEnd)
      if (isCommandChain(input, tokens, isKnownCommand)) {
        // Rule 2b — one segment per token, empty args. The whitespace BETWEEN
        // tokens is emitted as text so the segment list stays contiguous (the
        // chip overlay paints by index).
        isCommand = true
        if (pendingStart === null) pendingStart = i
        for (const tok of tokens) {
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
      } else {
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
