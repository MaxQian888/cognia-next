/**
 * Markdown ⇄ document blocks.
 *
 * Models write Markdown natively; building a report out of dozens of
 * `appendParagraph` operations is slow and error-prone. `parseMarkdownBlocks`
 * turns CommonMark/GFM block structure into document blocks:
 *
 * | Markdown                         | Block                               |
 * | -------------------------------- | ----------------------------------- |
 * | `#`…`######`, setext `===`/`---` | heading, level 1–6                  |
 * | paragraph                        | paragraph (hard breaks keep `\n`)   |
 * | `-`/`*`/`+`, `1.`/`1)` items     | list-item, nesting → `level` 0–8    |
 * | `>` quote                        | quote (one per quoted paragraph)    |
 * | fenced or indented code          | code (verbatim, with its language)  |
 * | GFM pipe table                   | table (header row first)            |
 *
 * The block model stores plain text, so inline formatting is flattened:
 * emphasis/strong/strikethrough/code-span markers are removed, links become
 * `text (url)`, images become their alt text, and thematic breaks are dropped.
 * Every such loss is reported in `notes` so the caller can tell the user what
 * the conversion did not keep — nothing is dropped silently.
 *
 * `blocksToMarkdown` is the inverse used for reading a document back as text
 * (reviews, prompts, `documents_read_markdown`).
 */

import type { DocumentBlock, DocumentBlockInput } from "./model"

export const MAX_LIST_LEVEL = 8

/** What a Markdown conversion could not represent in the block model. */
export type MarkdownConversionNote =
  "inline-formatting" | "links" | "images" | "thematic-breaks" | "html"

/** One sentence per note, for the model to relay to the user. */
export const MARKDOWN_NOTE_MESSAGES: Record<MarkdownConversionNote, string> = {
  "inline-formatting":
    "Bold, italic, strikethrough, and code-span markers were removed; document text is plain.",
  links: 'Links were kept as "text (url)".',
  images: "Images were replaced by their alt text.",
  "thematic-breaks": "Horizontal rules were dropped.",
  html: "Raw HTML was kept as literal text.",
}

/** The union of what converting each Markdown source could not keep. */
export function markdownConversionNotes(sources: readonly string[]): MarkdownConversionNote[] {
  const notes = new Set<MarkdownConversionNote>()
  for (const source of sources)
    for (const note of parseMarkdownBlocks(source).notes) notes.add(note)
  return [...notes]
}

