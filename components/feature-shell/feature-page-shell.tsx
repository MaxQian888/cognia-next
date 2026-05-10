"use client"

/**
 * Feature Page Shell — the Canvas-style 3-pane layout that every top-level
 * feature route ( /workflows, /inbox, /twin, /discover, /skills, /plugins,
 * /agent-teams, /scheduler, /logs, /me, /settings ) renders inside.
 *
 *   ┌────────── toolbar (sticky) ───────────┐
 *   │ left │  center (children)  │  right   │
 *   │ rail │   ◀ resize ▶        │   rail   │
 *   └───────────────────────────────────────┘
 *
 * Mounted inside `DesktopAppShell`'s content slot — this component does not
 * own any global chrome. v1 uses fixed default sizes per pane; per-route
 * persistence (via `useDefaultLayout`) can be wired in once a feature
 * actually wants it. `CanvasShell` keeps its own zustand store because it
 * has collapse shortcuts and version-bumped resets that this lighter shell
 * does not need.
 *
 * On viewports < md the panes collapse: only the center renders, with
 * "open left" / "open right" Sheet triggers in the toolbar so feature pages
 * stay usable on mobile / Capacitor.
 */

import { PanelLeftIcon, PanelRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { useIsMobile } from "@/hooks/ui"
import { cn } from "@/lib/utils"

export interface FeaturePaneConfig {
  /** Pane content. */
  content: React.ReactNode
  /** Accessible label for the Sheet trigger on mobile (and the panel root). */
  label: string
  /** Default panel size in percent. */
  defaultSize?: number
  /** Minimum panel size in percent. */
  minSize?: number
  /** Maximum panel size in percent. */
  maxSize?: number
  /** Sheet width override on mobile. */
  mobileWidthClass?: string
}

export interface FeaturePageShellProps {
  /** Stable id used for `autoSaveId` (panel size persistence) and Sheet keys. */
  storageId: string
  /** Optional sticky top bar that spans the full content width. */
  toolbar?: React.ReactNode
  /** Optional left rail. Omit to render only center+right (or just center). */
  leftPane?: FeaturePaneConfig
  /** Optional right inspector. Omit to render only left+center (or just center). */
  rightPane?: FeaturePaneConfig
  /** Center pane content. */
  children: React.ReactNode
  /** Extra className applied to the center pane wrapper. */
  centerClassName?: string
}

const DEFAULT_LEFT_SIZE = 18
const DEFAULT_LEFT_MIN = 12
const DEFAULT_LEFT_MAX = 32
const DEFAULT_RIGHT_SIZE = 22
const DEFAULT_RIGHT_MIN = 16
const DEFAULT_RIGHT_MAX = 32
const DEFAULT_CENTER_MIN = 30

export function FeaturePageShell({
  storageId,
  toolbar,
  leftPane,
  rightPane,
  children,
  centerClassName,
}: FeaturePageShellProps) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <FeaturePageShellMobile
        storageId={storageId}
        toolbar={toolbar}
        leftPane={leftPane}
        rightPane={rightPane}
        centerClassName={centerClassName}
      >
        {children}
      </FeaturePageShellMobile>
    )
  }

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
      data-testid={`feature-shell-${storageId}`}
    >
      {toolbar ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b bg-background/80 px-3 py-1.5 backdrop-blur"
          data-testid={`feature-shell-${storageId}-toolbar`}
        >
          {toolbar}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <ResizablePanelGroup
          id={`feature-shell-group-${storageId}`}
          orientation="horizontal"
          className="flex-1 min-h-0"
        >
          {leftPane ? (
            <>
              <ResizablePanel
                id={`pane-${storageId}-left`}
                defaultSize={leftPane.defaultSize ?? DEFAULT_LEFT_SIZE}
                minSize={leftPane.minSize ?? DEFAULT_LEFT_MIN}
                maxSize={leftPane.maxSize ?? DEFAULT_LEFT_MAX}
              >
                <aside
                  aria-label={leftPane.label}
                  className="flex h-full min-w-0 flex-col overflow-hidden border-r bg-muted/20"
                >
                  {leftPane.content}
                </aside>
              </ResizablePanel>
              <ResizableHandle withHandle />
            </>
          ) : null}

          <ResizablePanel
            id={`pane-${storageId}-center`}
            defaultSize={
              100 -
              (leftPane?.defaultSize ?? (leftPane ? DEFAULT_LEFT_SIZE : 0)) -
              (rightPane?.defaultSize ?? (rightPane ? DEFAULT_RIGHT_SIZE : 0))
            }
            minSize={DEFAULT_CENTER_MIN}
          >
            <div
              className={cn("flex h-full min-w-0 flex-1 flex-col overflow-hidden", centerClassName)}
              data-testid={`feature-shell-${storageId}-center`}
            >
              {children}
            </div>
          </ResizablePanel>

          {rightPane ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                id={`pane-${storageId}-right`}
                defaultSize={rightPane.defaultSize ?? DEFAULT_RIGHT_SIZE}
                minSize={rightPane.minSize ?? DEFAULT_RIGHT_MIN}
                maxSize={rightPane.maxSize ?? DEFAULT_RIGHT_MAX}
              >
                <aside
                  aria-label={rightPane.label}
                  className="flex h-full min-w-0 flex-col overflow-hidden border-l bg-muted/10"
                >
                  {rightPane.content}
                </aside>
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>
    </div>
  )
}

function FeaturePageShellMobile({
  storageId,
  toolbar,
  leftPane,
  rightPane,
  children,
  centerClassName,
}: Omit<FeaturePageShellProps, "storageId"> & { storageId: string }) {
  const t = useTranslations("featureShell")

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
      data-testid={`feature-shell-${storageId}`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b bg-background/80 px-2 py-1 backdrop-blur">
        {leftPane ? (
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("openLeft", { name: leftPane.label })}
              >
                <PanelLeftIcon className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className={cn("p-0", leftPane.mobileWidthClass ?? "w-[280px]")}
            >
              <div className="flex h-full flex-col overflow-hidden">{leftPane.content}</div>
            </SheetContent>
          </Sheet>
        ) : null}

        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{toolbar}</div>

        {rightPane ? (
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("openRight", { name: rightPane.label })}
              >
                <PanelRightIcon className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className={cn("p-0", rightPane.mobileWidthClass ?? "w-[320px]")}
            >
              <div className="flex h-full flex-col overflow-hidden">{rightPane.content}</div>
            </SheetContent>
          </Sheet>
        ) : null}
      </div>

      <div
        className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", centerClassName)}
        data-testid={`feature-shell-${storageId}-center`}
      >
        {children}
      </div>
    </div>
  )
}
