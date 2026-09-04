/**
 * Pane size resolution for `FeaturePageShell`.
 *
 * `react-resizable-panels` reads a size as a percentage when it carries no
 * unit and as a CSS length when it does. The shell's own API predates that:
 * it took plain numbers and always appended `%`. A percentage rail grows with
 * the window, which is wrong for a rail of short labels sitting next to a
 * fixed-width column, because the two only agree at one window size.
 *
 * Numbers keep meaning percent so no existing caller changes. A string is
 * handed through untouched, which is what lets a caller pin a rail.
 */

/** `12` becomes `"12%"`. `"13rem"` stays `"13rem"`. */
export function paneSize(value: number | string | undefined, fallback: number): string {
  if (typeof value === "string") return value
  return `${value ?? fallback}%`
}

export interface CenterPaneSizeInput {
  /** Left pane default, or undefined when there is no left pane. */
  left: number | string | undefined
  hasLeft: boolean
  right: number | string | undefined
  hasRight: boolean
  leftFallback: number
  rightFallback: number
}

/**
 * The center pane's explicit percentage, or `undefined` to let the library
 * assign it the remainder.
 *
 * A CSS-length sibling has no percentage to subtract from 100, so any number
 * the shell produced there would be wrong. Returning undefined is the honest
 * answer, and the library already handles an unsized panel.
 */
export function centerPaneSize({
  left,
  hasLeft,
  right,
  hasRight,
  leftFallback,
  rightFallback,
}: CenterPaneSizeInput): string | undefined {
  if ((hasLeft && typeof left === "string") || (hasRight && typeof right === "string")) {
    return undefined
  }
  const leftPercent = hasLeft ? (left ?? leftFallback) : 0
  const rightPercent = hasRight ? (right ?? rightFallback) : 0
  return `${100 - (leftPercent as number) - (rightPercent as number)}%`
}
