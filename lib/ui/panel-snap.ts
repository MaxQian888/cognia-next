/**
 * Release-snap for draggable side panels — where a panel should land when the
 * user lets go of the divider.
 *
 * Shared by every Context Workbench host (the chat artifact dock, Canvas, the
 * workflow editor, the project editor) so "drag it nearly closed and it shuts",
 * "drag it out of the rail and it opens", and "drop it near a preset and it
 * clicks into place" behave identically on all four. Each host owns different
 * width state — percentages of a `ResizablePanelGroup` in three of them, raw
 * pixels in the project editor — so this stays a pure function over numbers and
 * never touches a store.
 *
 * **Snapping happens on release, not during the drag.** A live magnet would have
 * to write the corrected size back from inside the very layout callback the
 * resize triggers, which re-enters; it would also fight the per-tick width write
 * each host already does to track the pointer. Deciding once on `pointerup`
 * keeps the drag itself completely free.
 *
 * **Unit-agnostic.** `value`, `presets`, `floor`, `expandTo` and `magnet` are
 * all in whatever unit the caller works in — percentages of the group for the
 * three `ResizablePanelGroup` hosts, raw pixels for the project editor, which
 * sizes the workbench itself. Percentage callers convert the physical magnet
 * radius with {@link magnetAsPercent}; a magnet that feels right is a physical
 * distance, and a fixed 3% would be 38px on a 1280px window and 77px on a
 * 2560px one, turning every preset into a well you cannot drop next to.
 */

/** Default magnet radius. Roughly a divider's grab area, so it never surprises. */
export const PANEL_SNAP_MAGNET_PX = 24

/**
 * The magnet radius as a percentage of a group `groupWidthPx` wide. Returns 0
 * when the group has not measured yet (jsdom, the first layout callback), which
 * disables magnetism rather than snapping against a bogus scale.
 */
export function magnetAsPercent(groupWidthPx: number, magnetPx = PANEL_SNAP_MAGNET_PX): number {
  if (!Number.isFinite(groupWidthPx) || groupWidthPx <= 0) return 0
  return (magnetPx / groupWidthPx) * 100
}

export interface PanelSnapOptions {
  /** Widths to magnetize toward, in the caller's unit. */
  presets: readonly number[]
  /**
   * Below this the panel is considered shut. Pass the same value the host gives
   * its `ResizablePanel` as `minSize`, so the release decision agrees with the
   * collapse the panel library performs on its own.
   */
  floor: number
  /** Where a drag *out of* the collapsed state lands — normally the last width. */
  expandTo: number
  /** Whether the panel was collapsed when the drag started. */
  wasCollapsed: boolean
  /** Magnet radius, in the caller's unit. Zero or omitted disables magnetism. */
  magnet?: number
}

export type PanelSnapResult =
  /** Shut the panel — to its rail width when one is persistent, else to zero. */
  | { kind: "collapsed" }
  /** Settle at this size, in the caller's unit. */
  | { kind: "size"; size: number }

function nearestPreset(size: number, presets: readonly number[], radius: number): number | null {
  let best: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const preset of presets) {
    if (!Number.isFinite(preset)) continue
    const distance = Math.abs(preset - size)
    if (distance <= radius && distance < bestDistance) {
      best = preset
      bestDistance = distance
    }
  }
  return best
}

/**
 * Decide where a dragged panel settles.
 *
 * @param value Where the pointer left it, in the caller's unit.
 */
export function snapPanelSize(value: number, options: PanelSnapOptions): PanelSnapResult {
  const { presets, floor, expandTo, wasCollapsed, magnet = 0 } = options

  // A drag that produced no usable number (jsdom, a layout callback before the
  // group has measured) must not be read as "the user dragged it to zero".
  if (!Number.isFinite(value)) {
    return wasCollapsed ? { kind: "collapsed" } : { kind: "size", size: expandTo }
  }

  if (value < floor) return { kind: "collapsed" }

  // Opening out of the rail always lands on the remembered width rather than
  // wherever the pointer happened to cross the threshold: the useful gesture is
  // "put it back", and a hair past the floor is never what the user meant. They
  // can still drag again from the now-open panel to pick any width.
  if (wasCollapsed) return { kind: "size", size: Math.max(expandTo, floor) }

  const preset = magnet > 0 ? nearestPreset(value, presets, magnet) : null
  return { kind: "size", size: preset ?? value }
}
