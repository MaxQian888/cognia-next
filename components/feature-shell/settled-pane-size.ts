/**
 * Report a resizable pane's width once a resize settles (ADR-0223's Files
 * sidebar remembers its width). `react-resizable-panels` calls `onResize` on
 * every frame of a drag and once on mount; this keeps the last width a person
 * dragged to and hands it over when the group says the layout changed.
 */

import { useRef } from "react"
import type { PanelSize } from "react-resizable-panels"

export interface SettledPaneSize {
  onResize: (
    size: PanelSize,
    id: string | number | undefined,
    previous: PanelSize | undefined
  ) => void
  /** Call from the group's `onLayoutChanged`. */
  flush: () => void
}

export function useSettledPaneSize(
  onSizeChange: ((px: number) => void) | undefined
): SettledPaneSize {
  const pending = useRef<number | null>(null)
  return {
    onResize: (size, _id, previous) => {
      // The call without a previous size is the mount, not a person resizing.
      if (previous) pending.current = size.inPixels
    },
    flush: () => {
      const px = pending.current
      pending.current = null
      if (onSizeChange && px !== null && px > 0) onSizeChange(px)
    },
  }
}
