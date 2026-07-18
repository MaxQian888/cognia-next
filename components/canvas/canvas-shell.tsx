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
import { Activity } from "react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/ui"
import { useCanvasLayoutShortcuts } from "@/hooks/canvas/use-canvas-layout-shortcuts"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
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
  if (isMobile) return <CanvasMobileShell />
  return <CanvasDesktopShell />
}

function CanvasDesktopShell() {
  const leftSize = useCanvasLayoutStore((s) => s.leftSize)
  const rightSize = useCanvasLayoutStore((s) => s.rightSize)
  const leftCollapsed = useCanvasLayoutStore((s) => s.leftCollapsed)
  const rightCollapsed = useCanvasLayoutStore((s) => s.rightCollapsed)
  const layoutVersion = useCanvasLayoutStore((s) => s.layoutVersion)
  const setSizes = useCanvasLayoutStore((s) => s.setSizes)

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

  return (
    <div className="flex w-full flex-1 min-h-0 overflow-hidden" data-bg-target="canvas">
      <ResizablePanelGroup
        key={layoutVersion}
        orientation="horizontal"
        className="flex-1 min-h-0"
        onLayoutChanged={(layout) => {
          const order = ["canvas-left", "canvas-center", "canvas-right"] as const
          const sizes = order
            .map((id) => layout[id])
            .filter((v): v is number => typeof v === "number")
          if (sizes.length === 3) setSizes(sizes)
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

        <ResizableHandle withHandle className={cn(rightCollapsed && "hidden")} />
        <ResizablePanel
          id="canvas-right"
          defaultSize={rightCollapsed ? "0%" : `${panelRight}%`}
          minSize={rightCollapsed ? "0%" : `${CANVAS_SHELL_RIGHT_MIN}%`}
          maxSize={`${CANVAS_SHELL_RIGHT_MAX}%`}
          collapsible
          collapsedSize="0%"
        >
          <motion.div
            data-testid="canvas-right-wrapper"
            layout
            animate={{ opacity: rightCollapsed ? 0 : 1 }}
            transition={collapseTransition}
            className="flex h-full min-w-0 overflow-hidden"
          >
            <CanvasSidePanels />
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
