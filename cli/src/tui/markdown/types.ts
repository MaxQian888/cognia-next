/**
 * Type-only shapes for the terminal markdown renderer (tokenizer → styled lines)
 * and diff/highlight helpers. Excluded from coverage (TS strips at runtime).
 */

/** An inline run of text with terminal styling. */
export interface MdSpan {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  /** Link target, when this span is a hyperlink label. */
  link?: string
}

export type MdLine =
  | { kind: "heading"; level: number; spans: MdSpan[] }
  | { kind: "paragraph"; spans: MdSpan[] }
  | { kind: "code"; lang?: string; text: string }
  | { kind: "blockquote"; spans: MdSpan[] }
  | { kind: "listitem"; depth: number; ordered: boolean; marker: string; spans: MdSpan[] }
  | { kind: "rule" }
  | { kind: "blank" }

/** A syntax-highlighted segment: text plus an optional terminal color name. */
export interface HiSegment {
  text: string
  color?: string
}

/** A line of a rendered file diff. */
export interface DiffLine {
  kind: "add" | "del" | "context" | "meta"
  text: string
}
