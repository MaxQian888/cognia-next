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
  /** Per-node colour function used when not degraded. */
  nodeColor: (n: MinimapNode) => string
  className?: string
}

function flatColor(): string {
  return PERF_MINIMAP_FLAT_COLOR
}

function PerfMiniMapInner({ degraded, nodeColor, className }: PerfMiniMapProps) {
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

  return <MiniMap position="bottom-right" {...(props as React.ComponentProps<typeof MiniMap>)} />
}

export const PerfMiniMap = memo(PerfMiniMapInner)
