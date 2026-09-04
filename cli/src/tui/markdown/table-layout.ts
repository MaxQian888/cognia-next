/**
 * Column geometry for a GFM table, shared by the two renderers that draw one.
 *
 * The Ink `Markdown` component paints the scrollback layout. `cell-terminal-block`
 * paints the virtualized fullscreen viewport, which is the DEFAULT layout. They
 * used to compute table geometry separately, and only one of them computed any:
 * the fullscreen path joined cells with `" │ "` and ruled the header with
 * `"─".repeat(header.length)`, a JavaScript character count, so a CJK cell drew
 * a rule half the width of the row above it. Putting the math here means the two
 * surfaces cannot disagree about where a column starts.
 *
 * Pure and width-aware: every measurement is in DISPLAY columns via
 * {@link stringWidth}, never in code units.
 */
import { stringWidth, truncateToWidth } from "./width"
import type { MdLine, MdSpan, TableAlign } from "./types"

/** The box-drawing pieces of a framed table, in one place so the rules and the
 * body can never disagree about which corner belongs where. */
export const TABLE_FRAME = {
  topLeft: "╭",
  topJoin: "┬",
  topRight: "╮",
  midLeft: "├",
  midJoin: "┼",
  midRight: "┤",
  bottomLeft: "╰",
  bottomJoin: "┴",
  bottomRight: "╯",
  vertical: "│",
  horizontal: "─",
} as const

/** The three glyphs that open, join and close one horizontal rule. */
export interface TableRuleEnds {
  left: string
  join: string
  right: string
}

export const TABLE_RULE_TOP: TableRuleEnds = {
  left: TABLE_FRAME.topLeft,
  join: TABLE_FRAME.topJoin,
  right: TABLE_FRAME.topRight,
}
export const TABLE_RULE_MID: TableRuleEnds = {
  left: TABLE_FRAME.midLeft,
  join: TABLE_FRAME.midJoin,
  right: TABLE_FRAME.midRight,
}
export const TABLE_RULE_BOTTOM: TableRuleEnds = {
  left: TABLE_FRAME.bottomLeft,
  join: TABLE_FRAME.bottomJoin,
  right: TABLE_FRAME.bottomRight,
}

/**
 * Columns a framed table spends on its own borders: one edge glyph and one pad
 * space on each side of every cell, sharing a glyph between neighbours.
 *
 * `│ a │ bb │` is `w0 + w1 + 7` wide for two columns, hence `3 * cols + 1`.
 */
export function tableFrameOverhead(cols: number): number {
  return cols > 0 ? 3 * cols + 1 : 0
}

/** One horizontal rule of the frame, joined at every column boundary. */
export function tableRule(widths: readonly number[], ends: TableRuleEnds): string {
  return (
    ends.left + widths.map((w) => TABLE_FRAME.horizontal.repeat(w + 2)).join(ends.join) + ends.right
  )
}

/** Left/right padding strings to set a cell of `used` width into `width` per its
 * column alignment. `used`/`width` are display columns. */
export function padCell(
  used: number,
  width: number,
  align: TableAlign
): { left: string; right: string } {
  const gap = Math.max(0, width - used)
  if (align === "right") return { left: " ".repeat(gap), right: "" }
  if (align === "center") {
    const left = Math.floor(gap / 2)
    return { left: " ".repeat(left), right: " ".repeat(gap - left) }
  }
  return { left: "", right: " ".repeat(gap) }
}

/**
 * Collect, in stable document order, the distinct link URLs of a table that need
 * a footnote reference. A link is footnoted only when it can't be made clickable
 * inline (no OSC-8) and its URL differs from its visible text, because otherwise
 * the raw URL would either bloat the cell (breaking column alignment, since the
 * inline `(url)` suffix isn't counted) or be redundant. Returns `[]` when nothing
 * needs a footnote, so an ordinary table is unchanged.
 */
export function collectTableFootnotes(
  line: Extract<MdLine, { kind: "table" }>,
  hyperlinks: boolean
): string[] {
  if (hyperlinks) return []
  const urls: string[] = []
  const scan = (spans: MdSpan[]) => {
    for (const s of spans) {
      if (s.link && s.link !== s.text && !urls.includes(s.link)) urls.push(s.link)
    }
  }
  for (const cell of line.header) scan(cell)
  for (const row of line.rows) for (const cell of row) scan(cell)
  return urls
}

/**
 * A table cell as a plain string with footnoted links rendered as `label[n]`.
 *
 * The single source of truth for both column-width measurement and truncation,
 * so styled rendering and width math never disagree (the old bug: the inline
 * `(url)` suffix inflated a link cell's render but not its measured width).
 */
export function cellRefText(spans: MdSpan[], footnotes: string[]): string {
  return spans
    .map((s) => {
      const ref = s.link ? footnotes.indexOf(s.link) : -1
      return ref >= 0 ? `${s.text}[${ref + 1}]` : s.text
    })
    .join("")
}

export interface TableLayout {
  /** Display width of each column, excluding the frame's padding. */
  widths: number[]
  /** Whether any column was narrowed to fit, so cells may need truncating. */
  capped: boolean
}

/**
 * Measure a table's columns, capping them to fit `maxWidth` when the natural
 * width overflows.
 *
 * `cellText` is how the caller turns a cell's spans into the string that will
 * actually be printed. The two renderers differ there (one footnotes links),
 * and measuring anything other than what is printed is how a column drifts.
 */
export function tableLayout(
  line: Extract<MdLine, { kind: "table" }>,
  cellText: (spans: MdSpan[]) => string,
  maxWidth?: number
): TableLayout {
  const cols = line.header.length
  const widths: number[] = []
  for (let c = 0; c < cols; c++) {
    let w = stringWidth(cellText(line.header[c] ?? []))
    for (const row of line.rows) w = Math.max(w, stringWidth(cellText(row[c] ?? [])))
    widths[c] = w
  }
  if (!maxWidth || maxWidth <= 0 || cols === 0) return { widths, capped: false }
  const overhead = tableFrameOverhead(cols)
  const natural = widths.reduce((a, b) => a + b, 0) + overhead
  if (natural <= maxWidth) return { widths, capped: false }
  // An even share of what is left after the frame, with a floor so a very narrow
  // terminal still shows the first few characters of every column rather than
  // collapsing one to nothing.
  const cap = Math.max(3, Math.floor(Math.max(cols * 3, maxWidth - overhead) / cols))
  for (let c = 0; c < cols; c++) widths[c] = Math.min(widths[c], cap)
  return { widths, capped: true }
}

/** The printable form of one cell: truncated with an ellipsis when the column
 * was capped below it, and the padding that sets it in its column. */
export function fitCell(
  text: string,
  width: number,
  align: TableAlign,
  capped: boolean
): { text: string; left: string; right: string; truncated: boolean } {
  const truncated = capped && stringWidth(text) > width
  const shown = truncated ? truncateToWidth(text, width) : text
  const { left, right } = padCell(stringWidth(shown), width, align)
  return { text: shown, left, right, truncated }
}
