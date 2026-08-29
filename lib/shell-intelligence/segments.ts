/**
 * Command segmentation over the lexer's token stream.
 *
 * A shell line is a sequence of *commands*, not one command: `cat foo | gre`
 * asks for two, and `gre` is the second one's NAME — which is why completing it
 * as an argument of `cat` (what whitespace-splitting does) suggests file paths
 * where the user wanted `grep`. This module draws those boundaries and then
 * answers the only question the composer actually asks: *what is the token
 * under the cursor, and what role does it play in its own command?*
 *
 * Boundaries are drawn at separators (`|`, `&&`, `||`, `;`, `&`, newline) and
 * at the edges of substitutions and subshells — `echo $(gre` opens a fresh
 * command context, so `gre` is a head there too.
 *
 * Pure + synchronous.
 */

import { isEnvAssignment, lexCommandLine, type LexOptions, type LexToken } from "./lex"

/** One command's worth of tokens, and the span it occupies in the line. */
export interface CommandSegment {
  /** Word + redirect tokens, in order. Empty for `foo | ` with nothing typed yet. */
  tokens: LexToken[]
  /** Start offset of the segment's span (just past the preceding separator). */
  start: number
  /** End offset (exclusive) — the following separator, or the line end. */
  end: number
  /** Substitution/subshell nesting depth. */
  depth: number
  /** The command-name token, or null when the segment has no head yet. */
  head: LexToken | null
  /** Parent-command tokens to restore after a nested command closes. */
  continuationTokens?: LexToken[]
}

/** What the cursor is sitting on, and what completing there means. */
export interface CursorContext {
  /** The segment the cursor is in. */
  segment: CommandSegment
  /**
   * The token being completed. Synthesized as a zero-width word at the cursor
   * when it sits on whitespace — completing a fresh argument.
   */
  token: LexToken
  /**
   * `"head"` — the token IS the command name, so complete executables,
   * builtins and known CLI names.
   * `"argument"` — complete paths and the head command's spec.
   * `"redirect-target"` — a redirection target: paths only, never a command.
   *
   * There is no "nothing to complete" role: `segmentCommandLine` closes a
   * segment on both sides of every operator, so a cursor inside one lands in an
   * empty segment and completes that command's head — which is what `foo | `
   * wants.
   */
  role: "head" | "argument" | "redirect-target"
  /**
   * Argument words typed before the cursor's token, head excluded — what
   * `resolveSpec` walks to find the deepest matching subcommand.
   */
  priorArguments: string[]
}

/**
 * Whether a token is a redirect target: the word immediately following a
 * redirection operator. It names a file, so it never completes as a command
 * even when it is the first word of its segment (`> out.txt`).
 */
function redirectTargetIndices(tokens: readonly LexToken[]): Set<number> {
  const targets = new Set<number>()
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind === "redirect" && tokens[i + 1]?.kind === "word") targets.add(i + 1)
  }
  return targets
}

/** The command-name token of a segment, skipping env assignments and redirects. */
function findHead(tokens: readonly LexToken[]): LexToken | null {
  const targets = redirectTargetIndices(tokens)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind !== "word") continue
    if (targets.has(i)) continue
    if (isEnvAssignment(token)) continue
    return token
  }
  return null
}

/**
 * Split a line into command segments.
 *
 * Every offset in the line belongs to exactly one segment, so a cursor
 * anywhere — including on whitespace, and including on an empty line — maps to
 * one without a fallback.
 */
