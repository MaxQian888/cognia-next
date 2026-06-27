/**
 * Pure hit-test: map an absolute terminal click row to a row inside a bordered
 * list overlay (the `/agents` panel and friends).
 *
 * Ink exposes no per-child coordinates, but these panels render a fixed vertical
 * layout — a bordered box, a header, an optional "↑ N more" scroll indicator,
 * then exactly one terminal row per visible item. Given the panel's absolute top
 * (from {@link absoluteTopLeft}) and those offsets, the clicked item is plain
 * arithmetic. Returns the 0-based offset WITHIN the visible window; the caller
 * adds the window's `start` to recover the absolute row index. Returns null when
 * the click lands on the border/header/indicator/footer rather than an item.
 *
 * Columns are ignored: items span the panel width, so clicking anywhere on a
 * line selects it. Pure → unit-tested without a terminal.
 */
export interface PanelClickArgs {
  /** 0-based absolute terminal row of the click. */
  clickRow: number
  /** 0-based absolute terminal row of the panel's top border. */
  panelTop: number
  /** Rows the header occupies before the first item (title line[s]). */
  headerRows: number
  /** Whether the "↑ N more" indicator row is currently shown above the items. */
  hasAboveMore: boolean
  /** Number of item rows currently rendered in the visible window. */
  visibleCount: number
  /** Rows the box border reserves above the header (round/single border = 1). */
  borderRows?: number
}

/** The clicked item's window offset, or null when the click missed the item band. */
export function rowAtClick({
  clickRow,
  panelTop,
  headerRows,
  hasAboveMore,
  visibleCount,
  borderRows = 1,
}: PanelClickArgs): number | null {
  const firstItemRow = panelTop + borderRows + headerRows + (hasAboveMore ? 1 : 0)
  const offset = clickRow - firstItemRow
  if (offset < 0 || offset >= visibleCount) return null
  return offset
}
