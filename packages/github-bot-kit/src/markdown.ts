/**
 * A position-preserving view of GitHub-flavoured Markdown with everything
 * that is not live prose blanked out: HTML comments, fenced and indented code
 * blocks, inline code spans and (optionally) block quotes.
 *
 * Every masked character becomes a space and newlines survive, so a column in
 * the masked text is the same column in the source. Command parsing reads the
 * mask to decide WHERE a mention is live, then slices the source; rendering
 * reads it to decide which mentions to neutralise.
 *
 * Line-level by design: a code span that wraps across lines is not masked
 * past its first line. That errs towards treating text as live, which the
 * parser's one-command rule and authorisation then handle.
 */

export interface MarkdownMaskOptions {
  /** Blank `>` quotes and their lazy continuation lines. Default true. */
  quotes?: boolean
}

const blank = (text: string) => text.replace(/[^\n]/g, " ")

/** CRLF and lone CR become LF; every other offset is unchanged. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

/** Blank `` `code` `` spans on one line (CommonMark: a run closes on an equal-length run). */
export function maskInlineCode(line: string): string {
  let result = ""
  let i = 0
  while (i < line.length) {
    const char = line[i]
    if (char === "\\" && i + 1 < line.length) {
      result += line.slice(i, i + 2)
      i += 2
      continue
    }
    if (char !== "`") {
      result += char
      i += 1
      continue
    }
    let j = i
    while (line[j] === "`") j += 1
    const run = j - i
    let close = -1
    for (let k = j; k < line.length;) {
      if (line[k] !== "`") {
        k += 1
        continue
      }
      let m = k
      while (line[m] === "`") m += 1
      if (m - k === run) {
        close = k
        break
      }
      k = m
    }
    if (close < 0) {
      // An unmatched run is literal backticks.
      result += line.slice(i, j)
      i = j
      continue
    }
    const end = close + run
    result += " ".repeat(end - i)
    i = end
  }
  return result
}

/** Blank HTML comments (invisible on GitHub), keeping offsets. An unclosed one runs to the end. */
export function blankHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, blank)
}

export function maskMarkdown(source: string, options: MarkdownMaskOptions = {}): string {
  const maskQuotes = options.quotes ?? true
  const text = blankHtmlComments(normalizeNewlines(source))
  const out: string[] = []
  let fence: { char: string; length: number } | null = null
  let inQuote = false
  let previousBlank = true
  let previousIndentedCode = false
  for (const line of text.split("\n")) {
    const isBlank = line.trim() === ""
    if (fence) {
      out.push(blank(line))
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null
      previousBlank = isBlank
      previousIndentedCode = false
      continue
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    // A backtick fence's info string may not itself contain a backtick.
    if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
      fence = { char: open[1][0], length: open[1].length }
      out.push(blank(line))
      inQuote = false
      previousBlank = false
      previousIndentedCode = false
      continue
    }
    if (isBlank) {
      out.push(line)
      inQuote = false
      previousBlank = true
      previousIndentedCode = false
      continue
    }
    if (maskQuotes && (inQuote || /^ {0,3}>/.test(line))) {
      // A non-blank line right after a quote is its lazy continuation, so a
      // mention there is still quoted text.
      out.push(blank(line))
      inQuote = true
      previousBlank = false
      continue
    }
    // An indented block cannot interrupt a paragraph.
    if (/^(?: {4}|\t)/.test(line) && (previousBlank || previousIndentedCode)) {
      out.push(blank(line))
      previousBlank = false
      previousIndentedCode = true
      continue
    }
    out.push(maskInlineCode(line))
    previousBlank = false
    previousIndentedCode = false
  }
  return out.join("\n")
}
