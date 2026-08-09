import React from "react"
import { Box, type DOMElement } from "ink"

export interface TuiViewportFrameProps {
  columns: number
  rows: number
  fullscreen: boolean
  overlayOpen: boolean
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
  transcript,
  overlays,
  bottom,
  overlayRegionRef,
}: TuiViewportFrameProps): React.ReactElement {
  return (
    <Box flexDirection="column" width={columns} {...(fullscreen ? { height: rows } : {})}>
      {!(fullscreen && overlayOpen) ? transcript : null}
      {fullscreen && overlayOpen ? (
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
