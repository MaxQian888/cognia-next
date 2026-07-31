"use client"

/**
 * Memoized minimap wrapper that swaps to a degraded prop set while a node is
 * being dragged (or when the resolved performance tier is `balanced`).
 *
 * Degraded mode:
 *   - `pannable={false} zoomable={false}` — strips pointer + wheel listeners.
 *   - `nodeColor` returns a flat slate-400 so React Flow's MiniMap doesn't
 *     branch per node kind on every paint.
 *
 * Props are folded through a single `useMemo` so React Flow's MiniMap
 * doesn't see a new identity each render. The outer `React.memo` skips
 * re-renders when neither flag nor color callback changes.
 */

import { memo, useMemo } from "react"
import { MiniMap } from "@xyflow/react"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

export const PERF_MINIMAP_FLAT_COLOR = "#94a3b8"

type MinimapNode = { data?: { kind?: WorkflowNodeKind } }

export interface PerfMiniMapProps {
  /** Drop listeners + flat colours while true. */
  degraded: boolean
  /**
   * Freeze into a static placeholder (no React Flow `<MiniMap>` mounted) while
   * true. React Flow's MiniMap re-reads every node's position and repaints its
   * SVG on each store change, so during a node drag it repaints ~60×/s even in
   * `degraded` mode (the flat-colour swap only removes per-node colour work,
   * not the redraw). Swapping to a non-subscribing placeholder drops that
   * per-frame paint entirely; the live minimap returns — and repaints once —
   * when the gesture ends. The placeholder keeps the bottom-right corner
   * occupied at the default minimap footprint so nothing visibly jumps.
   */
  frozen?: boolean
  /** Per-node colour function used when not degraded. */
  nodeColor: (n: MinimapNode) => string
  className?: string
}

function flatColor(): string {
  return PERF_MINIMAP_FLAT_COLOR
}

// React Flow's default minimap footprint + panel offset, mirrored so the
// frozen placeholder sits exactly where the live minimap does.
const FROZEN_PLACEHOLDER_STYLE: React.CSSProperties = {
  position: "absolute",
  bottom: 15,
  right: 15,
  width: 200,
  height: 150,
}

function PerfMiniMapInner({ degraded, frozen, nodeColor, className }: PerfMiniMapProps) {
  const props = useMemo(() => {
    if (degraded) {
      return {
        pannable: false,
        zoomable: false,
        nodeColor: flatColor,
        className,
      }
    }
    return {
      pannable: true,
      zoomable: true,
      nodeColor,
      className,
    }
  }, [degraded, nodeColor, className])

  if (frozen) {
    return (
      <div
        aria-hidden="true"
        data-testid="minimap-frozen"
        className={className}
        style={FROZEN_PLACEHOLDER_STYLE}
      />
    )
  }

  return <MiniMap position="bottom-right" {...(props as React.ComponentProps<typeof MiniMap>)} />
}

export const PerfMiniMap = memo(PerfMiniMapInner)
