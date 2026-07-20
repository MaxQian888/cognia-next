/**
 * Shared sizing + status tokens for the integrated terminal's floating
 * surfaces.
 *
 * These widths/heights were previously hard-coded inline in each overlay
 * (`w-44`, `w-64`, `w-60`, `w-72`, `w-80`, `h-[1.4em]`). Centralising them
 * keeps the floating surfaces consistent and gives one place to tune them.
 * The class strings are kept as complete literals so Tailwind's scanner still
 * detects them from this module.
 */

/** Tailwind sizing utilities for the terminal's floating surfaces. */
export const TERMINAL_LAYOUT = {
  /** Find-in-terminal input width. */
  searchInputWidth: "w-44",
  /** Command-history rail width. */
  historyRailWidth: "w-64",
  /** Command-actions menu width. */
  commandMenuWidth: "w-60",
  /** Quick-fix menu width. */
  quickFixMenuWidth: "w-72",
  /** Completion popup width. */
  completionPopupWidth: "w-80",
  /** Sticky command-header height. */
  stickyScrollHeight: "h-[1.4em]",
} as const

/**
 * Completion-popup vertical clamp (px). The popup renders above the cursor
 * (`-translate-y-full`), so its scrollable list height is bounded to the space
 * above minus room for the hint row/borders — floored at a readable minimum
 * and capped so a tall dock keeps the original size.
 */
export const COMPLETION_POPUP_CLAMP = {
  minPx: 72,
  maxPx: 240,
  reservePx: 28,
} as const

/** Clamp the completion list to the space above the cursor (see above). */
export function completionListMaxHeight(topPx: number): number {
  const { minPx, maxPx, reservePx } = COMPLETION_POPUP_CLAMP
  return Math.max(minPx, Math.min(maxPx, Math.round(topPx) - reservePx))
}

/**
 * Exit-status dot colour shared by the tab strip and the history rail so a
 * finished command reads the same in both places (green = clean exit, red =
 * non-zero, muted = unknown).
 */
export function terminalExitDotClass(exitCode: number | null): string {
  if (exitCode === null) return "bg-muted-foreground/60"
  return exitCode === 0 ? "bg-emerald-500" : "bg-red-500"
}