export interface MarkdownParseResult {
  blocks: DocumentBlockInput[]
  notes: MarkdownConversionNote[]
}

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)?.*$/
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const THEMATIC_BREAK = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const QUOTE = /^ {0,3}>[ ]?(.*)$/
const TABLE_SEPARATOR = /^ {0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const HTML_BLOCK = /^ {0,3}<(?:[A-Za-z][\w-]*|!--)[\s\S]*$/
/** A line holding only an HTML comment (e.g. a `<!-- block:b3 -->` marker). */
const COMMENT_LINE = /^\s*<!--[\s\S]*?-->\s*$/

export function parseMarkdownBlocks(markdown: string): MarkdownParseResult {
  const notes = new Set<MarkdownConversionNote>()
  const blocks: DocumentBlockInput[] = []
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  let index = 0
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (!paragraph.length) return
    const text = joinParagraph(paragraph, notes)
    if (text.trim()) blocks.push({ type: "paragraph", text })
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index]

    // Comment lines are invisible in rendered Markdown; they end a paragraph
    // like a blank line does (block-id markers from `blocksToMarkdown`).
    if (!line.trim() || COMMENT_LINE.test(line)) {
      flushParagraph()
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      flushParagraph()
      const marker = fence[2]
      const indent = fence[1].length
      const body: string[] = []
      index += 1
      while (index < lines.length) {
        const candidate = lines[index]
        const closing = new RegExp(
          `^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`
        )
        if (closing.test(candidate)) {
          index += 1
          break
        }
        body.push(stripIndent(candidate, indent))
        index += 1
      }
      const language = fence[3]?.trim()
      blocks.push({
        type: "code",
        text: body.join("\n"),
        ...(language ? { language } : {}),
      })
      continue
    }

    const heading = ATX_HEADING.exec(line)
    if (heading) {
      flushParagraph()
      const text = inline(heading[2] ?? "", notes)
      if (text.trim())
        blocks.push({ type: "heading", level: heading[1].length as HeadingLevel, text })
      index += 1
      continue
    }

    // A setext underline turns the paragraph above it into a heading; a bare
    // `---` with no paragraph is a thematic break.
    const setext = SETEXT.exec(line)
    if (setext && paragraph.length) {
      const text = joinParagraph(paragraph, notes)
      paragraph = []
      if (text.trim()) blocks.push({ type: "heading", level: setext[1][0] === "=" ? 1 : 2, text })
      index += 1
      continue
    }

    if (THEMATIC_BREAK.test(line)) {
      flushParagraph()
      notes.add("thematic-breaks")
      index += 1
      continue
    }

    if (isTableStart(lines, index)) {
      flushParagraph()
      const rows: string[][] = [splitTableRow(lines[index], notes)]
      index += 2
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index], notes))
        index += 1
      }
      const width = Math.max(...rows.map((row) => row.length))
      blocks.push({
        type: "table",
        rows: rows.map((row) => [...row, ...Array<string>(width - row.length).fill("")]),
      })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      flushParagraph()
      let current: string[] = []
      const flushQuote = () => {
        const text = joinParagraph(current, notes)
        if (text.trim()) blocks.push({ type: "quote", text })
        current = []
      }
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index])
        if (!match) {
          // Lazy continuation: a plain line right after quoted text belongs to it.
          if (lines[index].trim() && current.length && !startsBlock(lines, index)) {
            current.push(lines[index])
            index += 1
            continue
          }
          break
        }
        // Nested `>` markers flatten into the same quote.
        const content = match[1].replace(/^(?: {0,3}>[ ]?)+/, "")
        if (!content.trim()) flushQuote()
        else current.push(content)
        index += 1
      }
      flushQuote()
      continue
    }

    // Indented code (4+ spaces) only starts outside a paragraph, and wins
    // over a list marker at that depth.
    if (!paragraph.length && /^( {4}|\t)/.test(line)) {
      const body: string[] = []
      while (index < lines.length && (/^( {4}|\t)/.test(lines[index]) || !lines[index].trim())) {
        body.push(lines[index].replace(/^( {4}|\t)/, ""))
        index += 1
      }
      while (body.length && !body[body.length - 1].trim()) body.pop()
      blocks.push({ type: "code", text: body.join("\n") })
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item && (!paragraph.length || /^[-*+]|^1[.)]/.test(item[2]))) {
      flushParagraph()
      index = parseList(lines, index, blocks, notes)
      continue
    }

    if (!paragraph.length && HTML_BLOCK.test(line)) notes.add("html")
    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  return { blocks, notes: [...notes] }
}

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/**
 * Consume a list starting at `start`. Nesting follows each item's indentation
 * relative to the first item; an indented non-item line continues the
 * previous item.
 */
