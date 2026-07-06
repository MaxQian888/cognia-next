/**
 * Scroll support for tall modal overlays whose content is rich Ink layout
 * (gauges, sparklines, sectioned rows) rather than a flat line array.
 *
 * `DocumentViewer` pages a *line array* via `document-view`; `DoctorPanel` pages
 * a *flat item list* via windowing. Neither fits panels like `/usage` and
 * `/limits`, whose height is whatever their Ink subtree measures. So this reuses
 * the same measured-clip idiom as the fullscreen {@link ScrollView}: clip the
 * content to a fixed-height box and shift it up by a negative top margin, with
 * the offset math delegated to the pure `scroll-view-state` module.
 *
 * Panels open at the TOP (not pinned to the bottom like the transcript), and
 * {@link panelKeyAction} keeps the key→intent mapping pure and unit-testable.
 */
import React from "react"
import { Box, measureElement, type DOMElement, type Key } from "ink"

import {
  effectiveTop,
  hiddenRows,
  scrollByLines,
  scrollPage,
  type ScrollIntent,
} from "../components/scroll-view-state"

/** Panels start scrolled to the top and do not follow new output. */
const PANEL_INITIAL: ScrollIntent = { top: 0, stick: false }

/** Rows a bordered overlay reserves for its border + title + footer chrome. */
export const PANEL_CHROME_ROWS = 6

/**
 * Footer line for a scrollable panel: the hidden-rows indicator + scroll/close
 * keys when content overflows, or just the close hint when it all fits. Pure.
 */
export function panelFooterHint(hidden: { above: number; below: number }): string {
  if (hidden.above + hidden.below > 0) {
    return `↑ ${hidden.above} ↓ ${hidden.below} · PgUp/PgDn scroll · esc close`
  }
  return "esc to close"
}

/** A scroll command derived purely from a keypress. */
export type PanelKeyAction = "lineUp" | "lineDown" | "pageUp" | "pageDown" | null

/**
 * Map a keypress to a scroll command (pure). Returns `null` for keys the panel
 * should handle itself (e.g. Esc/Enter to close). Space/`b` page like `less`.
 */
export function panelKeyAction(input: string, key: Key): PanelKeyAction {
  if (key.upArrow) return "lineUp"
  if (key.downArrow) return "lineDown"
  if (key.pageUp || input === "b") return "pageUp"
  if (key.pageDown || input === " ") return "pageDown"
  return null
}

export interface PanelScroll {
  /** Rows hidden above the viewport (the negative top margin to apply). */
  offset: number
  /** Rows hidden above / below — drives the "↑ N more / ↓ N more" indicator. */
  hidden: { above: number; below: number }
  /** Feed the measured content height (called by {@link PanelViewport}). */
  measure: (contentHeight: number) => void
  /** Handle a key; returns true when it scrolled (so the caller won't close). */
  onKey: (input: string, key: Key) => boolean
}

/**
 * Scroll controller for a bounded overlay viewport `viewportRows` tall.
 * `viewportRows` is supplied by the caller (terminal height minus chrome) so the
 * hook stays free of `stdout` and is trivially testable.
 *
 * `initial` overrides the starting intent: a live-transcript panel passes
 * `{ top: 0, stick: true }` to follow the tail as content grows (scrolling up
 * disengages the pin; scrolling back to the bottom re-engages it — the same
 * rules `scroll-view-state` gives the fullscreen transcript).
 */
export function usePanelScroll(
  viewportRows: number,
  initial: ScrollIntent = PANEL_INITIAL
): PanelScroll {
  const [intent, setIntent] = React.useState<ScrollIntent>(initial)
  const [content, setContent] = React.useState(0)

  const measure = React.useCallback((contentHeight: number) => {
    setContent((prev) => (prev === contentHeight ? prev : contentHeight))
  }, [])

  const onKey = React.useCallback(
    (input: string, key: Key): boolean => {
      const action = panelKeyAction(input, key)
      if (action === null) return false
      setIntent((i) => {
        switch (action) {
          case "lineUp":
            return scrollByLines(i, -1, content, viewportRows)
          case "lineDown":
            return scrollByLines(i, 1, content, viewportRows)
          case "pageUp":
            return scrollPage(i, "up", content, viewportRows)
          case "pageDown":
            return scrollPage(i, "down", content, viewportRows)
        }
      })
      return true
    },
    [content, viewportRows]
  )

  // The effective offset respects `stick` (pin to bottom) when engaged; for the
  // default non-sticking intent it is just the clamped raw offset, as before.
  const offset = effectiveTop(intent, content, viewportRows)
  return {
    offset,
    hidden: hiddenRows(intent, content, viewportRows),
    measure,
    onKey,
  }
}

/**
 * Clips `children` to `viewportRows` and shifts them up by `scroll.offset`,
 * re-measuring after every render (degrades to 0 — render everything — when a
 * ref isn't laid out yet, e.g. the jsdom test mock). The same flex recipe the
 * fullscreen {@link ScrollView} uses.
 */
export function PanelViewport({
  viewportRows,
  scroll,
  children,
}: {
  viewportRows: number
  scroll: PanelScroll
  children: React.ReactNode
}) {
  const contentRef = React.useRef<DOMElement | null>(null)
  React.useEffect(() => {
    scroll.measure(contentRef.current ? measureElement(contentRef.current).height : 0)
  })
  return (
    <Box height={viewportRows} flexDirection="column" overflow="hidden">
      <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={-scroll.offset}>
        {children}
      </Box>
    </Box>
  )
}
