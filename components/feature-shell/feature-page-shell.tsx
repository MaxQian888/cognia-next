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

import { useRef, useState } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"
import { PanelLeftIcon, PanelRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useBreakpoint } from "@/hooks/ui"
import { cn } from "@/lib/utils"
import { centerPaneSize, paneSize } from "./pane-size"
import { useSettledPaneSize } from "./settled-pane-size"

export interface FeaturePaneConfig {
  /** Pane content. */
  content: React.ReactNode
  /** Accessible label for the Sheet trigger on mobile (and the panel root). */
  label: string
  /**
   * Panel sizes. A number is a percentage of the group (the historical
   * contract). A string is passed to `react-resizable-panels` verbatim, so it
   * may carry any CSS unit — `"13rem"` pins a rail to a fixed width instead of
   * letting it grow with the window, which is what a short-label nav rail wants.
   */
  defaultSize?: number | string
  /** Minimum panel size — number = percent, string = CSS length. */
  minSize?: number | string
  /** Maximum panel size — number = percent, string = CSS length. */
  maxSize?: number | string
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
  /**
   * Whether the overlay tiers show a trigger button for this pane. Default
   * `true`. A pane that only exists while something is selected — an
   * inspector — is opened by the selection itself, so its trigger is a dead
   * button that appears and disappears with the selection and pushes the list
   * down a strip as it does. Turn it off there and pass `open`.
   */
  overlayTrigger?: boolean
  /**
   * Whether the overlay Sheet draws its own close button. Default `true`. Turn
   * it off for content that already has a close control in its header, or the
   * two sit on top of each other.
   */
  overlayCloseButton?: boolean
  /**
   * The pane's width in pixels after a resize settles (desktop only; called
   * once per drag, not per frame). A route that remembers its rail width
   * stores this and hands it back as a pixel `defaultSize`.
   */
  onSizeChange?: (px: number) => void
}

