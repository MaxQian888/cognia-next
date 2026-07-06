/**
 * Pure hit-test for the composer's `/` slash palette and `@` mention popup, both
 * of which render ABOVE the composer. Until now those popups were keyboard-only:
 * a click in the fullscreen `scroll` mouse mode fell through to the buffer
 * cursor logic and did nothing useful. This maps an absolute click row to the
 * candidate it lands on so a click selects + accepts the row (parity with the
 * bordered overlay panels, which already use {@link rowAtClick}).
 *
 * The two popups have slightly different fixed layouts, so the caller passes the
 * layout offsets it already computed for rendering:
 *
 *   SlashPalette  → border(1) · optional "↑ N more" · items · optional "↓ N more"
 *   MentionPalette→ border(1) · ALWAYS one indicator slot · items · slots…
 *
 * Pure → unit-tested without a terminal.
 */
import { rowAtClick } from "./panel-click"

export interface ComposerPopupClickArgs {
  /** 0-based absolute terminal row of the click. */
  clickRow: number
  /** 0-based absolute terminal row of the popup's top border. */
  popupTop: number
  /** Fixed rows between the top border and the first item row. The SlashPalette
   * has none (0); the MentionPalette always renders one top-indicator slot (1). */
  headerRows: number
  /** SlashPalette only: a real "↑ N more" row precedes the items while scrolled.
   * The MentionPalette folds that indicator into its fixed header slot, so it
   * passes false here. */
  hasAboveMore: boolean
  /** Candidates scrolled off the top of the window — added to the in-window
   * offset to recover the absolute index into the flattened candidate list. */
  hiddenAbove: number
  /** Number of candidate rows currently rendered in the window. */
  visibleCount: number
}

/**
 * The absolute index (into the flattened candidate list) of the row under the
 * click, or null when the click lands on the border / an indicator slot / below
 * the last row.
 */
export function composerPopupRowAtClick({
  clickRow,
  popupTop,
  headerRows,
  hasAboveMore,
  hiddenAbove,
  visibleCount,
}: ComposerPopupClickArgs): number | null {
  const offset = rowAtClick({
    clickRow,
    panelTop: popupTop,
    headerRows,
    hasAboveMore,
    visibleCount,
    borderRows: 1,
  })
  if (offset === null) return null
  return hiddenAbove + offset
}
