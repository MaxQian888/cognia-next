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

import { PanelLeft, PanelLeftOpen, PanelRight, PanelRightOpen } from "lucide-react"
import { useTranslations } from "next-intl"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/ui"
import { useCanvasLayoutShortcuts } from "@/hooks/canvas/use-canvas-layout-shortcuts"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { CanvasDocumentRail } from "./canvas-document-rail"
import { CanvasSidePanels } from "./canvas-side-panels"
import { CanvasWorkspace } from "./canvas-workspace"

export const CANVAS_SHELL_EDITOR_MIN_WIDTH = 480
export const CANVAS_SHELL_LEFT_MIN = 12
export const CANVAS_SHELL_LEFT_MAX = 32
export const CANVAS_SHELL_CENTER_MIN = 38
export const CANVAS_SHELL_RIGHT_MIN = 16
export const CANVAS_SHELL_RIGHT_MAX = 36

export function CanvasShell() {
  useCanvasLayoutShortcuts()
  const isMobile = useIsMobile()
  if (isMobile) return <CanvasMobileShell />
  return <CanvasDesktopShell />
}

function CanvasDesktopShell() {
  const t = useTranslations("canvas.shell")
  const leftSize = useCanvasLayoutStore((s) => s.leftSize)
  const centerSize = useCanvasLayoutStore((s) => s.centerSize)
  const rightSize = useCanvasLayoutStore((s) => s.rightSize)
  const leftCollapsed = useCanvasLayoutStore((s) => s.leftCollapsed)
  const rightCollapsed = useCanvasLayoutStore((s) => s.rightCollapsed)
  const setSizes = useCanvasLayoutStore((s) => s.setSizes)
  const setLeftCollapsed = useCanvasLayoutStore((s) => s.setLeftCollapsed)
  const setRightCollapsed = useCanvasLayoutStore((s) => s.setRightCollapsed)

  // Derive panel sizes that always sum to 100 so the library gets valid flex proportions.
  const clampedLeft = Math.max(CANVAS_SHELL_LEFT_MIN, Math.min(CANVAS_SHELL_LEFT_MAX, leftSize))
  const clampedRight = Math.max(CANVAS_SHELL_RIGHT_MIN, Math.min(CANVAS_SHELL_RIGHT_MAX, rightSize))
  const derivedCenter = Math.max(CANVAS_SHELL_CENTER_MIN, 100 - clampedLeft - clampedRight)
  const sizeTotal = clampedLeft + derivedCenter + clampedRight
  const scale = sizeTotal > 0 ? 100 / sizeTotal : 1
  const panelLeft = clampedLeft * scale
  const panelCenter = derivedCenter * scale
  const panelRight = clampedRight * scale

  return (
    <div className="relative flex w-full flex-1 min-h-0 overflow-hidden">
      {leftCollapsed && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute left-1 top-1 z-10 size-7 rounded-md bg-background/70 shadow-sm backdrop-blur"
              aria-label={t("expandLeft")}
              onClick={() => setLeftCollapsed(false)}
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("expandLeft")}</TooltipContent>
        </Tooltip>
      )}
      {rightCollapsed && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 z-10 size-7 rounded-md bg-background/70 shadow-sm backdrop-blur"
              aria-label={t("expandRight")}
              onClick={() => setRightCollapsed(false)}
            >
              <PanelRightOpen className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t("expandRight")}</TooltipContent>
        </Tooltip>
      )}

      <ResizablePanelGroup
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
        {!leftCollapsed && (
          <>
            <ResizablePanel
              id="canvas-left"
              defaultSize={panelLeft}
              minSize={CANVAS_SHELL_LEFT_MIN}
              maxSize={CANVAS_SHELL_LEFT_MAX}
            >
              <CanvasDocumentRail />
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        )}

        <ResizablePanel
          id="canvas-center"
          defaultSize={panelCenter}
          minSize={CANVAS_SHELL_CENTER_MIN}
        >
          {/* Pixel-based safety floor to complement the percentage-based
              `minSize` on the Resizable panel — keeps the editor usable on
              very wide windows where the percentage clamp could allow the
              center pane to compress past a comfortable width. */}
          <div className="flex h-full min-h-0 min-w-[480px] overflow-hidden">
            <CanvasWorkspace />
          </div>
        </ResizablePanel>

        {!rightCollapsed && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              id="canvas-right"
              defaultSize={panelRight}
              minSize={CANVAS_SHELL_RIGHT_MIN}
              maxSize={CANVAS_SHELL_RIGHT_MAX}
            >
              <CanvasSidePanels />
            </ResizablePanel>
          </>
        )}
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
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex items-center justify-between border-b bg-background/80 px-2 py-1 backdrop-blur">
        <Sheet open={mobileLeftOpen} onOpenChange={setMobileLeftOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("openDocuments")}>
              <PanelLeft className="size-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[280px] p-0">
            <CanvasDocumentRail />
          </SheetContent>
        </Sheet>

        <Sheet open={mobileRightOpen} onOpenChange={setMobileRightOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("openTools")}>
              <PanelRight className="size-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-[320px] p-0">
            <CanvasSidePanels />
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
