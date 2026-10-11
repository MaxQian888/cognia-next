/**
 * Sticky columns for the performance tables.
 *
 * The tables are 7–10 columns of numbers inside `ui/table`'s `overflow-x-auto`
 * wrapper. On a phone that scrolled sideways, which is fine for numbers but
 * not for the two columns that give a row its meaning: the NAME scrolled out
 * of view, leaving a row of figures with no label, and the managed-process
 * ACTIONS (Restart / Kill) started off-screen to the right. Pinning those two
 * keeps every row readable and actionable at any width; on a wide screen
 * nothing scrolls and the pins are inert.
 *
 * A pinned cell has to be opaque, or the columns scrolling under it show
 * through. The row-hover tint is the opaque equivalent of `bg-muted/50` over
 * the background, so a pinned cell hovers with the rest of its row.
 */

const OPAQUE_ROW_HOVER = "[tr:hover>&]:bg-[color-mix(in_oklch,var(--muted)_50%,var(--background))]"

/** The leading (name) column: pinned to the start edge, ruled on its trailing side. */
export const PIN_START = `sticky left-0 z-10 bg-background shadow-[inset_-1px_0_0_var(--border)] ${OPAQUE_ROW_HOVER}`

/** The trailing (actions) column: pinned to the end edge, ruled on its leading side. */
export const PIN_END = `sticky right-0 z-10 bg-background shadow-[inset_1px_0_0_var(--border)] ${OPAQUE_ROW_HOVER}`

/** The name cell's width cap, so a long name truncates instead of widening the pinned column. */
export const PIN_START_MAX_WIDTH = "max-w-[45vw] sm:max-w-none"