export function segmentCommandLine(line: string, opts: LexOptions = {}): CommandSegment[] {
  const tokens = lexCommandLine(line, opts)
  const segments: CommandSegment[] = []
  let current: LexToken[] = []
  let continuationTokens: LexToken[] = []
  const parentContexts: LexToken[][] = []
  let start = 0
  let depth = 0

  const close = (end: number, segmentDepth: number) => {
    segments.push({
      tokens: current,
      start,
      end,
      depth: segmentDepth,
      head: findHead(current),
      ...(continuationTokens.length > 0 ? { continuationTokens } : {}),
    })
    current = []
  }

  for (const token of tokens) {
    if (token.kind === "word" || token.kind === "redirect") {
      current.push(token)
      continue
    }
    // A separator, a substitution opening, or one closing ends the current
    // segment. Open/close also suspend and restore the surrounding command so
    // words after `$(...)` remain arguments of its original head.
    if (token.kind === "open") {
      const parentTokens = [...continuationTokens, ...current]
      close(token.start, depth)
      parentContexts.push(parentTokens)
      continuationTokens = []
      start = token.end
      depth = token.depth + 1
      continue
    }

    close(token.start, depth)
    if (token.kind === "close") {
      continuationTokens = parentContexts.pop() ?? []
    } else {
      continuationTokens = []
    }
    start = token.end
    depth = token.depth
  }
  close(line.length, depth)
  return segments
}

/** The segment containing `cursor` (the last one whose span covers it). */
function segmentAt(segments: readonly CommandSegment[], cursor: number): CommandSegment {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (cursor >= segments[i].start && cursor <= segments[i].end) return segments[i]
  }
  return segments[segments.length - 1]
}

/**
 * Describe what the cursor is completing.
 *
 * Returns null only for a cursor outside the line.
 */
export function describeCursor(
  line: string,
  cursor: number,
  opts: LexOptions = {}
): CursorContext | null {
  if (cursor < 0 || cursor > line.length) return null
  const segments = segmentCommandLine(line, opts)
  const rawSegment = segmentAt(segments, cursor)
  const segment = rawSegment.continuationTokens?.length
    ? {
        ...rawSegment,
        tokens: [...rawSegment.continuationTokens, ...rawSegment.tokens],
        head: findHead([...rawSegment.continuationTokens, ...rawSegment.tokens]),
      }
    : rawSegment

  const targets = redirectTargetIndices(segment.tokens)
  const index = segment.tokens.findIndex(
    (t) => t.kind === "word" && cursor >= t.start && cursor <= t.end
  )
  const token = index >= 0 ? segment.tokens[index] : emptyTokenAt(cursor, segment.depth)

  // A synthesized token sits after every word that ends before the cursor.
  const priorIndex = index >= 0 ? index : segment.tokens.filter((t) => t.end <= cursor).length
  const isRedirectTarget =
    index >= 0
      ? targets.has(index)
      : segment.tokens[priorIndex - 1]?.kind === "redirect" &&
        segment.tokens[priorIndex - 1].end <= cursor

  let role: CursorContext["role"]
  if (isRedirectTarget) role = "redirect-target"
  else if (segment.head === null || (index >= 0 && segment.tokens[index] === segment.head)) {
    // No head yet (empty or assignments only) → the cursor IS the head.
    role = isEnvAssignment(token) ? "argument" : "head"
  } else role = "argument"

  const headIndex = segment.head ? segment.tokens.indexOf(segment.head) : -1
  const priorArguments: string[] = []
  for (let i = headIndex + 1; i < priorIndex && i < segment.tokens.length; i++) {
    const prior = segment.tokens[i]
    if (prior.kind !== "word" || targets.has(i)) continue
    priorArguments.push(prior.value)
  }

  return { segment, token, role, priorArguments }
}

/** A zero-width word at the cursor — "the argument you are about to type". */
function emptyTokenAt(cursor: number, depth: number): LexToken {
  return { kind: "word", raw: "", value: "", start: cursor, end: cursor, depth }
}

/**
 * The first unterminated quote in the line, if any — the source range for the
 * `incomplete-syntax` diagnostic.
 */
export function findUnterminatedQuote(
  line: string,
  opts: LexOptions = {}
): { from: number; to: number; quote: NonNullable<LexToken["unterminated"]> } | null {
  for (const token of lexCommandLine(line, opts)) {
    if (token.unterminated) {
      return { from: token.start, to: token.end, quote: token.unterminated }
    }
  }
  return null
}
