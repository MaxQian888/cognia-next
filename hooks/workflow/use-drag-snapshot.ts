"use client"

/**
 * Drag-start peer snapshot for the workflow editor.
 *
 * The canvas captures a `Map<id, RectLike>` of every other node on
 * `onNodeDragStart`. `handleNodeDrag` reads the snapshot via the ref (O(1)
 * lookups), so the per-pointer-move loop is dominated by the unavoidable
 * `computeAlignmentGuides` work instead of an O(n²) `nodes.map(...)` +
 * `nodes.find(...)` rebuild every frame.
 *
 * The hook is intentionally stateless from React's perspective — the
 * snapshot lives in a `useRef`. Consumers read via `snapshot.current`,
 * which is `null` outside an active drag.
 */

import { useCallback, useRef, type MutableRefObject } from "react"
import type { RectLike } from "@/lib/workflow/editor/alignment-guides"

/** Defaults that match the unified `WorkflowNodeComponent` styling. */
export const DEFAULT_NODE_WIDTH = 240
export const DEFAULT_NODE_HEIGHT = 80

export interface DragSnapshotSourceNode {
  id: string
  position: { x: number; y: number }
  width?: number | null
  height?: number | null
  measured?: { width?: number; height?: number } | null
}

export interface DragSnapshotHandle {
  snapshot: MutableRefObject<Map<string, RectLike> | null>
  capture: (nodes: ReadonlyArray<DragSnapshotSourceNode>, excludeId?: string) => void
  release: () => void
}

function pickWidth(n: DragSnapshotSourceNode): number {
  return n.measured?.width ?? n.width ?? DEFAULT_NODE_WIDTH
}

function pickHeight(n: DragSnapshotSourceNode): number {
  return n.measured?.height ?? n.height ?? DEFAULT_NODE_HEIGHT
}

export function useDragSnapshot(): DragSnapshotHandle {
  const snapshot = useRef<Map<string, RectLike> | null>(null)

  const capture = useCallback(
    (nodes: ReadonlyArray<DragSnapshotSourceNode>, excludeId?: string) => {
      const map = new Map<string, RectLike>()
      for (const n of nodes) {
        if (excludeId !== undefined && n.id === excludeId) continue
        map.set(n.id, {
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          width: pickWidth(n),
          height: pickHeight(n),
        })
      }
      snapshot.current = map
    },
    []
  )

  const release = useCallback(() => {
    snapshot.current = null
  }, [])

  return { snapshot, capture, release }
}
