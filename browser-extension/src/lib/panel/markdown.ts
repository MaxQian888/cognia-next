/**
 * A small Markdown parser for task answers, to a tree the panel renders as
 * React elements (ADR-0228 §4).
 *
 * Deliberately not a full CommonMark: answers are an agent's prose, and what
 * matters is that headings, lists, code, quotes, tables, emphasis and links
 * read as such. What matters more is what it never does — there is no HTML
 * pass-through and no `innerHTML` anywhere downstream, so an answer quoting a
 * page's `<script>` renders the characters. Links keep only http(s) and
 * mailto targets; anything else renders as its text.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "break" }

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | {
      type: "table"
      align: ("left" | "center" | "right" | null)[]
      header: Inline[][]
      rows: Inline[][][]
    }
  | { type: "rule" }

/** Only these schemes become links. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim()
  try {
    const url = new URL(trimmed)
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.toString()
      : null
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- inline */

function pushText(out: Inline[], text: string) {
  if (!text) return
  const last = out[out.length - 1]
  if (last?.type === "text") last.text += text
  else out.push({ type: "text", text })
}

/** Find the closing delimiter, skipping escaped characters and code spans. */
function findClosing(source: string, from: number, delimiter: string): number {
  for (let index = from; index < source.length; index++) {
    const char = source[index]
    if (char === "\\") {
      index++
      continue
    }
    if (char === "`") {
      const end = source.indexOf("`", index + 1)
      if (end > 0) index = end
      continue
    }
    if (source.startsWith(delimiter, index) && index > from) return index
  }
  return -1
}

/** The `)` closing a link target, counting the parentheses inside it. */
function closingParen(source: string, from: number): number {
  let depth = 0
  for (let index = from; index < source.length; index++) {
    const char = source[index]
    if (char === "\\") index++
    else if (char === "(") depth++
    else if (char === ")") {
      if (depth === 0) return index
      depth--
    } else if (char === "\n") return -1
  }
  return -1
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (
      char === "\\" &&
      index + 1 < source.length &&
      /[\\`*_{}[\]()#+\-.!~|>]/.test(source[index + 1]!)
    ) {
      pushText(out, source[index + 1]!)
      index += 2
      continue
    }
    if (char === "\n") {
      out.push({ type: "break" })
      index++
      continue
    }
    if (char === "`") {
      let ticks = 1
      while (source[index + ticks] === "`") ticks++
      const fence = "`".repeat(ticks)
      const end = source.indexOf(fence, index + ticks)
      if (end > 0) {
        out.push({
          type: "code",
          text: source.slice(index + ticks, end).replace(/^ (.*) $/s, "$1"),
        })
        index = end + ticks
        continue
      }
      pushText(out, fence)
      index += ticks
      continue
    }
    if (char === "[") {
      const close = findClosing(source, index + 1, "]")
      if (close > 0 && source[close + 1] === "(") {
        const end = closingParen(source, close + 2)
        if (end > 0) {
          const rawHref = source.slice(close + 2, end).split(/\s+"/)[0] ?? ""
          const href = safeHref(rawHref.replace(/^<|>$/g, ""))
          const children = parseInline(source.slice(index + 1, close))
          if (href) out.push({ type: "link", href, children })
          else out.push(...children)
          index = end + 1
          continue
        }
      }
    }
    if (char === "<") {
      // An autolink: <https://…>. Any other `<` is text, never markup.
      const end = source.indexOf(">", index + 1)
      const href = end > 0 ? safeHref(source.slice(index + 1, end)) : null
      if (href && !/\s/.test(source.slice(index + 1, end))) {
        out.push({
          type: "link",
          href,
          children: [{ type: "text", text: source.slice(index + 1, end) }],
        })
        index = end + 1
        continue
      }
    }
    const strong = source.startsWith("**", index)
      ? "**"
      : source.startsWith("__", index)
        ? "__"
        : null
    if (strong) {
      const end = findClosing(source, index + 2, strong)
      if (end > 0) {
        out.push({ type: "strong", children: parseInline(source.slice(index + 2, end)) })
        index = end + 2
        continue
      }
    }
    if (source.startsWith("~~", index)) {
      const end = findClosing(source, index + 2, "~~")
      if (end > 0) {
        out.push({ type: "del", children: parseInline(source.slice(index + 2, end)) })
        index = end + 2
        continue
      }
    }
    if (
      (char === "*" || char === "_") &&
      source[index + 1] !== " " &&
      source[index + 1] !== undefined
    ) {
      // `_` inside a word (snake_case) is not emphasis.
      const intraword = char === "_" && index > 0 && /\w/.test(source[index - 1]!)
      const end = intraword ? -1 : findClosing(source, index + 1, char)
      if (
        end > 0 &&
        source[end - 1] !== " " &&
        !(char === "_" && /\w/.test(source[end + 1] ?? ""))
      ) {
        out.push({ type: "em", children: parseInline(source.slice(index + 1, end)) })
        index = end + 1
        continue
      }
    }
    // A bare URL in prose becomes a link.
    if ((char === "h" || char === "H") && /^https?:\/\//i.test(source.slice(index, index + 8))) {
      const match = source.slice(index).match(/^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/i)
      const href = match ? safeHref(match[0]) : null
      if (match && href) {
        out.push({ type: "link", href, children: [{ type: "text", text: match[0] }] })
        index += match[0].length
        continue
      }
    }
    pushText(out, char)
    index++
  }
  return out
}

/* ----------------------------------------------------------------- block */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith("|")) body = body.slice(1)
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1)
  const cells: string[] = []
  let current = ""
  for (let index = 0; index < body.length; index++) {
    if (body[index] === "\\" && body[index + 1] === "|") {
      current += "|"
      index++
    } else if (body[index] === "|") {
      cells.push(current.trim())
      current = ""
    } else current += body[index]
  }
  cells.push(current.trim())
  return cells
}

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line)
  )
}

