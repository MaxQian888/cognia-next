"use client"

/**
 * Feature Page Shell — the Canvas-style 3-pane layout that most top-level
 * feature routes ( /workflows, /twin, /discover, /skills, /plugins,
 * /agent-teams, /logs, /me, /settings ) render inside.
 *
 * `/inbox` is deliberately NOT one of them, despite this list having claimed
 * it for a while. A mail-style three-pane reader (rail, conversation list,
 * thread) is a different layout from a feature page with optional rails: its
 * middle pane is the primary navigation, not a side rail, and its panes have
 * their own persisted sizes. It renders `FeaturePageHeader` on its own instead,
 * so the two routes still present the same seam. Same for `/scheduler`.
 *
 *   ┌─────────── header (sticky) ───────────┐
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
 * Below `lg` the side panes collapse: only the center renders, with
 * "open left" / "open right" Sheet triggers in the toolbar so feature pages
 * stay usable on a phone, on Capacitor, and in a narrow desktop window. Those
 * Sheets are uncontrolled by default. A route whose center pane selects what
 * the right pane shows should pass `open` / `onOpenChange` on the pane config
 * so a tap opens the detail instead of silently updating a store nothing is
 * watching, and that now matters on a 900px desktop window and not only on a
 * phone.
 *
 * The shell owns `data-bg-target`, not its callers. Hand-marking it left seven
 * routes ( /logs, /devices, /agent-runs, /templates, /goals, /integrations,
 * /servers ) with no marker at all, so an enabled wallpaper simply did not
 * appear on them — the same class of defect ADR-0007 catalogued as E1, where
 * the scope selector existed in CSS but no component ever applied the
 * attribute. Owning it here means a new feature route cannot forget.
 */

import { PanelLeftIcon, PanelRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { useBreakpoint } from "@/hooks/ui"
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
  /**
   * Controlled open state for this pane's mobile Sheet. Omit to leave the
   * Sheet uncontrolled, which is the historical behaviour.
   *
   * Uncontrolled is wrong for any route whose center pane SELECTS what the
   * right pane shows: tapping a row sets the selection in a store, the Sheet
   * has no idea, and the tap reads as a dead end. The row had to be followed
   * by a hunt for a 16px panel icon in the pane-controls strip. Passing the
   * selection in here is what turns a phone tap into a detail view.
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export interface FeaturePageShellProps {
  /** Stable id used for `autoSaveId` (panel size persistence) and Sheet keys. */
  storageId: string
  /** Optional header that spans the full content width and owns its own chrome. */
  header?: React.ReactNode
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
  header,
  leftPane,
  rightPane,
  children,
  centerClassName,
}: FeaturePageShellProps) {
  // Three panes need roughly 1024px before the side ones stop starving each
  // other. Between `md` and `lg` the percentages still resolved, so the shell
  // rendered three columns in about 750px: the right pane landed near 165px
  // and clipped its own property values mid-word, and the board lost two of
  // its six columns off the edge. The tablet tier keeps the desktop centre and
  // moves the side panes into the overlay the phone tier already used.
  const overlayPanes = useBreakpoint() !== "desktop"

  if (overlayPanes) {
    return (
      <FeaturePageShellOverlay
        storageId={storageId}
        header={header}
        leftPane={leftPane}
        rightPane={rightPane}
        centerClassName={centerClassName}
      >
        {children}
      </FeaturePageShellOverlay>
    )
  }

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
      data-bg-target="chat"
      data-testid={`feature-shell-${storageId}`}
    >
      {header ? (
        <div className="shrink-0" data-testid={`feature-shell-${storageId}-header`}>
          {header}
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
                defaultSize={`${leftPane.defaultSize ?? DEFAULT_LEFT_SIZE}%`}
                minSize={`${leftPane.minSize ?? DEFAULT_LEFT_MIN}%`}
                maxSize={`${leftPane.maxSize ?? DEFAULT_LEFT_MAX}%`}
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
            defaultSize={`${
              100 -
              (leftPane?.defaultSize ?? (leftPane ? DEFAULT_LEFT_SIZE : 0)) -
              (rightPane?.defaultSize ?? (rightPane ? DEFAULT_RIGHT_SIZE : 0))
            }%`}
            minSize={`${DEFAULT_CENTER_MIN}%`}
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
                defaultSize={`${rightPane.defaultSize ?? DEFAULT_RIGHT_SIZE}%`}
                minSize={`${rightPane.minSize ?? DEFAULT_RIGHT_MIN}%`}
                maxSize={`${rightPane.maxSize ?? DEFAULT_RIGHT_MAX}%`}
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

function FeaturePageShellOverlay({
  storageId,
  header,
  leftPane,
  rightPane,
  children,
  centerClassName,
}: Omit<FeaturePageShellProps, "storageId"> & { storageId: string }) {
  const t = useTranslations("featureShell")

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
      data-bg-target="chat"
      data-testid={`feature-shell-${storageId}`}
    >
      {header ? (
        <div className="shrink-0" data-testid={`feature-shell-${storageId}-header`}>
          {header}
        </div>
      ) : null}

      {leftPane || rightPane ? (
        <div
          className="flex min-h-9 shrink-0 items-center justify-between border-b border-border/60 bg-muted/20 px-2"
          data-testid={`feature-shell-${storageId}-pane-controls`}
        >
          {leftPane ? (
            <Sheet open={leftPane.open} onOpenChange={leftPane.onOpenChange}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
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
          ) : (
            <span />
          )}

          {rightPane ? (
            <Sheet open={rightPane.open} onOpenChange={rightPane.onOpenChange}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
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
      ) : null}

      <div
        className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", centerClassName)}
        data-testid={`feature-shell-${storageId}-center`}
      >
        {children}
      </div>
    </div>
  )
}
