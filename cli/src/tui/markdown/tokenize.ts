/**
 * Markdown → styled terminal lines.
 *
 * Uses `marked@4`'s lexer (CJS, loads cleanly under Jest) to parse CommonMark +
 * GFM, then flattens the block/inline token tree into a flat list of display
 * lines the Ink `Markdown` component renders. Tolerant of the partial markdown
 * produced mid-stream (e.g. an unterminated code fence) — never throws.
 */
import { lexer } from "marked"

import type { MdLine, MdSpan } from "./types"

type InlineToken = {
  type?: string
  text?: string
  raw?: string
  href?: string
  tokens?: InlineToken[]
}

type BlockToken = {
  type?: string
  depth?: number
  text?: string
  lang?: string
  ordered?: boolean
  start?: number | "" | string
  tokens?: InlineToken[]
  items?: Array<{ text?: string; tokens?: BlockToken[] }>
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
        for (const line of lines) {
          out.push({ kind: "code", lang: token.lang || undefined, text: line })
        }
        break
      }
      case "blockquote": {
        const inner: MdLine[] = []
        blockToLines((token.tokens as BlockToken[]) ?? [], depth, inner)
        for (const line of inner) {
          out.push({
            kind: "blockquote",
            spans: "spans" in line ? line.spans : plainSpans("text" in line ? line.text : ""),
          })
        }
        break
      }
      case "list": {
        const ordered = Boolean(token.ordered)
        let n = typeof token.start === "number" ? token.start : 1
        for (const item of token.items ?? []) {
          const marker = ordered ? `${n++}.` : "•"
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
              spans: plainSpans(item.text ?? ""),
            })
          }
        }
        break
      }
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
