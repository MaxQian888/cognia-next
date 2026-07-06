/**
 * Shared mouse handling for bordered row-list overlays (the `/agents`, `/mcp`,
 * `/skills`, `/agents models` panels and every {@link SelectList}-based modal).
 *
 * These overlays render a fixed vertical layout — a round border, optional
 * header rows, an optional "↑ N more" indicator, then exactly one terminal row
 * per visible item — so a click maps to an item by plain arithmetic (see
 * {@link rowAtClick}). Each overlay used to re-implement the same dance
 * (`parseMouseEvent` → `absoluteTopLeft` → `rowAtClick`); this hook factors it
 * into one place so adding clicks to a panel is a two-line change.
 *
 * Mouse reports only reach an overlay in the fullscreen `scroll` mouse mode
 * (SGR tracking on); in every other mode the handler simply never fires and the
 * panel stays keyboard-only. The returned handler is meant to run FIRST inside
 * the host's `useInput`: `if (handleMouse(input)) return`. It returns true for
 * ANY mouse report (so the caller swallows the SGR sequence instead of treating
 * it as literal text) and false only when the input is not a mouse event.
 */
import type { DOMElement } from "ink"
import type { RefObject } from "react"

import { parseMouseEvent } from "./mouse"
import { absoluteTopLeft } from "./element-position"
import { rowAtClick } from "./panel-click"

export interface UsePanelClickArgs {
  /** Ref to the panel's bordered root Box (for {@link absoluteTopLeft}). */
  boxRef: RefObject<DOMElement | null>
  /** Rows the header occupies before the first item (title, "filter:" line…). */
  headerRows: number
  /** Whether the "↑ N more" indicator row is currently shown above the items. */
  hasAboveMore: boolean
  /** Number of item rows currently rendered in the visible window. */
  visibleCount: number
  /** Rows the box border reserves above the header (round/single = 1). */
  borderRows?: number
  /** Called with the 0-based offset WITHIN the visible window of a clicked item. */
  onPick: (windowOffset: number) => void
  /** Called on a wheel notch; omit to ignore the wheel. */
  onWheel?: (dir: "up" | "down") => void
  /** Override the layout reader (jsdom has no Yoga → defaults to null). Test seam. */
  resolvePos?: (node: DOMElement | null) => { top: number; left: number } | null
}

/**
 * Build the mouse handler for a row-list overlay. The returned function takes
 * the raw `input` string Ink hands to `useInput` and returns true when it was a
 * mouse report (handled or deliberately swallowed), false otherwise.
 */
export function usePanelClick({
  boxRef,
  headerRows,
  hasAboveMore,
  visibleCount,
  borderRows = 1,
  onPick,
  onWheel,
  resolvePos = absoluteTopLeft,
}: UsePanelClickArgs): (input: string) => boolean {
  return (input: string): boolean => {
    const mouse = parseMouseEvent(input)
    if (!mouse) return false
    if (mouse.kind === "wheel") {
      onWheel?.(mouse.dir)
      return true
    }
    if (mouse.kind === "click") {
      const pos = resolvePos(boxRef.current)
      if (!pos) return true
      const offset = rowAtClick({
        clickRow: mouse.row - 1,
        panelTop: pos.top,
        headerRows,
        hasAboveMore,
        visibleCount,
        borderRows,
      })
      if (offset !== null) onPick(offset)
    }
    // Drags / releases / off-band clicks: swallow without acting.
    return true
  }
}
