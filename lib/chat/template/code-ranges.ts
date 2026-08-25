// Which spans of a composer input are code, and therefore must not be scanned
// for `{{parameter}}` tokens.
//
// Why this exists at all: `{{ }}` is not ours alone. Vue, Handlebars, Jinja,
// Go templates and Angular all use it, and a prompt that pastes one of them is
// completely ordinary ("why does this Jinja config not render?"). Without a
// mask, every such paste sprouts undeclared-parameter pills and the composer
// starts refusing to send.
//
// The rules are a deliberate subset of CommonMark — enough to cover what people
// actually paste into a chat box, and no more:
//
//   1. A FENCE line is one whose first non-whitespace run is three or more of
//      the same fence character (` or ~). The block runs from the opening
//      fence line to the closing one, both included.
//   2. A closing fence must use the same character and be at least as long as
//      the opener, so ```` inside a ``` block does not close it.
//   3. An UNCLOSED fence masks everything to the end of the input. A block you
//      are halfway through typing is still a block; sprouting pills inside it
//      and then retracting them as you type the closing fence is worse than
//      being briefly conservative.
//   4. INLINE spans are backtick runs matched by an equal-length run LATER ON
//      THE SAME LINE. Same-line only, because an unmatched backtick in prose is
//      far more common than a multi-line inline span, and the alternative is
//      that one stray backtick silently disables parameters for the rest of the
//      message.
//
// Ranges are half-open `[start, end)` absolute indices into the input, in
// ascending order and never overlapping.

export interface CodeRange {
  /** Inclusive start index in the source. */
  start: number
  /** Exclusive end index in the source. */
  end: number
}

const isWhitespace = (ch: string): boolean => /\s/.test(ch)

/** First non-whitespace index in `[start, end)`, or -1 when all whitespace. */
function firstNonWhitespace(value: string, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (!isWhitespace(value[i])) return i
  }
  return -1
}

/** Length of the run of `ch` starting at `from`, bounded by `end`. */
function runLength(value: string, from: number, end: number, ch: string): number {
  let i = from
  while (i < end && value[i] === ch) i++
  return i - from
}

/**
 * The fence a line opens or closes, or `null` when it is not a fence line.
 * `char` is the fence character and `length` its run length.
 */
function fenceOnLine(
  value: string,
  start: number,
  end: number
): { char: string; length: number } | null {
  const fnw = firstNonWhitespace(value, start, end)
  if (fnw === -1) return null
  const char = value[fnw]
  if (char !== "`" && char !== "~") return null
  const length = runLength(value, fnw, end, char)
  return length >= 3 ? { char, length } : null
}

/**
 * Append the inline code spans found in `[start, end)` — a single line, known
 * not to be inside a fence — to `out`.
 */
function pushInlineSpans(value: string, start: number, end: number, out: CodeRange[]): void {
  let i = start
  while (i < end) {
    if (value[i] !== "`") {
      i++
      continue
    }
    const openLength = runLength(value, i, end, "`")
    const close = findClosingRun(value, i + openLength, end, openLength)
    if (close === -1) {
      // Unmatched opener: this run is ordinary text, and so is everything after
      // it on this line that a longer scan might otherwise swallow.
      i += openLength
      continue
    }
    out.push({ start: i, end: close + openLength })
    i = close + openLength
  }
}

/** Index of the next backtick run of exactly `length` in `[from, end)`, or -1. */
function findClosingRun(value: string, from: number, end: number, length: number): number {
  let i = from
  while (i < end) {
    if (value[i] !== "`") {
      i++
      continue
    }
    const run = runLength(value, i, end, "`")
    if (run === length) return i
    i += run
  }
  return -1
}

/** Every code span in `input`, ascending and non-overlapping. */
export function computeCodeRanges(input: string): CodeRange[] {
  const ranges: CodeRange[] = []
  const len = input.length
  let i = 0
  let openFence: { char: string; length: number; start: number } | null = null

  while (i < len) {
    const nl = input.indexOf("\n", i)
    const lineEnd = nl === -1 ? len : nl
    // Strip a trailing `\r` so a CRLF fence line is still recognised.
    const contentEnd = lineEnd > i && input[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd
    const fence = fenceOnLine(input, i, contentEnd)

    if (openFence === null) {
      if (fence) {
        openFence = { ...fence, start: i }
      } else {
        pushInlineSpans(input, i, contentEnd, ranges)
      }
    } else if (fence && fence.char === openFence.char && fence.length >= openFence.length) {
      // Include the closing fence line itself, but not its newline — the
      // newline belongs to whatever follows.
      ranges.push({ start: openFence.start, end: contentEnd })
      openFence = null
    }

    i = nl === -1 ? len : nl + 1
  }

  if (openFence !== null) ranges.push({ start: openFence.start, end: len })
  return ranges
}

/** Whether `[start, end)` lies wholly inside one of `ranges`. */
export function isInCodeRange(ranges: readonly CodeRange[], start: number, end: number): boolean {
  return ranges.some((range) => start >= range.start && end <= range.end)
}
