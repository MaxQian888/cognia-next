/**
 * Markdown → styled terminal lines.
 *
 * Uses `marked@4`'s lexer (CJS, loads cleanly under Jest) to parse CommonMark +
 * GFM, then flattens the block/inline token tree into a flat list of display
 * lines the Ink `Markdown` component renders. Tolerant of the partial markdown
 * produced mid-stream (e.g. an unterminated code fence) — never throws.
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

/** A GFM table cell as marked@4 emits it. */
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
  /** GFM table fields (marked@4). */
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
        spans.push({ text: t.text ?? "", code: true })
        break
      case "link":
        spans.push({
          text: t.text ?? t.href ?? "",
          link: t.href,
          ...styleFlags(style),
        })
        break
      case "br":
        spans.push({ text: " " })
        break
      default:
        spans.push({ text: t.text ?? t.raw ?? "", ...styleFlags(style) })
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
  return text.length > 0 ? [{ text }] : []
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
  return out
}