function parseList(
  lines: string[],
  start: number,
  blocks: DocumentBlockInput[],
  notes: Set<MarkdownConversionNote>
): number {
  const baseIndent = indentWidth(LIST_ITEM.exec(lines[start])![1])
  // Indent widths of the currently open nesting levels, outermost first.
  const levels: number[] = [baseIndent]
  let current: { ordered: boolean; level: number; lines: string[] } | null = null
  const flush = () => {
    if (!current) return
    const text = joinParagraph(current.lines, notes)
    if (text.trim())
      blocks.push({ type: "list-item", ordered: current.ordered, level: current.level, text })
    current = null
  }
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (COMMENT_LINE.test(line)) {
      index += 1
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      const indent = indentWidth(item[1])
      if (indent < baseIndent) break
      while (levels.length > 1 && indent < levels[levels.length - 1]) levels.pop()
      if (indent > levels[levels.length - 1] + 1) levels.push(indent)
      flush()
      current = {
        ordered: /\d/.test(item[2]),
        level: Math.min(levels.length - 1, MAX_LIST_LEVEL),
        lines: [taskMarker(item[3])],
      }
      index += 1
      continue
    }
    if (!line.trim()) {
      // A blank line ends the list unless the next line is still part of it.
      const next = lines[index + 1]
      if (next !== undefined && (LIST_ITEM.exec(next) || /^( {2,}|\t)\S/.test(next))) {
        index += 1
        continue
      }
      break
    }
    if (current && /^( {2,}|\t)/.test(line) && !startsBlock(lines, index)) {
      current.lines.push(line.trim())
      index += 1
      continue
    }
    if (current && !startsBlock(lines, index)) {
      // Lazy continuation of the item's paragraph.
      current.lines.push(line.trim())
      index += 1
      continue
    }
    break
  }
  flush()
  return index
}

function taskMarker(text: string): string {
  const match = /^\[([ xX])\][ \t]+(.*)$/.exec(text)
  if (!match) return text
  return `${match[1] === " " ? "☐" : "☑"} ${match[2]}`
}

function indentWidth(value: string): number {
  return [...value].reduce((width, char) => width + (char === "\t" ? 4 : 1), 0)
}

function stripIndent(line: string, indent: number): string {
  let removed = 0
  while (removed < indent && line[removed] === " ") removed += 1
  return line.slice(removed)
}

/** Whether `lines[index]` opens a block that interrupts a paragraph. */
function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index]
  return (
    FENCE.test(line) ||
    ATX_HEADING.test(line) ||
    THEMATIC_BREAK.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, index)
  )
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index]
  const separator = lines[index + 1]
  if (!header?.includes("|") || separator === undefined || !separator.includes("-")) return false
  if (!TABLE_SEPARATOR.test(separator)) return false
  return splitCells(header).length === splitCells(separator).length
}

function splitCells(line: string): string[] {
  let text = line.trim()
  if (text.startsWith("|")) text = text.slice(1)
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1)
  const cells: string[] = []
  let cell = ""
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      cell += "|"
      i += 1
    } else if (text[i] === "|") {
      cells.push(cell)
      cell = ""
    } else {
      cell += text[i]
    }
  }
  cells.push(cell)
  return cells.map((value) => value.trim())
}

function splitTableRow(line: string, notes: Set<MarkdownConversionNote>): string[] {
  return splitCells(line).map((cell) => inline(cell.replace(/<br\s*\/?>/gi, "\n"), notes))
}

/**
 * Join a paragraph's lines: a hard break (two trailing spaces or a trailing
 * backslash) keeps a newline, a soft break becomes a space.
 */
function joinParagraph(lines: string[], notes: Set<MarkdownConversionNote>): string {
  let text = ""
  lines.forEach((raw, index) => {
    const last = index === lines.length - 1
    const hard = / {2,}$/.test(raw) || /\\$/.test(raw)
    const line = raw.replace(/\\$/, "").trim()
    text += line
    if (!last) text += hard ? "\n" : " "
  })
  return inline(text, notes)
}

/** Any ASCII punctuation may be backslash-escaped (CommonMark §2.4). */
const ESCAPABLE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g

/** Flatten inline Markdown to plain text, recording what was lost. */
export function inline(source: string, notes: Set<MarkdownConversionNote>): string {
  // Code spans and backslash escapes are literal: park them in placeholders
  // so emphasis and link rules never see their characters.
  const literals: string[] = []
  const park = (value: string) => {
    literals.push(value)
    return `\u0000${literals.length - 1}\u0000`
  }
  let text = source.replace(
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g,
    (_match, _ticks, content: string) => {
      notes.add("inline-formatting")
      return park(/^ .* $/.test(content) && content.trim() ? content.slice(1, -1) : content)
    }
  )
  text = text.replace(ESCAPABLE, (_match, char: string) => park(char))
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_match, alt: string) => {
    notes.add("images")
    return alt
  })
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_match, label: string, url: string) => {
      notes.add("links")
      return label === url ? url : `${label} (${url})`
    }
  )
  text = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, (_match, url: string) => url)
  text = text.replace(/<br\s*\/?>/gi, "\n")
  if (/<\/?[A-Za-z][^>]*>/.test(text)) notes.add("html")
  const before = text
  text = text
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
  if (text !== before) notes.add("inline-formatting")
  return text.replace(/\u0000(\d+)\u0000/g, (_match, i: string) => literals[Number(i)])
}

