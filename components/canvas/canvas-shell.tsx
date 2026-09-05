"use client"

/**
 * Canvas Shell — owner of the resizable 3-pane layout for the Canvas guild.
 *
 *   ┌──────────┬─────────────────────────────┬──────────┐
 *   │ Document │ Editor (CanvasWorkspace)    │ Tools    │
 *   │ rail     │  ◀ resize ▶                 │ rail     │
 *   └──────────┴─────────────────────────────┴──────────┘
 *
 * Desktop: VS Code / Cursor style — drag any divider, Ctrl/Cmd+B / Ctrl/Cmd+J
 * collapse rails, sizes survive reloads via `useCanvasLayoutStore`.
 *
 * Mobile (< md): the editor takes the full width and the rails become Sheet
 * overlays triggered from a slim header. Same component instances on both
 * branches — no duplication.
 */

import { PanelLeft, PanelRight } from "lucide-react"
import { motion } from "motion/react"
import { useTranslations } from "next-intl"
import { Activity, useEffect, useRef } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/ui"
import { useCanvasLayoutShortcuts } from "@/hooks/canvas/use-canvas-layout-shortcuts"
import { CANVAS_LAYOUT_DEFAULTS, useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { magnetAsPercent, snapPanelSize } from "@/lib/ui/panel-snap"
import { WORKBENCH_RAIL_WIDTH_PX } from "@/types/shell/workbench-rail"
import { useWorkbenchRailPersistent } from "@/components/shell/use-workbench-rail-layout"
import { CanvasActionsProvider } from "./canvas-actions-context"
import { CanvasDocumentRail } from "./canvas-document-rail"
import { CanvasSidePanels } from "./canvas-side-panels"
import { CanvasWorkspace } from "./canvas-workspace"

export const CANVAS_SHELL_EDITOR_MIN_WIDTH = 480
export const CANVAS_SHELL_LEFT_MIN = 12
export const CANVAS_SHELL_LEFT_MAX = 32
export const CANVAS_SHELL_CENTER_MIN = 46
export const CANVAS_SHELL_RIGHT_MIN = 16
export const CANVAS_SHELL_RIGHT_MAX = 28

export function CanvasShell() {
  useCanvasLayoutShortcuts()
  const isMobile = useIsMobile()
  // The provider spans the editor pane and the right rail, so an action fired
  // from the toolbar and the panel that renders its output are looking at the
  // same run.
  return (
    <CanvasActionsProvider>
      {isMobile ? <CanvasMobileShell /> : <CanvasDesktopShell />}
    </CanvasActionsProvider>
  )
}

function CanvasDesktopShell() {
  const leftSize = useCanvasLayoutStore((s) => s.leftSize)
  const rightSize = useCanvasLayoutStore((s) => s.rightSize)
  const leftCollapsed = useCanvasLayoutStore((s) => s.leftCollapsed)
  const rightCollapsed = useCanvasLayoutStore((s) => s.rightCollapsed)
  const layoutVersion = useCanvasLayoutStore((s) => s.layoutVersion)
  const setSizes = useCanvasLayoutStore((s) => s.setSizes)
  const setRightCollapsed = useCanvasLayoutStore((s) => s.setRightCollapsed)
  const railPersistent = useWorkbenchRailPersistent()
  // Same contract as the chat dock: collapsed means "shrunk to the activity
  // rail" unless the user has switched the persistent rail off.
  const rightCollapsedSize = railPersistent ? `${WORKBENCH_RAIL_WIDTH_PX}px` : "0%"
  const rightPanelElementRef = useRef<HTMLDivElement | null>(null)
  const rightPanelRef = useRef<PanelImperativeHandle | null>(null)
  const latestRightPercentRef = useRef(rightSize)
  const rightDragStartCollapsedRef = useRef(rightCollapsed)
  const previousRightCollapsedRef = useRef(rightCollapsed)

  const clampedLeft = Math.max(CANVAS_SHELL_LEFT_MIN, Math.min(CANVAS_SHELL_LEFT_MAX, leftSize))
  const clampedRight = Math.max(CANVAS_SHELL_RIGHT_MIN, Math.min(CANVAS_SHELL_RIGHT_MAX, rightSize))
  const derivedCenter = Math.max(CANVAS_SHELL_CENTER_MIN, 100 - clampedLeft - clampedRight)
  const sizeTotal = clampedLeft + derivedCenter + clampedRight
  const scale = sizeTotal > 0 ? 100 / sizeTotal : 1
  const panelLeft = clampedLeft * scale
  const panelCenter = derivedCenter * scale
  const panelRight = clampedRight * scale

  // Reuse one transition for both rails so reduced-motion only collapses once
  // per render — keeps the motion.div opacity tween in sync with the layout
  // interpolation that framer drives via the `layout` prop.
  const collapseTransition = useReducedMotionTransition(mobileTransition("normal"))

  // Drive the panel imperatively when the store's collapsed flag flips.
  //
  // `defaultSize` / `collapsedSize` are read once when the group lays out;
  // changing the prop later moves nothing, and the group only re-keys on
  // `layoutVersion`, which `resetLayout` alone bumps. So the rail toggle and
  // ⌘J updated the store and left the column exactly where it was — the panel
  // never shrank to the rail and never came back. The chat dock and the
  // workflow editor already drive their panel this way.
  useEffect(() => {
    if (previousRightCollapsedRef.current === rightCollapsed) return
    previousRightCollapsedRef.current = rightCollapsed
    const panel = rightPanelRef.current
    if (!panel) return
    if (rightCollapsed) panel.collapse()
    else panel.resize(`${panelRight}%`)
    // `panelRight` is derived from the stored width and is only read on the
    // expand branch, where it is the width to come back to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightCollapsed])

  /** Release-snap for the right rail — see `lib/ui/panel-snap.ts`. */
  const handleRightResizeRelease = () => {
    const groupWidthPx = rightPanelElementRef.current?.parentElement?.offsetWidth ?? 0
    const wasCollapsed = rightDragStartCollapsedRef.current
    const snapped = snapPanelSize(latestRightPercentRef.current, {
      // Canvas has no narrow/wide preset table; its one meaningful width is the
      // shipped default, which is also what `resetLayout` restores.
      presets: [CANVAS_LAYOUT_DEFAULTS.rightSize],
      floor: CANVAS_SHELL_RIGHT_MIN,
      expandTo: rightSize,
      wasCollapsed,
      magnet: magnetAsPercent(groupWidthPx),
    })
    if (snapped.kind === "collapsed") {
      setRightCollapsed(true)
      return
    }
    if (wasCollapsed) setRightCollapsed(false)
    // Canvas sizes all three columns at once, so the snap has to give the width
    // it takes back to the centre pane rather than to the group.
    if (snapped.size !== latestRightPercentRef.current) {
      setSizes([
        panelLeft,
        Math.max(CANVAS_SHELL_CENTER_MIN, 100 - panelLeft - snapped.size),
        snapped.size,
      ])
    }
  }

  return (
    <div className="flex w-full flex-1 min-h-0 overflow-hidden" data-bg-target="canvas">
      <ResizablePanelGroup
        key={layoutVersion}
        orientation="horizontal"
        resizeTargetMinimumSize={{ coarse: 28, fine: 20 }}
        className="flex-1 min-h-0"
        onLayoutChanged={(layout) => {
          const order = ["canvas-left", "canvas-center", "canvas-right"] as const
          const sizes = order
            .map((id) => layout[id])
            .filter((v): v is number => typeof v === "number")
          if (sizes.length !== 3) return
          // Tracked before the collapse check so a drag *out* of the rail still
          // tells the release-snap where the pointer left it.
          latestRightPercentRef.current = sizes[2] as number
          if (rightCollapsed) return
          // `react-resizable-panels` collapses on its own below `minSize`.
          // Mirroring it keeps the rail toggle and ⌘J in step with the screen —
          // the same gap the chat dock had.
          if ((sizes[2] as number) < CANVAS_SHELL_RIGHT_MIN) {
            setRightCollapsed(true)
            return
          }
          setSizes(sizes)
        }}
      >
        <ResizablePanel
          id="canvas-left"
          defaultSize={leftCollapsed ? "0%" : `${panelLeft}%`}
          minSize={leftCollapsed ? "0%" : `${CANVAS_SHELL_LEFT_MIN}%`}
          maxSize={`${CANVAS_SHELL_LEFT_MAX}%`}
          collapsible
          collapsedSize="0%"
        >
          <motion.div
            data-testid="canvas-left-wrapper"
            layout
            animate={{ opacity: leftCollapsed ? 0 : 1 }}
            transition={collapseTransition}
            className="flex h-full min-w-0 overflow-hidden"
          >
            <CanvasDocumentRail />
          </motion.div>
        </ResizablePanel>
        <ResizableHandle withHandle className={cn(leftCollapsed && "hidden")} />

        <ResizablePanel
          id="canvas-center"
          defaultSize={`${panelCenter}%`}
          minSize={`${CANVAS_SHELL_CENTER_MIN}%`}
        >
          <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
            <CanvasWorkspace />
          </div>
        </ResizablePanel>

        {/* The divider stays live over a persistent rail: dragging this edge
            outward is how the collapsed workbench is reopened. */}
        <ResizableHandle
          withHandle
          className={cn("z-20 after:w-5", rightCollapsed && !railPersistent && "hidden")}
          onPointerDown={() => {
            rightDragStartCollapsedRef.current = rightCollapsed
          }}
          onPointerUp={handleRightResizeRelease}
        />
        <ResizablePanel
          id="canvas-right"
          panelRef={rightPanelRef}
          elementRef={rightPanelElementRef}
          defaultSize={rightCollapsed ? rightCollapsedSize : `${panelRight}%`}
          minSize={rightCollapsed ? rightCollapsedSize : `${CANVAS_SHELL_RIGHT_MIN}%`}
          maxSize={`${CANVAS_SHELL_RIGHT_MAX}%`}
          collapsible
          collapsedSize={rightCollapsedSize}
        >
          {/* Not faded out while the rail is persistent — the rail is the whole
              point of that state and has to stay legible. */}
          <motion.div
            data-testid="canvas-right-wrapper"
            layout
            animate={{ opacity: rightCollapsed && !railPersistent ? 0 : 1 }}
            transition={collapseTransition}
            className="flex h-full min-w-0 overflow-hidden"
          >
            <CanvasSidePanels railOnly={rightCollapsed && railPersistent} />
          </motion.div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

function CanvasMobileShell() {
  const t = useTranslations("canvas.shell")
  const mobileLeftOpen = useCanvasLayoutStore((s) => s.mobileLeftOpen)
  const mobileRightOpen = useCanvasLayoutStore((s) => s.mobileRightOpen)
  const setMobileLeftOpen = useCanvasLayoutStore((s) => s.setMobileLeftOpen)
  const setMobileRightOpen = useCanvasLayoutStore((s) => s.setMobileRightOpen)

  return (
    <div className="flex flex-1 min-h-0 flex-col" data-bg-target="canvas">
      <div className="flex items-center justify-between border-b bg-background/80 px-2 py-1 backdrop-blur">
        <Sheet open={mobileLeftOpen} onOpenChange={setMobileLeftOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("openDocuments")}>
              <PanelLeft className="size-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[min(85vw,360px)] p-0">
            <CanvasDocumentRail />
          </SheetContent>
        </Sheet>

        <Sheet open={mobileRightOpen} onOpenChange={setMobileRightOpen} modal={mobileRightOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("openTools")}>
              <PanelRight className="size-4" />
            </Button>
          </SheetTrigger>
          <SheetContent
            forceMount
            side="right"
            className="w-[min(85vw,360px)] p-0"
            inert={!mobileRightOpen}
            aria-hidden={!mobileRightOpen}
          >
            <Activity mode={mobileRightOpen ? "visible" : "hidden"}>
              <CanvasSidePanels mobile />
            </Activity>
          </SheetContent>
        </Sheet>
      </div>
      <div className="flex flex-1 min-h-0">
        <CanvasWorkspace />
      </div>
    </div>
  )
}

export default CanvasShell
