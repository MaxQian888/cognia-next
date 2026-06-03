"use client"

/**
 * Alt+drag free-form lasso selection.
 *
 * Rendered as a sibling of `<ReactFlow>`. While inactive the overlay is
 * `pointer-events: none` and renders nothing — pointer events flow through
 * to React Flow's pane. The canvas binds `pointerdown` at the wrapper level
 * and, when `e.altKey === true` on a pane pointerdown, transfers control to
 * the overlay by setting `active=true`. From there, pointermove / pointerup
 * are tracked at the window level so the user can drag outside the bounds.
 *
 * The overlay paints the polygon as an SVG path inside React Flow's
 * `<ViewportPortal>` so the line follows pan/zoom naturally.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react"
import { ViewportPortal, type ReactFlowInstance } from "@xyflow/react"
import { useTranslations } from "next-intl"
import type { EditorStore } from "@/lib/workflow/editor/store"
import { nodeIdsInPolygon, type Point } from "@/lib/workflow/editor/lasso"
import { useRafThrottle } from "@/hooks/workflow/use-raf-throttle"

export interface LassoOverlayProps {
  /** Reference to the canvas wrapper that intercepts pointer events. */
  containerRef: React.RefObject<HTMLDivElement | null>
  reactFlowInstance: ReactFlowInstance | null
  store: EditorStore
  /** When false, the overlay is permanently inactive. */
  enabled: boolean
}

export const LassoOverlay = memo(function LassoOverlay({
  containerRef,
  reactFlowInstance,
  store,
  enabled,
}: LassoOverlayProps) {
  const t = useTranslations("workflows.editor.lasso")
  // The graph + selection action are read via `getState()` at pointer-up
  // instead of subscribed, so the overlay does NOT re-render on every node
  // drag frame (it has nothing to show until an Alt+drag lasso starts).

  const [polygon, setPolygon] = useState<Point[]>([])
  const [statusPos, setStatusPos] = useState<{ x: number; y: number } | null>(null)
  const activeRef = useRef(false)

  const pushPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!reactFlowInstance) return
      const flow = reactFlowInstance.screenToFlowPosition({ x: clientX, y: clientY })
      setPolygon((prev) => [...prev, flow])
      setStatusPos({ x: clientX, y: clientY })
    },
    [reactFlowInstance]
  )
  const pushThrottled = useRafThrottle<[number, number]>((x, y) => {
    pushPoint(x, y)
  })

  useEffect(() => {
    if (!enabled) return
    const container = containerRef.current
    if (!container) return

    function startsOnPane(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      // React Flow's pane is the element with class `react-flow__pane`.
      // Allow start on the pane or directly on the canvas wrapper itself.
      return (
        target.classList.contains("react-flow__pane") ||
        target.classList.contains("react-flow__viewport") ||
        target === container
      )
    }

    function onPointerDown(e: PointerEvent) {
      if (!e.altKey) return
      if (e.button !== 0) return
      if (!startsOnPane(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      activeRef.current = true
      setPolygon([])
      pushPoint(e.clientX, e.clientY)
    }
    function onPointerMove(e: PointerEvent) {
      if (!activeRef.current) return
      e.preventDefault()
      pushThrottled.call(e.clientX, e.clientY)
    }
    function onPointerUp(e: PointerEvent) {
      if (!activeRef.current) return
      activeRef.current = false
      pushThrottled.flush()
      const finalPoly = polygonRef.current
      if (finalPoly.length >= 3) {
        const ids = nodeIdsInPolygon(
          store.getState().nodes.map((n) => ({
            id: n.id,
            position: n.position,
            width: n.width ?? undefined,
            height: n.height ?? undefined,
          })),
          finalPoly
        )
        store.getState().setSelectedNodes(ids)
      }
      setPolygon([])
      setStatusPos(null)
      e.preventDefault()
    }

    container.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("pointermove", onPointerMove, true)
    window.addEventListener("pointerup", onPointerUp, true)
    return () => {
      container.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("pointermove", onPointerMove, true)
      window.removeEventListener("pointerup", onPointerUp, true)
    }
  }, [containerRef, enabled, pushPoint, pushThrottled, reactFlowInstance, store])

  // Keep an always-current polygon ref so the pointerup handler doesn't
  // close over stale state inside the effect's identity.
  const polygonRef = useRef<Point[]>([])
  useEffect(() => {
    polygonRef.current = polygon
  }, [polygon])

  if (!enabled) return null
  const showOverlay = polygon.length > 1

  return (
    <>
      {showOverlay ? (
        <ViewportPortal>
          <svg
            data-testid="lasso-overlay"
            style={{
              position: "absolute",
              overflow: "visible",
              pointerEvents: "none",
              left: 0,
              top: 0,
              width: 0,
              height: 0,
            }}
          >
            <polygon
              points={polygon.map((p) => `${p.x},${p.y}`).join(" ")}
              className="fill-primary/10 stroke-primary"
              strokeWidth={1}
              strokeDasharray="6 4"
            />
          </svg>
        </ViewportPortal>
      ) : null}
      {statusPos ? (
        <div
          className="fixed pointer-events-none rounded-md border bg-background/95 px-2 py-1 text-xs shadow"
          style={{ left: statusPos.x + 12, top: statusPos.y + 12, zIndex: 60 }}
          data-testid="lasso-status"
        >
          {t("selected", { count: polygon.length })}
        </div>
      ) : null}
    </>
  )
})