/** Parse Markdown into blocks. Bounded: deeper nesting than 8 renders as text. */
export function parseMarkdown(source: string, depth = 0): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (!line.trim()) {
      index++
      continue
    }
    const fence = line.match(FENCE)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      index++
      while (index < lines.length && !lines[index]!.trimStart().startsWith(marker)) {
        body.push(lines[index]!)
        index++
      }
      index++
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") })
      continue
    }
    const heading = line.match(HEADING)
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ""),
      })
      index++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" })
      index++
      continue
    }
    if (QUOTE.test(line) && depth < 8) {
      const body: string[] = []
      while (index < lines.length && lines[index]!.trim() && QUOTE.test(lines[index]!)) {
        body.push(lines[index]!.match(QUOTE)![1] ?? "")
        index++
      }
      blocks.push({ type: "quote", children: parseMarkdown(body.join("\n"), depth + 1) })
      continue
    }
    const bullet = line.match(BULLET)
    const ordered = line.match(ORDERED)
    if ((bullet || ordered) && depth < 8) {
      const isOrdered = !bullet
      const indent = (bullet ?? ordered)![1]!.length
      const items: string[][] = []
      while (index < lines.length) {
        const current = lines[index]!
        const item = isOrdered ? current.match(ORDERED) : current.match(BULLET)
        if (item && item[1]!.length === indent) {
          items.push([item[3] ?? ""])
          index++
          continue
        }
        // Continuation: blank lines inside, or anything indented past the marker.
        if (
          items.length > 0 &&
          (current.trim() === "" || /^\s+/.test(current)) &&
          current.search(/\S|$/) > indent
        ) {
          items[items.length - 1]!.push(current.slice(Math.min(current.search(/\S|$/), indent + 2)))
          index++
          continue
        }
        if (items.length > 0 && current.trim() === "" && index + 1 < lines.length) {
          const next = lines[index + 1]!
          const nextItem = isOrdered ? next.match(ORDERED) : next.match(BULLET)
          if (nextItem && nextItem[1]!.length === indent) {
            index++
            continue
          }
        }
        break
      }
      blocks.push({
        type: "list",
        ordered: isOrdered,
        start: isOrdered ? Number(ordered![2]) : 1,
        items: items.map((item) => parseMarkdown(item.join("\n"), depth + 1)),
      })
      continue
    }
    if (line.includes("|") && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]!)) {
      const header = splitRow(line)
      const align = splitRow(lines[index + 1]!).map((cell) => {
        const left = cell.startsWith(":")
        const right = cell.endsWith(":")
        return left && right ? "center" : right ? "right" : left ? "left" : null
      })
      index += 2
      const rows: Inline[][][] = []
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) {
        const cells = splitRow(lines[index]!)
        rows.push(header.map((_, column) => parseInline(cells[column] ?? "")))
        index++
      }
      blocks.push({
        type: "table",
        align: header.map((_, column) => align[column] ?? null),
        header: header.map(parseInline),
        rows,
      })
      continue
    }
    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      (paragraph.length === 0 || !isBlockStart(lines[index]!))
    ) {
      paragraph.push(lines[index]!.trim())
      index++
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) })
  }
  return blocks
}
