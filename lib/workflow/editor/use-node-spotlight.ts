"use client"

/**
 * Canvas-scoped node search: the rows, and what it means to go to one.
 *
 * Extracted from `SpotlightSearch` so the phone can reuse it. Two shells want
 * the same three things (a flattened haystack per node, the breadcrumb naming
 * the smallest group that contains it, and a reveal that centres, selects and
 * pulses) but not the same chrome: the desktop opens a `CommandDialog` on
 * Ctrl/Cmd+F and lets cmdk do the filtering, while a phone has no keyboard to
 * open it with and needs a bottom sheet it can scroll with a thumb.
 *
 * Query state deliberately stays with each shell. cmdk owns the desktop input
 * and its own matching, so a query held here would either be ignored there or
 * force the mobile sheet to mount cmdk purely to borrow its filter.
 */

import { useCallback, useMemo } from "react"
import { useShallow } from "zustand/react/shallow"

import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

/** The largest graph the search will scan. Matches the previous inline cap. */
const MAX_SCANNED_NODES = 200

/** Fallbacks for a node React Flow has not measured yet. */
const DEFAULT_NODE_WIDTH = 240
const DEFAULT_NODE_HEIGHT = 80

/** Fallbacks for a group whose params carry no explicit size. */
const DEFAULT_GROUP_WIDTH = 240
const DEFAULT_GROUP_HEIGHT = 160

export interface SpotlightRow {
  id: string
  label: string
  kind: WorkflowNodeKind
  /**
   * Everything a query may match, lowercased and joined: id, label, kind,
   * sticky-note text, notes, and the containing group's title. cmdk filters on
   * this same string, so the two shells cannot disagree about what matches.
   */
  value: string
  /** Title of the smallest group containing this node, or the empty string. */
  groupLabel: string
}

/** A row plus the geometry only `reveal` needs. */
interface PositionedRow extends SpotlightRow {
  position: { x: number; y: number }
  width: number
  height: number
}

/** The slice of the React Flow instance this needs, so either narrowed instance fits. */
export interface SpotlightViewport {
  setCenter: (x: number, y: number, options?: { zoom?: number; duration?: number }) => void
}

export interface UseNodeSpotlightOptions {
  store: EditorStore
  reactFlowInstance: SpotlightViewport | null
  /** When false, the viewport jump and the pulse skip animation entirely. */
  animationsEnabled: boolean
}

export interface NodeSpotlight {
  rows: SpotlightRow[]
  /** Case-insensitive substring match over `value`. An empty query keeps everything. */
  filterRows: (query: string) => SpotlightRow[]
  /** Centre the node, select it, and pulse it. */
  reveal: (nodeId: string) => void
}

/** Zoom the viewport settles at when a row is chosen. */
const REVEAL_ZOOM = 1.2
const REVEAL_DURATION_MS = 240
const PULSE_DURATION_MS = 3000

export function useNodeSpotlight({
  store,
  reactFlowInstance,
  animationsEnabled,
}: UseNodeSpotlightOptions): NodeSpotlight {
  const { nodes, setSelectedNodes, pulseNode } = store(
    useShallow((s: EditorState) => ({
      nodes: s.nodes,
      setSelectedNodes: s.setSelectedNodes,
      pulseNode: s.pulseNode,
    }))
  )

  // Group rects first, so every row can name the most specific group that
  // contains it. Smallest containing group wins, which is the resolution the
  // viewport breadcrumb already uses.
  const groupRects = useMemo(() => {
    return nodes
      .filter((n) => n.data.kind === "annotation.group")
      .map((n) => {
        const params =
          (n.data.params as { width?: number; height?: number; title?: string } | undefined) ?? {}
        return {
          id: n.id,
          title:
            typeof params.title === "string" && params.title.trim().length > 0 ? params.title : "",
          x: n.position.x,
          y: n.position.y,
          width:
            typeof params.width === "number" && params.width > 0
              ? params.width
              : DEFAULT_GROUP_WIDTH,
          height:
            typeof params.height === "number" && params.height > 0
              ? params.height
              : DEFAULT_GROUP_HEIGHT,
        }
      })
  }, [nodes])

  const positionedRows = useMemo<PositionedRow[]>(() => {
    return nodes.slice(0, MAX_SCANNED_NODES).map((n) => {
      const data = n.data
      const noteText =
        typeof (data.params as { text?: unknown } | undefined)?.text === "string"
          ? (data.params as { text: string }).text
          : ""
      const width = n.width ?? DEFAULT_NODE_WIDTH
      const height = n.height ?? DEFAULT_NODE_HEIGHT
      const cx = n.position.x + width / 2
      const cy = n.position.y + height / 2
      let containingGroup: { title: string } | null = null
      let smallestArea = Infinity
      for (const g of groupRects) {
        if (g.id === n.id) continue
        if (cx < g.x || cx > g.x + g.width || cy < g.y || cy > g.y + g.height) continue
        const area = g.width * g.height
        if (area < smallestArea) {
          smallestArea = area
          containingGroup = { title: g.title }
        }
      }
      const groupLabel = containingGroup?.title ?? ""
      return {
        id: n.id,
        label: data.label,
        kind: data.kind,
        value: [n.id, data.label, data.kind, noteText, data.notes ?? "", groupLabel]
          .join(" ")
          .toLowerCase(),
        position: n.position,
        width,
        height,
        groupLabel,
      }
    })
  }, [nodes, groupRects])

  const filterRows = useCallback(
    (query: string) => {
      const normalized = query.trim().toLowerCase()
      return normalized
        ? positionedRows.filter((row) => row.value.includes(normalized))
        : positionedRows
    },
    [positionedRows]
  )

  const reveal = useCallback(
    (nodeId: string) => {
      const row = positionedRows.find((candidate) => candidate.id === nodeId)
      if (!row) return
      if (reactFlowInstance) {
        // `setCenter` centres the point within the React Flow PANE, which it
        // measures itself. Hand-rolling the offset from `window.innerWidth / 2`
        // is wrong on desktop, where the palette and the right rail make the
        // pane narrower than the window, and wrong on a phone in a drawer.
        reactFlowInstance.setCenter(
          row.position.x + row.width / 2,
          row.position.y + row.height / 2,
          { zoom: REVEAL_ZOOM, duration: animationsEnabled ? REVEAL_DURATION_MS : 0 }
        )
      }
      setSelectedNodes([nodeId])
      pulseNode(nodeId, animationsEnabled ? PULSE_DURATION_MS : 0)
    },
    [animationsEnabled, positionedRows, pulseNode, reactFlowInstance, setSelectedNodes]
  )

  return { rows: positionedRows, filterRows, reveal }
}
