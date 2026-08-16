/**
 * Markdown → styled terminal lines.
 *
 * Uses `marked@18`'s lexer to parse CommonMark + GFM, then flattens the
 * block/inline token tree into a flat list of display lines the Ink `Markdown`
 * component renders. Tolerant of the partial markdown produced mid-stream
 * (e.g. an unterminated code fence) — never throws.
 *
 * marked@18 is ESM-only, which Jest's CommonJS loader cannot execute; the root
 * `jest.config.ts` maps `^marked$` to the package's own UMD build so tests run
 * against the real lexer. Two behaviours changed from the marked@4 this module
 * was originally written for, and both are compensated for below:
 *   - token `text` is no longer HTML-escaped, so code spans/blocks must NOT be
 *     entity-decoded (see `codespan` / `code`);
 *   - a heading now emits a trailing `space` token (see `normalizeBlanks`).
 */
import { lexer } from "marked"

import type { MdLine, MdSpan, TableAlign } from "./types"
import { stringWidth } from "./width"

type InlineToken = {
  type?: string
  text?: string
  raw?: string
  href?: string
  tokens?: InlineToken[]
}

/** A GFM table cell as marked emits it. */
type TableCell = { text?: string; tokens?: InlineToken[] }

type BlockToken = {
  type?: string
  depth?: number
  text?: string
  lang?: string
  ordered?: boolean
  start?: number | "" | string
  tokens?: InlineToken[]
  items?: Array<{ text?: string; tokens?: BlockToken[]; task?: boolean; checked?: boolean }>
  /** GFM table fields. */
  header?: TableCell[]
  rows?: TableCell[][]
  align?: TableAlign[]
}

/** Walk a table cell into styled spans, falling back to its plain text. */
function cellToSpans(cell: TableCell): MdSpan[] {
  return cell.tokens ? inlineToSpans(cell.tokens) : plainSpans(cell.text ?? "")
}

/** 1→a, 2→b, … 26→z, 27→aa — bijective base-26 for nested ordered markers. */
export function toAlpha(n: number): string {
  let out = ""
  let x = Math.max(1, Math.floor(n))
  while (x > 0) {
    const rem = (x - 1) % 26
    out = String.fromCharCode(97 + rem) + out
    x = Math.floor((x - 1) / 26)
  }
  return out
}

/** Named HTML entities that appear in LLM output and that `marked` may leave
 * escaped in inline tokens. The terminal is not HTML, so we decode them to real
 * characters. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  nbsp: " ",
}

/** Decode decimal `&#39;`, hexadecimal `&#x27;`, and named entities. Unknown
 * named entities are left untouched so we don't invent characters. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (_, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec) return String.fromCodePoint(parseInt(dec, 10))
      if (hex) return String.fromCodePoint(parseInt(hex, 16))
      return NAMED_ENTITIES[name ?? ""] ?? `&${name};`
    }
  )
}

/** 1→i, 4→iv, 9→ix — lowercase Roman numerals for deeper ordered markers. */
export function toRoman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ]
  let x = Math.max(1, Math.floor(n))
  let out = ""
  for (const [value, sym] of table) {
    while (x >= value) {
      out += sym
      x -= value
    }
  }
  return out
}

/** The marker for the `n`-th item of an ordered list at nesting `depth`, cycling
 * the numbering scheme by depth the way nested HTML / OpenCode lists do: top
 * level uses decimals (`1.`), the next level letters (`a.`), and deeper levels
 * Roman numerals (`i.`). */
export function orderedMarker(n: number, depth: number): string {
  if (depth <= 0) return `${n}.`
  if (depth === 1) return `${toAlpha(n)}.`
  return `${toRoman(n)}.`
}

interface SpanStyle {
  bold?: boolean
  italic?: boolean
  strike?: boolean
}

/** Walk inline tokens into styled spans, carrying nested emphasis. Exported for
 * direct testing of the defensive fallbacks that partial mid-stream tokens hit. */
export function inlineToSpans(tokens: InlineToken[] | undefined, style: SpanStyle = {}): MdSpan[] {
  if (!Array.isArray(tokens)) return []
  const spans: MdSpan[] = []
  for (const t of tokens) {
    switch (t.type) {
      case "strong":
        spans.push(...inlineToSpans(t.tokens, { ...style, bold: true }))
        break
      case "em":
        spans.push(...inlineToSpans(t.tokens, { ...style, italic: true }))
        break
      case "del":
        spans.push(...inlineToSpans(t.tokens, { ...style, strike: true }))
        break
      case "codespan":
        // Code is verbatim — never decoded. marked@18 hands back the source
        // text unescaped, so decoding would turn a literal `&#39;` typed
        // inside backticks into `'`. (marked@4 escaped it to `&amp;#39;`,
        // which is the only reason this branch used to decode.)
        spans.push({ text: t.text ?? "", code: true })
        break
      case "link":
        spans.push({
          text: decodeHtmlEntities(t.text ?? t.href ?? ""),
          link: t.href,
          ...styleFlags(style),
        })
        break
      case "br":
        spans.push({ text: " " })
        break
      default:
        spans.push({ text: decodeHtmlEntities(t.text ?? t.raw ?? ""), ...styleFlags(style) })
    }
  }
  return spans
}

function styleFlags(style: SpanStyle): SpanStyle {
  const out: SpanStyle = {}
  if (style.bold) out.bold = true
  if (style.italic) out.italic = true
  if (style.strike) out.strike = true
  return out
}

function plainSpans(text: string): MdSpan[] {
  return text.length > 0 ? [{ text: decodeHtmlEntities(text) }] : []
}

