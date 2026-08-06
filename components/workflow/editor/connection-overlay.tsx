"use client"

/**
 * Flowith-style "drag silk" preview while the user is drawing an edge from
 * a source handle.
 *
 * Architecture:
 *   • `<ConnectionLineGhost>` is passed to React Flow's
 *     `connectionLineComponent` prop. It draws the in-flight line; if the
 *     store's `connectionState.candidate` is set we re-target the line tip
 *     to the candidate handle's flow position with primary stroke.
 *   • `<ConnectionPointerListener>` is a side-effect-only component that
 *     mounts a global `pointermove` listener while a connection is in
 *     flight, computes the nearest compatible candidate handle, and pushes
 *     it through the store.
 *
 * The candidate search is throttled with `useRafThrottle` so a fast-moving
 * pointer doesn't spawn O(n × handles) work per pixel.
 */

import { memo, useEffect, useMemo } from "react"
import { useReactFlow, type ConnectionLineComponentProps } from "@xyflow/react"
import { useShallow } from "zustand/react/shallow"
import type { ConnectionCandidate, EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { validateConnection } from "@/lib/workflow/editor/connection-validator"
import { useRafThrottle } from "@/hooks/workflow/use-raf-throttle"
import { Connection } from "@/components/ai-elements/connection"

const SNAP_DISTANCE_SCREEN = 32

interface HandlePosition {
  nodeId: string
  handleId: string | null
  /** Flow-space coordinate of the handle's centre. */
  position: { x: number; y: number }
}

/**
 * Build the set of candidate target handles for the active source. For the
 * single-default-handle workflow nodes this is one handle per non-trigger,
 * non-annotation node — we infer the handle position from the node's rect
 * (left edge centre for the input handle), matching the rendering in
 * `WorkflowNodeComponent`.
 */
function collectTargetHandles(
  nodes: ReadonlyArray<{
    id: string
    position: { x: number; y: number }
    width?: number | null
    height?: number | null
    data?: { kind?: string }
  }>,
  sourceId: string
): HandlePosition[] {
  const out: HandlePosition[] = []
  for (const n of nodes) {
    if (n.id === sourceId) continue
    const kind = n.data?.kind ?? ""
    if (kind.startsWith("trigger.")) continue
    if (kind === "annotation.note") continue
    const w = n.width ?? 240
    const h = n.height ?? 80
    out.push({
      nodeId: n.id,
      handleId: null,
      position: { x: n.position.x, y: n.position.y + h / 2 },
    })
    // Width currently unused (handle sits on the left edge); reference to
    // silence the unused-var lint.
    void w
  }
  return out
}

export interface ConnectionPointerListenerProps {
  store: EditorStore
}

/**
 * Tracks pointermove while `connectionState !== null` and writes the
 * nearest compatible candidate handle to the store.
 */
export const ConnectionPointerListener = memo(function ConnectionPointerListener({
  store,
}: ConnectionPointerListenerProps) {
  const rf = useReactFlow()
  // Subscribe ONLY to the connection's stable identity (source id + handle),
  // NOT to `connectionState` (which this component itself rewrites every frame
  // via `updateConnectionPointer`) and NOT to `nodes`/`edges` (which churn on
  // every node-drag frame). Reading those reactively forced a re-render of this
  // listener on every drag tick; the graph is instead read on demand through
  // `store.getState()`.
  const { sourceId, sourceHandle, updateConnectionPointer } = store(
    useShallow((s: EditorState) => ({
      sourceId: s.connectionState?.sourceId ?? null,
      sourceHandle: s.connectionState?.sourceHandle ?? null,
      updateConnectionPointer: s.updateConnectionPointer,
    }))
  )

  // The set of valid target handles cannot change while a single connection is
  // being drawn (nodes don't move, edges don't change), so compute it ONCE per
  // connection instead of re-running `collectTargetHandles` + an O(n)
  // `validateConnection` pass on every pointer move.
  const validCandidates = useMemo<HandlePosition[]>(() => {
    if (!sourceId) return []
    const s = store.getState()
    return collectTargetHandles(s.nodes, sourceId).filter(
      (c) =>
        validateConnection(
          { source: sourceId, target: c.nodeId, sourceHandle, targetHandle: c.handleId },
          s.nodes,
          s.edges
        ).valid
    )
  }, [store, sourceId, sourceHandle])

  // Only the cheap nearest-candidate scan runs per frame — and it runs INSIDE
  // the rAF coalescer, so a fast pointer that fires many `pointermove` events
  // per frame does the work at most once. (Previously the expensive scan ran
  // on every raw event and only the store write was throttled.)
  const throttled = useRafThrottle<[{ x: number; y: number }]>((flow) => {
    const zoom = rf.getViewport().zoom || 1
    const snapDistanceFlow = SNAP_DISTANCE_SCREEN / zoom
    let best: { candidate: HandlePosition; distance: number } | null = null
    for (const c of validCandidates) {
      const distance = Math.hypot(c.position.x - flow.x, c.position.y - flow.y)
      if (distance < snapDistanceFlow && (best === null || distance < best.distance)) {
        best = { candidate: c, distance }
      }
    }
    const next: ConnectionCandidate | null = best
      ? {
          nodeId: best.candidate.nodeId,
          handleId: best.candidate.handleId,
          distance: best.distance,
        }
      : null
    updateConnectionPointer(flow, next)
  })

  useEffect(() => {
    if (!sourceId) return
    const handler = (e: PointerEvent) => {
      throttled.call(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
    }
    window.addEventListener("pointermove", handler, true)
    return () => {
      throttled.cancel()
      window.removeEventListener("pointermove", handler, true)
    }
  }, [sourceId, rf, throttled])

  return null
})

/**
 * Custom connection-line component passed to React Flow via
 * `connectionLineComponent`. Renders the in-flight edge tip; when the store
 * has a candidate, the line snaps to its flow position with primary stroke.
 */
export function ConnectionLineGhostFactory(store: EditorStore) {
  const Ghost = memo(function ConnectionLineGhost(props: ConnectionLineComponentProps) {
    const { toX, toY } = props
    const candidate = store((s: EditorState) => s.connectionState?.candidate ?? null)
    const animationsEnabled = store((s: EditorState) => {
      // Mirror the workflow-node tier check so we don't import the resolver
      // for a single boolean. `auto` resolves at render-time via matchMedia
      // and node count, but for the ghost line we treat reduced-motion at
      // OS level as the dominant signal.
      if (s.performanceTier === "reduced") return false
      if (
        s.performanceTier === "auto" &&
        typeof window !== "undefined" &&
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        return false
      }
      return true
    })

    const cs = store((s: EditorState) => s.connectionState)
    const nodes = store((s: EditorState) => s.nodes)
    let endX = toX
    let endY = toY
    if (candidate && cs) {
      const target = nodes.find((n) => n.id === candidate.nodeId)
      if (target) {
        const h = target.height ?? 80
        endX = target.position.x
        endY = target.position.y + h / 2
      }
    }
    const stroke = candidate ? "oklch(var(--primary))" : "currentColor"
    return (
      <g data-testid="connection-line-ghost" data-candidate={candidate ? candidate.nodeId : ""}>
        <Connection
          {...props}
          toX={endX}
          toY={endY}
          stroke={stroke}
          strokeOpacity={candidate ? 0.7 : 0.35}
          strokeDasharray={animationsEnabled ? "4 3" : undefined}
        />
      </g>
    )
  })
  return Ghost
}
