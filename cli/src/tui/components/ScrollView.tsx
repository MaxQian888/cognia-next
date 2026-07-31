/**
 * The fullscreen layout's scrollable middle pane.
 *
 * Ink writes the whole live frame each render (no `<Static>` in fullscreen), so
 * the transcript can't lean on native scrollback. Instead we clip it to a
 * fixed-height viewport and shift the content up by a negative top margin — the
 * same trick a pager uses. `flexGrow` lets the viewport claim whatever height is
 * left between the fixed banner and the fixed composer; `overflow="hidden"`
 * clips the overflow; `flexShrink={0}` on the inner box keeps the content at its
 * natural height so it actually overflows (and can be measured) instead of being
 * squeezed to fit.
 *
 * After every render we measure both boxes and hand the heights back via
 * `onMeasure`, which the scroll controller uses to clamp the offset and keep the
 * view pinned to the bottom. Measurement degrades gracefully to 0 (render
 * everything, no clip) when a ref isn't laid out yet — e.g. under the jsdom test
 * mock where there is no real Yoga layout.
 */
import React, { useEffect, useRef } from "react"
import { Box, measureElement, type DOMElement } from "ink"

/** Measured row-height of an Ink node, or 0 when it isn't laid out yet (no ref
 * on the first commit, or the jsdom test mock with no real Yoga layout). */
export function measuredHeight(el: DOMElement | null): number {
  return el ? measureElement(el).height : 0
}

export function ScrollView({
  offset,
  onMeasure,
  contentRef: externalContentRef,
  children,
}: {
  /** Rows to hide above the viewport (from the scroll controller). */
  offset: number
  /** Reports measured `(contentHeight, viewportHeight)` after layout. */
  onMeasure: (contentHeight: number, viewportHeight: number) => void
  /** Optional forward of the inner content box (whose `marginTop={-offset}`
   * already encodes the scroll position) so the App can read its absolute top
   * and map a click row to a transcript cell. */
  contentRef?: React.MutableRefObject<DOMElement | null>
  children: React.ReactNode
}) {
  const viewportRef = useRef<DOMElement | null>(null)
  const contentRef = useRef<DOMElement | null>(null)

  // Set both the internal ref (for measurement) and the optional external one
  // (for the App's click hit-test) from the single Box node.
  const setContent = (node: DOMElement | null) => {
    contentRef.current = node
    if (externalContentRef) externalContentRef.current = node
  }

  // Runs after every render (no deps): re-measure so streamed output and window
  // resizes keep the offset accurate. `onMeasure` ignores unchanged values, so
  // this converges rather than looping.
  useEffect(() => {
    onMeasure(measuredHeight(contentRef.current), measuredHeight(viewportRef.current))
  })

  return (
    <Box ref={viewportRef} flexGrow={1} flexDirection="column" overflow="hidden">
      <Box ref={setContent} flexDirection="column" flexShrink={0} marginTop={-offset}>
        {children}
      </Box>
    </Box>
  )
}