/** Flatten block tokens into display lines. Exported for direct testing of the
 * defensive branches synthetic/partial token trees exercise. */
export function blocksToLines(tokens: BlockToken[], depth = 0): MdLine[] {
  const out: MdLine[] = []
  blockToLines(tokens, depth, out)
  return out
}

function blockToLines(tokens: BlockToken[], depth: number, out: MdLine[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        out.push({ kind: "heading", level: token.depth ?? 1, spans: inlineToSpans(token.tokens) })
        break
      case "paragraph":
        out.push({ kind: "paragraph", spans: inlineToSpans(token.tokens) })
        break
      case "code": {
        // Verbatim, for the same reason as `codespan` above — a fenced block
        // containing `&amp;` must render those six characters, not `&`.
        const lines = (token.text ?? "").split("\n")
        const lang = token.lang || undefined
        // Widest body line (display columns) so the renderer can size the frame
        // to the code instead of a fixed width.
        const width = lines.reduce((m, l) => Math.max(m, stringWidth(l)), 0)
        lines.forEach((line, i) => {
          out.push({
            kind: "code",
            lang,
            text: line,
            width,
            ...(i === 0 ? { first: true } : {}),
            ...(i === lines.length - 1 ? { last: true } : {}),
          })
        })
        break
      }
      case "blockquote": {
        const inner: MdLine[] = []
        blockToLines((token.tokens as BlockToken[]) ?? [], depth, inner)
        for (const line of inner) {
          // A blockquote nested inside this one already carries its own depth;
          // bump it so `> >` cascades. Any other inner line is at this quote's
          // outermost level (depth 1).
          if (line.kind === "blockquote") {
            out.push({ ...line, depth: (line.depth ?? 1) + 1 })
          } else {
            out.push({
              kind: "blockquote",
              depth: 1,
              spans: "spans" in line ? line.spans : plainSpans("text" in line ? line.text : ""),
            })
          }
        }
        break
      }
      case "list": {
        const ordered = Boolean(token.ordered)
        let n = typeof token.start === "number" ? token.start : 1
        for (const item of token.items ?? []) {
          // Ordered markers cycle their scheme by depth (1. → a. → i.); bullets
          // stay a simple dot.
          const marker = ordered ? orderedMarker(n++, depth) : "•"
          // GFM task-list checkbox state (`- [x]` / `- [ ]`); undefined for a
          // plain bullet so the renderer keeps the normal marker.
          const checked = item.task ? Boolean(item.checked) : undefined
          const itemBlocks = (item.tokens as BlockToken[]) ?? []
          // The first text/paragraph block is the item's own line; nested lists
          // recurse one level deeper.
          let placedOwnLine = false
          for (const block of itemBlocks) {
            if (!placedOwnLine && (block.type === "text" || block.type === "paragraph")) {
              out.push({
                kind: "listitem",
                depth,
                ordered,
                marker,
                ...(checked !== undefined ? { checked } : {}),
                spans: block.tokens ? inlineToSpans(block.tokens) : plainSpans(block.text ?? ""),
              })
              placedOwnLine = true
            } else if (block.type === "list") {
              blockToLines([block], depth + 1, out)
            }
          }
          if (!placedOwnLine) {
            out.push({
              kind: "listitem",
              depth,
              ordered,
              marker,
              ...(checked !== undefined ? { checked } : {}),
              spans: plainSpans(item.text ?? ""),
            })
          }
        }
        break
      }
      case "table":
        out.push({
          kind: "table",
          header: (token.header ?? []).map(cellToSpans),
          rows: (token.rows ?? []).map((row) => row.map(cellToSpans)),
          align: token.align ?? [],
        })
        break
      case "hr":
        out.push({ kind: "rule" })
        break
      case "space":
        out.push({ kind: "blank" })
        break
      default:
        if (token.text) out.push({ kind: "paragraph", spans: plainSpans(token.text) })
    }
  }
}

export function tokenizeMarkdown(src: string): MdLine[] {
  if (!src) return []
  let tokens: BlockToken[]
  try {
    tokens = lexer(src) as unknown as BlockToken[]
  } catch {
    // Mid-stream markdown can be malformed; degrade to a plain paragraph rather
    // than crash the render.
    return src.split("\n").map((line) => ({ kind: "paragraph", spans: plainSpans(line) }))
  }
  const out: MdLine[] = []
  blockToLines(tokens, 0, out)
  return normalizeBlanks(out)
}

/** Collapse consecutive blank lines and trim a trailing blank so the terminal
 * doesn't waste vertical space on markdown's paragraph-padding tokens. */
function normalizeBlanks(lines: MdLine[]): MdLine[] {
  const filtered: MdLine[] = []
  let lastWasBlank = false
  for (const line of lines) {
    if (line.kind === "blank") {
      // A heading hugs the block beneath it: the blank line separating them in
      // the source is structural, not typographic, and spending a terminal row
      // on it visually detaches a heading from its own content. marked@4 folded
      // that blank into the heading token; marked@18 emits it as a `space`, so
      // the rule is now enforced here instead of inherited from the lexer.
      const afterHeading = filtered[filtered.length - 1]?.kind === "heading"
      if (!lastWasBlank && !afterHeading) filtered.push(line)
      lastWasBlank = true
    } else {
      filtered.push(line)
      lastWasBlank = false
    }
  }
  // Drop a trailing blank line; keep internal blanks between blocks.
  if (filtered[filtered.length - 1]?.kind === "blank") filtered.pop()
  return filtered
}
