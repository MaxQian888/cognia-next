/**
 * Small CommonMark helpers shared by the inbound dialect converters
 * (Slack mrkdwn, Lark card Markdown, the converted Lark card form, Discord)
 * and the transcript's rendering of inbound IM text.
 */

/** Opening fence: up to three spaces, then three or more backticks or tildes. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
/** Closing fence: the fence characters alone on their line. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/

/** Tracks CommonMark fenced code across lines. */
class FenceTracker {
  private open: string | null = null
  private quoteDepth = 0

  /** Feed one line; true when the line belongs to a fenced block (fences included). */
  inCode(line: string): boolean {
    // Quotes are containers, not part of the fence delimiter itself.
    let depth = 0
    while (/^ {0,3}>[ \t]?/.test(line)) {
      line = line.replace(/^ {0,3}>[ \t]?/, "")
      depth++
    }
    if (this.open && depth < this.quoteDepth) this.open = null
    if (this.open) {
      if (depth !== this.quoteDepth) return true
      const close = FENCE_CLOSE.exec(line)?.[1]
      if (close && close[0] === this.open[0] && close.length >= this.open.length) this.open = null
      return true
    }
    const open = FENCE_OPEN.exec(line)?.[1]
    if (open) {
      this.open = open
      this.quoteDepth = depth
      return true
    }
    return false
  }
}

/**
 * IM dialects (Slack mrkdwn, Lark `lark_md`, Discord) treat a single newline
 * as a line break. CommonMark folds it into a space, so a message would lose
 * every line break the sender typed. This turns each single newline outside
 * fenced code into a hard break (two trailing spaces), leaving blank-line
 * paragraph breaks and code blocks untouched.
 */
export function preserveLineBreaks(markdown: string): string {
  const lines = markdown.split("\n")
  const fences = new FenceTracker()
  const code = lines.map((line) => fences.inCode(line))
  const inlineNewlines = new Set<number>()
  let lineNumber = 0
  for (const chunk of splitMarkdownCode(markdown)) {
    for (const char of chunk.text) {
      if (char === "\n") {
        if (chunk.code) inlineNewlines.add(lineNumber)
        lineNumber++
      }
    }
  }
  return lines
    .map((line, index) => {
      if (code[index] || inlineNewlines.has(index)) return line
      const next = lines[index + 1]
      if (next === undefined || next.trim() === "" || line.trim() === "") return line
      if (code[index + 1]) return line
      return line.endsWith("  ") ? line : `${line}  `
    })
    .join("\n")
}

export interface MarkdownChunk {
  /** True for a fenced block or an inline code span, kept verbatim. */
  code: boolean
  text: string
}

/**
 * Inline code spans: a backtick run closed by the next run of
 * the same length (CommonMark). Each length keeps a forward-only cursor, so
 * a line of unmatched runs is scanned once rather than once per run.
 */
function splitInlineCode(line: string, push: (code: boolean, text: string) => void): void {
  const runs = Array.from(line.matchAll(/`+/g), (m) => [m.index, m[0].length] as const)
  const byLength = new Map<number, number[]>()
  runs.forEach(([, length], k) => {
    const list = byLength.get(length)
    if (list) list.push(k)
    else byLength.set(length, [k])
  })
  const cursor = new Map<number, number>()
  let last = 0
  let k = 0
  while (k < runs.length) {
    const [start, length] = runs[k]
    const list = byLength.get(length)!
    let c = cursor.get(length) ?? 0
    while (c < list.length && list[c] <= k) c++
    cursor.set(length, c)
    if (c >= list.length) {
      k++
      continue
    }
    const closeK = list[c]
    const end = runs[closeK][0] + length
    push(false, line.slice(last, start))
    push(true, line.slice(start, end))
    last = end
    k = closeK + 1
  }
  push(false, line.slice(last))
}

/**
 * Split Markdown into prose and code so a converter rewrites only prose.
 * Fenced blocks follow CommonMark (``` or ~~~, closed by a run of the same
 * character at least as long, an unclosed fence runs to the end); inline
 * spans are matched within a line.
 */
export function splitMarkdownCode(markdown: string): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = []
  const push = (code: boolean, text: string) => {
    if (!text) return
    const last = chunks[chunks.length - 1]
    if (last && last.code === code) last.text += text
    else chunks.push({ code, text })
  }
  const lines = markdown.split("\n")
  const fences = new FenceTracker()
  let prose = ""
  const flush = () => {
    splitInlineCode(prose, push)
    prose = ""
  }
  lines.forEach((line, index) => {
    const newline = index < lines.length - 1 ? "\n" : ""
    if (fences.inCode(line)) {
      flush()
      push(true, line + newline)
      return
    }
    if (/^(?:\s*>)*\s*$/.test(line)) {
      flush()
      push(false, line + newline)
      return
    }
    prose += line + newline
  })
  flush()
  return chunks
}

/** Backslash-escape what CommonMark would read as markup in plain text. */
export function escapeMarkdown(text: string): string {
  return (
    text
      .replace(/[\\`*_[\]<>~|]/g, "\\$&")
      .replace(/^(\s*)([#>+-])(?=\s)/gm, "$1\\$2")
      // A digit is not escapable; an ordered-list marker is broken at its dot.
      .replace(/^(\s*\d+)([.)])(?=\s)/gm, "$1\\$2")
  )
}

/**
 * A URL as a CommonMark link destination: parentheses and whitespace would
 * end the destination early, and `encodeURIComponent` leaves `(`/`)` alone.
 */
export function markdownLinkDestination(url: string): string {
  return url.replace(/[()\s]/g, (ch) =>
    ch === "(" ? "%28" : ch === ")" ? "%29" : encodeURIComponent(ch)
  )
}
