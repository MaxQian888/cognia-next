/**
 * Where the session summary card goes, as a pure function of the chat stage.
 *
 * The card floats beside the conversation when the gutter next to the centred
 * chat column is wide enough to hold it; otherwise it is a popover under its
 * trigger, opened on demand. Either way it never extends past the stage, so a
 * narrow window cannot push it off the chat (or over the dock beside it).
 */

/** The card's width when the stage has room for it. */
export const SUMMARY_CARD_WIDTH_PX = 288
/** Space kept between the card and the stage's edges / the chat column. */
export const SUMMARY_CARD_MARGIN_PX = 16
/** The chat column's max width in rem — `chatColumnClass` (`max-w-[52rem]`). */
export const CHAT_COLUMN_MAX_REM = 52

export type SummaryCardMode = "float" | "popover"

export interface SummaryCardPlacement {
  mode: SummaryCardMode
  /** Rendered width: the full card, or what the stage leaves. */
  width: number
}

export function summaryCardPlacement(
  stageWidth: number,
  columnMaxWidth: number
): SummaryCardPlacement {
  const width = Math.max(0, Math.min(SUMMARY_CARD_WIDTH_PX, stageWidth - SUMMARY_CARD_MARGIN_PX))
  // An unmeasured stage (0 on the first frame, or a host that does not render
  // one) never floats: floating is a layout claim that has to be measured.
  if (stageWidth <= 0) return { mode: "popover", width: SUMMARY_CARD_WIDTH_PX }
  const gutter = (stageWidth - Math.min(stageWidth, columnMaxWidth)) / 2
  const floats = gutter >= SUMMARY_CARD_WIDTH_PX + SUMMARY_CARD_MARGIN_PX
  return { mode: floats ? "float" : "popover", width }
}