export interface FeaturePageShellProps {
  /**
   * Stable id used for the panel group's DOM id and the Sheet keys.
   *
   * Despite the name it is NOT an `autoSaveId`: per-route size persistence is
   * deliberately unwired (see the module doc), so a resized rail resets on
   * reload until a route opts in.
   */
  storageId: string
  /** Optional header that spans the full content width and owns its own chrome. */
  header?: React.ReactNode
  /** On desktop, place the header above only the detail pane beside a full-height list. */
  headerPlacement?: "full-width" | "center"
  /** Optional left rail. Omit to render only center+right (or just center). */
  leftPane?: FeaturePaneConfig
  /** Opt in to an animated desktop list toggle; overlay sheets keep their own controls. */
  collapsibleLeftPane?: boolean
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
  collapsibleLeftPane = false,
  headerPlacement = "full-width",
}: FeaturePageShellProps) {
  // Three panes need roughly 1024px before the side ones stop starving each
  // other. Between `md` and `lg` the percentages still resolved, so the shell
  // rendered three columns in about 750px: the right pane landed near 165px
  // and clipped its own property values mid-word, and the board lost two of
  // its six columns off the edge. The tablet tier keeps the desktop centre and
  // moves the side panes into the overlay the phone tier already used.
  const overlayPanes = useBreakpoint() !== "desktop"

  const t = useTranslations("featureShell")
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [animateToggle, setAnimateToggle] = useState(false)
  const leftPanelRef = useRef<PanelImperativeHandle | null>(null)
  const previousCollapsedRef = useRef(false)
  const expandedWidthRef = useRef<number | null>(null)
  const leftSize = useSettledPaneSize(leftPane?.onSizeChange)
  const leftDefault = paneSize(leftPane?.defaultSize, DEFAULT_LEFT_SIZE)

  useIsomorphicLayoutEffect(() => {
    if (previousCollapsedRef.current === leftCollapsed) return
    previousCollapsedRef.current = leftCollapsed
    const panel = leftPanelRef.current
    if (leftCollapsed) panel?.collapse()
    else
      panel?.resize(
        expandedWidthRef.current && expandedWidthRef.current > 0
          ? expandedWidthRef.current
          : leftDefault
      )
  }, [leftCollapsed, leftDefault])

  const toggleLeft = () => {
    if (!leftCollapsed) expandedWidthRef.current = leftPanelRef.current?.getSize().inPixels ?? null
    setAnimateToggle(true)
    setLeftCollapsed((collapsed) => !collapsed)
  }

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

  const desktopHeader =
    header || (leftPane && collapsibleLeftPane) ? (
      <div
        className={cn("shrink-0", collapsibleLeftPane && "flex")}
        data-testid={`feature-shell-${storageId}-header`}
      >
        {leftPane && collapsibleLeftPane ? (
          <div className="flex shrink-0 items-center border-b border-border/70 pl-3">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t(leftCollapsed ? "openLeft" : "closeLeft", { name: leftPane.label })}
              aria-expanded={!leftCollapsed}
              aria-controls={`pane-${storageId}-left`}
              onClick={toggleLeft}
            >
              <PanelLeftIcon className="size-4" />
            </Button>
          </div>
        ) : null}
        {collapsibleLeftPane ? <div className="min-w-0 flex-1">{header}</div> : header}
      </div>
    ) : null

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
      data-bg-target="chat"
      data-testid={`feature-shell-${storageId}`}
    >
      {headerPlacement === "full-width" ? desktopHeader : null}

      <div className="flex min-h-0 flex-1">
        <ResizablePanelGroup
          id={`feature-shell-group-${storageId}`}
          orientation="horizontal"
          className={cn(
            "flex-1 min-h-0",
            animateToggle &&
              "[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-200 [&>[data-panel]]:ease-out"
          )}
          onTransitionEnd={(event) => {
            if (event.propertyName === "flex-grow") setAnimateToggle(false)
          }}
          onLayoutChanged={(layout) => {
            leftSize.flush()
            if (!collapsibleLeftPane) return
            const collapsed = layout[`pane-${storageId}-left`] === 0
            // A drag can collapse the list as well as the header button.
            setLeftCollapsed(collapsed)
          }}
        >
          {leftPane ? (
            <>
              <ResizablePanel
                id={`pane-${storageId}-left`}
                panelRef={leftPanelRef}
                collapsible={collapsibleLeftPane}
                collapsedSize="0%"
                groupResizeBehavior={collapsibleLeftPane ? "preserve-pixel-size" : undefined}
                defaultSize={leftCollapsed ? "0%" : leftDefault}
                style={collapsibleLeftPane ? { overflow: "hidden" } : undefined}
                minSize={paneSize(leftPane.minSize, DEFAULT_LEFT_MIN)}
                maxSize={paneSize(leftPane.maxSize, DEFAULT_LEFT_MAX)}
                onResize={leftPane.onSizeChange ? leftSize.onResize : undefined}
              >
                <aside
                  aria-label={leftPane.label}
                  inert={leftCollapsed}
                  aria-hidden={leftCollapsed || undefined}
                  style={
                    collapsibleLeftPane
                      ? { minWidth: paneSize(leftPane.minSize, DEFAULT_LEFT_MIN) }
                      : undefined
                  }
                  className="flex h-full min-w-0 flex-col overflow-hidden border-r bg-muted/20"
                >
                  {leftPane.content}
                </aside>
              </ResizablePanel>
              <ResizableHandle
                withHandle
                className={cn(leftCollapsed && "hidden")}
                onPointerDownCapture={() => {
                  setAnimateToggle(false)
                  expandedWidthRef.current = leftPanelRef.current?.getSize().inPixels ?? null
                }}
                onKeyDownCapture={() => {
                  setAnimateToggle(false)
                  expandedWidthRef.current = leftPanelRef.current?.getSize().inPixels ?? null
                }}
              />
            </>
          ) : null}

          <ResizablePanel
            id={`pane-${storageId}-center`}
            // A CSS-length sibling has no percentage to subtract, so the center
            // is left unsized and the library auto-assigns it the remainder.
            defaultSize={centerPaneSize({
              left: leftPane?.defaultSize,
              hasLeft: Boolean(leftPane),
              right: rightPane?.defaultSize,
              hasRight: Boolean(rightPane),
              leftFallback: DEFAULT_LEFT_SIZE,
              rightFallback: DEFAULT_RIGHT_SIZE,
            })}
            minSize={`${DEFAULT_CENTER_MIN}%`}
          >
            <div
              className={cn("flex h-full min-w-0 flex-1 flex-col overflow-hidden", centerClassName)}
              data-testid={`feature-shell-${storageId}-center`}
            >
              {headerPlacement === "center" ? (
                <>
                  {desktopHeader}
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
                </>
              ) : (
                children
              )}
            </div>
          </ResizablePanel>

          {rightPane ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                id={`pane-${storageId}-right`}
                defaultSize={paneSize(rightPane.defaultSize, DEFAULT_RIGHT_SIZE)}
                minSize={paneSize(rightPane.minSize, DEFAULT_RIGHT_MIN)}
                maxSize={paneSize(rightPane.maxSize, DEFAULT_RIGHT_MAX)}
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
  const leftTrigger = leftPane ? leftPane.overlayTrigger !== false : false
  const rightTrigger = rightPane ? rightPane.overlayTrigger !== false : false
  const showStrip = leftTrigger || rightTrigger

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

      {showStrip ? (
        <div
          className="flex min-h-9 shrink-0 items-center justify-between border-b border-border/60 bg-muted/20 px-2"
          data-testid={`feature-shell-${storageId}-pane-controls`}
        >
          {leftPane && leftTrigger ? <OverlayPane pane={leftPane} side="left" trigger /> : <span />}
          {rightPane && rightTrigger ? <OverlayPane pane={rightPane} side="right" trigger /> : null}
        </div>
      ) : null}
      {leftPane && !leftTrigger ? <OverlayPane pane={leftPane} side="left" /> : null}
      {rightPane && !rightTrigger ? <OverlayPane pane={rightPane} side="right" /> : null}

      <div
        className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", centerClassName)}
        data-testid={`feature-shell-${storageId}-center`}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * One side pane in the overlay tiers: a Sheet, with or without the strip
 * trigger. Every Sheet is titled with the pane label (visually hidden), so a
 * screen reader announces what opened instead of an unnamed dialog.
 */
function OverlayPane({
  pane,
  side,
  trigger = false,
}: {
  pane: FeaturePaneConfig
  side: "left" | "right"
  trigger?: boolean
}) {
  const t = useTranslations("featureShell")
  const Icon = side === "left" ? PanelLeftIcon : PanelRightIcon
  return (
    <Sheet open={pane.open} onOpenChange={pane.onOpenChange}>
      {trigger ? (
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t(side === "left" ? "openLeft" : "openRight", { name: pane.label })}
          >
            <Icon className="size-4" />
          </Button>
        </SheetTrigger>
      ) : null}
      <SheetContent
        side={side}
        showCloseButton={pane.overlayCloseButton !== false}
        className={cn(
          "p-0",
          pane.mobileWidthClass ?? (side === "left" ? "w-[280px]" : "w-[320px]")
        )}
      >
        <SheetTitle className="sr-only">{pane.label}</SheetTitle>
        <div className="flex h-full flex-col overflow-hidden">{pane.content}</div>
      </SheetContent>
    </Sheet>
  )
}
