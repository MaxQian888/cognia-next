/**
 * Focused CommonMark → Telegram MarkdownV2 converter (audited fix #5).
 *
 * `send.markdown` used to pipe the whole markdown source through
 * `escapeMdV2`, so `**bold**` reached the user as literal asterisks. This
 * hand-written converter (no npm deps — checked lib/ for an existing
 * md→telegram converter first; none exists) translates the CommonMark
 * subset the assistant actually emits:
 *
 *   **bold** / __bold__      → *bold*
 *   *italic* / _italic_      → _italic_
 *   ~~strike~~               → ~strike~
 *   `inline code`            → `inline code`   (code-context escaping)
 *   ``` fenced code ```      → ``` fenced ```  (code-context escaping)
 *   [text](url)              → [text](url)     (url-context escaping)
 *   # .. ###### headings     → *bold line*
 *   > blockquote             → > quote line
 *   - / * / + / 1. lists     → "\- item" hyphen lines
 *   everything else          → escaped literal text
 *
 * Non-markup text is escaped per context via the `markdown-v2` helpers.
 */

import { escapeMdV2, escapeMdV2Code, escapeMdV2Url } from "./markdown-v2"

// Ordered alternation — earlier branches win at the same position, so
// `**bold**` is consumed before the single-`*` italic branch can match.
// The link destination allows one level of balanced parens (CommonMark),
// e.g. https://en.wikipedia.org/wiki/A_(b).
// Group map: 1+2 inline code, 3 bold(**), 4 bold(__), 5 strike, 6+7 link,
// 8 italic(*), 9 italic(_).
const INLINE_RE =
  /(`+)([^`]+?)\1|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)|\*([^*\n]+?)\*|(?<![\w\\])_([^_\n]+?)_(?!\w)/g

/** Convert the inline markup of a single line / span. */
function convertInline(text: string): string {
  let result = ""
  let last = 0
  // Fresh regex per call — convertInline recurses for nested markup, and a
  // shared /g regex's lastIndex would be clobbered by the inner call,
  // sending the outer loop into an infinite rematch.
  const re = new RegExp(INLINE_RE.source, "g")
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    result += escapeMdV2(text.slice(last, m.index))
    if (m[2] !== undefined) {
      result += "`" + escapeMdV2Code(m[2]) + "`"
    } else if (m[3] !== undefined) {
      result += "*" + convertInline(m[3]) + "*"
    } else if (m[4] !== undefined) {
      result += "*" + convertInline(m[4]) + "*"
    } else if (m[5] !== undefined) {
      result += "~" + convertInline(m[5]) + "~"
    } else if (m[6] !== undefined) {
      result += "[" + escapeMdV2(m[6]) + "](" + escapeMdV2Url(m[7] ?? "") + ")"
    } else if (m[8] !== undefined) {
      result += "_" + convertInline(m[8]) + "_"
    } else if (m[9] !== undefined) {
      result += "_" + convertInline(m[9]) + "_"
    }
    last = m.index + m[0].length
  }
  result += escapeMdV2(text.slice(last))
  return result
}

const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const QUOTE_RE = /^>\s?(.*)$/
const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/

/**
 * Convert a CommonMark document into MarkdownV2 suitable for
 * `parse_mode: "MarkdownV2"`. Block structure is handled line-by-line;
 * inline markup via {@link convertInline}.
 */
export function mdToMarkdownV2(md: string): string {
  const out: string[] = []
  const lines = md.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1]
      const lang = fence[2]
      const buf: string[] = []
      i += 1
      while (i < lines.length && lines[i].trim() !== marker) {
        buf.push(lines[i])
        i += 1
      }
      i += 1 // skip the closing fence (or run off the end on unterminated fences)
      out.push("```" + lang + "\n" + escapeMdV2Code(buf.join("\n")) + "\n```")
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      // Telegram has no heading entity — render as a bold line.
      out.push("*" + convertInline(heading[2]) + "*")
      i += 1
      continue
    }

    const quote = QUOTE_RE.exec(line)
    if (quote) {
      // ">" at line start opens a MarkdownV2 blockquote.
      out.push(">" + convertInline(quote[1]))
      i += 1
      continue
    }

    const list = LIST_RE.exec(line)
    if (list) {
      // Lists → literal hyphen lines (the hyphen must be escaped in text).
      out.push(`${list[1]}\\- ${convertInline(list[2])}`)
      i += 1
      continue
    }

    out.push(convertInline(line))
    i += 1
  }
  return out.join("\n")
}
