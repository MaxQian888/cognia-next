"use client"

/**
 * Top-left floating navigation in the workflow canvas. Shows:
 *   <Workflow name>
 *   <Workflow name> / <Active group label>     ← when the viewport's centre
 *                                                point lands inside an
 *                                                `annotation.group` rect.
 *
 * Updates throttled with `requestAnimationFrame` via `useRafThrottle` so
 * pan-heavy interactions don't trigger an O(n) group scan on every
 * pointermove.
 */

import { memo, useEffect, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { useOnViewportChange, type ReactFlowInstance, type Viewport } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { Surface } from "@/components/surface/surface"
import { useRafThrottle } from "@/hooks/workflow/use-raf-throttle"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import type { RFWorkflowNode } from "@/lib/workflow/editor/react-flow-converter"
import { Panel } from "@/components/ai-elements/panel"

const GROUP_KIND = "annotation.group"

export interface ViewportBreadcrumbProps {
  store: EditorStore
  reactFlowInstance: ReactFlowInstance | null
  className?: string
}

interface GroupHit {
  id: string
  label: string
  rect: { x: number; y: number; width: number; height: number }
}

function readGroupRect(n: RFWorkflowNode): GroupHit | null {
  if (n.data.kind !== GROUP_KIND) return null
  const params =
    (n.data.params as { width?: number; height?: number; title?: string } | undefined) ?? {}
  const width = typeof params.width === "number" && params.width > 0 ? params.width : 240
  const height = typeof params.height === "number" && params.height > 0 ? params.height : 160
  return {
    id: n.id,
    label: typeof params.title === "string" && params.title.trim().length > 0 ? params.title : "",
    rect: { x: n.position.x, y: n.position.y, width, height },
  }
}

function findActiveGroup(
  nodes: ReadonlyArray<RFWorkflowNode>,
  viewport: Viewport
): GroupHit | null {
  if (typeof window === "undefined") return null
  // Convert viewport centre (screen space) to flow space using the inverse of
  // React Flow's transform: `flowPos = (screenPos - viewport.{x,y}) / zoom`.
  // We use window size as a stand-in for the canvas surface — close enough
  // for the breadcrumb decision and avoids depending on the canvas ref.
  const cx = (window.innerWidth / 2 - viewport.x) / viewport.zoom
  const cy = (window.innerHeight / 2 - viewport.y) / viewport.zoom

  // Smallest containing group wins (most specific).
  let best: GroupHit | null = null
  let bestArea = Infinity
  for (const n of nodes) {
    const hit = readGroupRect(n)
    if (!hit) continue
    const { x, y, width, height } = hit.rect
    if (cx < x || cx > x + width || cy < y || cy > y + height) continue
    const area = width * height
    if (area < bestArea) {
      best = hit
      bestArea = area
    }
  }
  return best
}

export const ViewportBreadcrumb = memo(function ViewportBreadcrumb({
  store,
  reactFlowInstance,
  className,
}: ViewportBreadcrumbProps) {
  const t = useTranslations("workflows.editor.breadcrumb")
  // Subscribe ONLY to the (rarely-changing) workflow name. The graph is read
  // through `store.getState().nodes` inside the throttled group scan, so a
  // node-drag frame (which replaces the `nodes` array) does NOT re-render the
  // breadcrumb — only `useOnViewportChange` (pan/zoom) drives recomputation.
  const workflowName = store((s: EditorState) => s.baseWorkflow.name)

  // Per-frame live viewport state is owned LOCALLY by the breadcrumb so that
  // pan/zoom doesn't re-render the canvas parent every animation frame. The
  // seed comes from the editor store; `useOnViewportChange` then pushes
  // updates while the user is interacting. The active-group compute below is
  // rAF-throttled so the O(n) group scan only runs once per frame.
  const [liveViewport, setLiveViewport] = useState<Viewport>(() => store.getState().viewport)
  useOnViewportChange({ onChange: setLiveViewport })

  const [activeGroup, setActiveGroup] = useState<GroupHit | null>(null)
  const compute = useMemo(
    () => (vp: Viewport) => setActiveGroup(findActiveGroup(store.getState().nodes, vp)),
    [store]
  )
  const throttled = useRafThrottle(compute)

  useEffect(() => {
    throttled.call(liveViewport)
  }, [throttled, liveViewport])

  const handleFitAll = () => {
    reactFlowInstance?.fitView({ duration: 240, padding: 0.2 })
  }
  const handleFitGroup = (g: GroupHit) => {
    const cx = g.rect.x + g.rect.width / 2
    const cy = g.rect.y + g.rect.height / 2
    reactFlowInstance?.setCenter(cx, cy, { duration: 240, zoom: 1.0 })
  }

  return (
    <Panel position="top-left" className="m-0 border-0 bg-transparent p-0">
      <Surface asChild layer="overlay" radius="control" elevation={1}>
        <nav
          className={cn(
            "absolute top-3 left-4 z-10 inline-flex items-center gap-1 border px-2 py-1 text-xs backdrop-blur",
            className
          )}
          data-testid="viewport-breadcrumb"
          aria-label={t("fitAll")}
        >
          <button
            type="button"
            className="max-w-[200px] truncate font-medium hover:underline"
            onClick={handleFitAll}
            title={t("fitAll")}
            data-testid="viewport-breadcrumb-root"
          >
            {workflowName}
          </button>
          {activeGroup ? (
            <>
              <ChevronRight className="size-3 opacity-50" aria-hidden />
              <button
                type="button"
                className="max-w-[160px] truncate text-muted-foreground hover:underline hover:text-foreground"
                onClick={() => handleFitGroup(activeGroup)}
                data-testid="viewport-breadcrumb-group"
              >
                {activeGroup.label || t("untitledGroup")}
              </button>
            </>
          ) : null}
        </nav>
      </Surface>
    </Panel>
  )
})
