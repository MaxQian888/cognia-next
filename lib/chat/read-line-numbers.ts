/**
 * Line-number prefixes in Read tool output.
 *
 * Read tools hand the model a numbered listing, not the raw file: the sidecar's
 * core `read` tool formats `cat -n` style (`"     1\t…"`, see `formatCatN` in
 * `sidecar/src/tools/builtin/core-files/read.ts`), and Claude Code's own Read
 * (native SDK or through an ACP adapter, which may also wrap it in a markdown
 * fence) uses `"     1→…"`. `ReadCard` renders that text in a `CodeBlock`
 * whose gutter already numbers every line, so leaving the prefixes in showed
 * every number twice. This lifts them out and reports the first number, so the
 * gutter keeps the file's own numbering (an `offset` read starts at its
 * offset, not at 1).
 *
 * Deliberately strict — a listing is only recognised when the numbers run
 * consecutively from the first line. A TSV whose first column happens to hold
 * integers, or any text that merely mentions numbers, is left untouched.
 */

/** `<padding><number><tab|→><content>`; content may be empty (a blank line). */
const NUMBERED_LINE = /^ *(\d+)(?:[\t→](.*))?$/
/** Opening/closing markdown fence an adapter may wrap the listing in. */
const FENCE_LINE = /^(`{3,}|~{3,})[\w+-]*\s*$/

export interface NumberedListing {
  /** The listing with every number prefix removed. */
  code: string
  /** The number on the first line — what the gutter should start counting at. */
  startLine: number
  /**
   * Text the tool appended after the listing (a paging hint such as
   * `(showing lines 1-200 of 900; …)`), separated from it by a blank line.
   * Empty when there is none.
   */
  trailer: string
}

/** Splits an optional surrounding fence off; returns the inner lines and what followed it. */
function unfence(lines: string[]): { body: string[]; after: string[] } {
  const open = FENCE_LINE.exec(lines[0] ?? "")
  if (!open) return { body: lines, after: [] }
  const marker = open[1]
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].trim() === marker) {
      return { body: lines.slice(1, i), after: lines.slice(i + 1) }
    }
  }
  return { body: lines, after: [] }
}

/**
 * Strips Read-tool line-number prefixes from `text`.
 *
 * Returns `null` when `text` is not a numbered listing, so callers render it
 * verbatim. `expectedStart` (the read's `offset`, when the call stated one)
 * tightens the check: the first number must equal it.
 */
export function stripReadLineNumbers(text: string, expectedStart?: number): NumberedListing | null {
  if (!text) return null
  const { body, after } = unfence(text.replace(/\r\n?/g, "\n").split("\n"))

  const first = NUMBERED_LINE.exec(body[0] ?? "")
  // The first line must carry real content syntax (a separator), not just a
  // bare number: a file that is literally "42" is not a listing.
  if (!first || first[2] === undefined) return null
  const startLine = Number(first[1])
  if (expectedStart !== undefined && startLine !== expectedStart) return null

  const code: string[] = []
  let index = 0
  for (; index < body.length; index++) {
    const match = NUMBERED_LINE.exec(body[index])
    if (!match || Number(match[1]) !== startLine + index) break
    // A bare number is an empty source line whose trailing tab was trimmed in
    // transit; it only counts because it continues the sequence.
    code.push(match[2] ?? "")
  }

  // Whatever follows the run must be set off by a blank line (the tool's own
  // notice); anything else means the numbers were part of the content.
  const rest = body.slice(index)
  if (rest.length > 0 && rest[0].trim() !== "") return null

  const trailer = [...rest, ...after].join("\n").trim()
  return { code: code.join("\n"), startLine, trailer }
}
