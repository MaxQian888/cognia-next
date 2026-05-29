"use client"

/**
 * SVG overlay that renders dashed alignment guides while the user drags a
 * node. Guide computation lives in `lib/workflow/editor/alignment-guides`
 * (pure, tested separately); this component only handles the React Flow
 * coord-system → screen projection and the visual treatment.
 *
 * The overlay mounts inside the React Flow viewport via `<ViewportPortal>`
 * so guides pan / zoom with the canvas instead of floating in screen space.
 */

import { memo } from "react"
import { ViewportPortal } from "@xyflow/react"
import type {
  GuidesResult,
  HorizontalGuide,
  VerticalGuide,
} from "@/lib/workflow/editor/alignment-guides"

const GUIDE_STROKE = "stroke-primary/70"
const GUIDE_DASH = "4 3"
const GUIDE_WIDTH = 1

function VerticalGuideLine({ guide }: { guide: VerticalGuide }) {
  return (
    <line
      x1={guide.x}
      x2={guide.x}
      y1={guide.yStart - 8}
      y2={guide.yEnd + 8}
      strokeDasharray={GUIDE_DASH}
      strokeWidth={GUIDE_WIDTH}
      className={GUIDE_STROKE}
      data-testid={`alignment-guide-v-${guide.source}`}
    />
  )
}

function HorizontalGuideLine({ guide }: { guide: HorizontalGuide }) {
  return (
    <line
      x1={guide.xStart - 8}
      x2={guide.xEnd + 8}
      y1={guide.y}
      y2={guide.y}
      strokeDasharray={GUIDE_DASH}
      strokeWidth={GUIDE_WIDTH}
      className={GUIDE_STROKE}
      data-testid={`alignment-guide-h-${guide.source}`}
    />
  )
}

export interface AlignmentOverlayProps {
  guides: GuidesResult | null
}

export const AlignmentOverlay = memo(function AlignmentOverlay({ guides }: AlignmentOverlayProps) {
  if (!guides) return null
  if (guides.vertical.length === 0 && guides.horizontal.length === 0) return null
  return (
    <ViewportPortal>
      <svg
        // Span a generously large rect so guides extend beyond the immediate
        // dragged-vs-peer pair. The viewport portal already clips to the
        // visible viewport for us.
        style={{
          position: "absolute",
          left: -10_000,
          top: -10_000,
          width: 20_000,
          height: 20_000,
          pointerEvents: "none",
          overflow: "visible",
        }}
        data-testid="alignment-overlay"
      >
        <g transform="translate(10000 10000)">
          {guides.vertical.map((g, i) => (
            <VerticalGuideLine key={`v-${i}-${g.peerId}`} guide={g} />
          ))}
          {guides.horizontal.map((g, i) => (
            <HorizontalGuideLine key={`h-${i}-${g.peerId}`} guide={g} />
          ))}
        </g>
      </svg>
    </ViewportPortal>
  )
})