// ---------------------------------------------------------------------------
// Blocks → Markdown
// ---------------------------------------------------------------------------

export interface BlocksToMarkdownOptions {
  /** Prefix every block with `<!-- block:<id> -->` so edits can target it. */
  blockIds?: boolean
}

export function blocksToMarkdown(
  blocks: readonly DocumentBlock[],
  options: BlocksToMarkdownOptions = {}
): string {
  const parts: string[] = []
  let listRun: Array<Extract<DocumentBlock, { type: "list-item" }>> = []
  const flushList = () => {
    if (!listRun.length) return
    parts.push(renderList(listRun, options))
    listRun = []
  }
  for (const block of blocks) {
    if (block.type === "list-item") {
      listRun.push(block)
      continue
    }
    flushList()
    const marker = options.blockIds ? `<!-- block:${block.id} -->\n` : ""
    parts.push(marker + renderBlock(block))
  }
  flushList()
  return parts.join("\n\n")
}

function renderBlock(block: Exclude<DocumentBlock, { type: "list-item" }>): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(block.level)} ${escapeLine(block.text).replace(/\n/g, " ")}`
    case "paragraph":
      return hardBreaks(escapeLine(block.text))
    case "quote":
      return hardBreaks(escapeLine(block.text))
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n")
    case "code": {
      const longest = Math.max(2, ...(block.text.match(/`+/g) ?? []).map((run) => run.length))
      const fence = "`".repeat(longest + 1)
      return `${fence}${block.language ?? ""}\n${block.text}\n${fence}`
    }
    case "table":
      return renderTable(block.rows)
  }
}

/**
 * Markdown nests one level at a time, so a list that skips a level (level 0
 * straight to 2) reads back one level shallower; everything else round-trips.
 */
function renderList(
  items: ReadonlyArray<Extract<DocumentBlock, { type: "list-item" }>>,
  options: BlocksToMarkdownOptions
): string {
  // Ordered numbering restarts per level whenever an outer item intervenes.
  const counters: number[] = []
  return items
    .map((item) => {
      const level = item.level ?? 0
      counters.length = level + 1
      counters[level] = (counters[level] ?? 0) + 1
      const indent = "   ".repeat(level)
      const bullet = item.ordered ? `${counters[level]}.` : "-"
      const text = escapeLine(item.text).replace(/\n/g, `  \n${indent}   `)
      const marker = options.blockIds ? `${indent}<!-- block:${item.id} -->\n` : ""
      return `${marker}${indent}${bullet} ${text}`
    })
    .join("\n")
}

function renderTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length))
  const cell = (value: string) => escapeInline(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>")
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cell(row[i] ?? "")).join(" | ")} |`
  const [header = [], ...body] = rows
  return [line(header), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n")
}

function hardBreaks(text: string): string {
  return text.replace(/\n/g, "  \n")
}

/** Escape text that would otherwise start a Markdown block on re-parse. */
function escapeLine(text: string): string {
  return escapeInline(text)
    .split("\n")
    .map((line) =>
      line
        .replace(/^(\s*)(#{1,6}\s|>|[-+]\s|`{3}|~{3})/, "$1\\$2")
        .replace(/^(\s*)(\d+)([.)]\s)/, "$1$2\\$3")
        .replace(/^(\s*)(={3,}|-{3,})\s*$/, "$1\\$2")
    )
    .join("\n")
}

/** Escape characters that would read as inline formatting. */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]])/g, "\\$1")
}
