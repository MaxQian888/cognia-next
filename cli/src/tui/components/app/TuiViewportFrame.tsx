import React from "react"
import { Box, type DOMElement } from "ink"

export interface TuiViewportFrameProps {
  columns: number
  rows: number
  fullscreen: boolean
  overlayOpen: boolean
  /**
   * Whether the open overlay replaces the transcript or docks under it.
   *
   * Defaults to `overlayOpen` — the historic behaviour, where every overlay
   * took the screen. See `state/overlay-layout`: a prompt the TURN raised is
   * read against the conversation above it, so blanking that conversation left
   * an approval box alone on an empty screen with nothing to judge it by.
   */
  overlayTakesScreen?: boolean
  transcript: React.ReactNode
  overlays: React.ReactNode
  bottom: React.ReactNode
  overlayRegionRef?: React.Ref<DOMElement>
}

/** The production Yoga frame: one growing/clipped region above one fixed bottom region. */
export function TuiViewportFrame({
  columns,
  rows,
  fullscreen,
  overlayOpen,
  overlayTakesScreen,
  transcript,
  overlays,
  bottom,
  overlayRegionRef,
}: TuiViewportFrameProps): React.ReactElement {
  const takesScreen = fullscreen && (overlayTakesScreen ?? overlayOpen)
  return (
    <Box flexDirection="column" width={columns} {...(fullscreen ? { height: rows } : {})}>
      {/* The transcript keeps its `flexGrow` viewport and simply gets shorter
          when a prompt docks below it — the same way the composer popup already
          shares the column. */}
      {!takesScreen ? transcript : null}
      {takesScreen ? (
        <Box
          ref={overlayRegionRef}
          data-testid="fullscreen-overlay-region"
          flexDirection="column"
          flexGrow={1}
          overflow="hidden"
        >
          {overlays}
        </Box>
      ) : (
        overlays
      )}
      {bottom}
    </Box>
  )
}
