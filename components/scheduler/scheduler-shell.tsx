"use client"

/**
 * Responsive scheduler shell — owns the page's three layout tiers (mirrors
 * `components/inbox/inbox-shell.tsx`):
 *
 *   - ≥ 1024 px (desktop): a `ResizablePanelGroup` with a draggable split
 *     between the task list (sidebar content) and the detail pane; splits
 *     persist via `useResizableLayout("scheduler-panels")`. The shadcn
 *     `<Sidebar>` chrome is *not* rendered — `SchedulerSidebarContent` lives
 *     in panel 1 — but `SidebarProvider` stays mounted (controlled) so the
 *     header's `SidebarTrigger` (and its Ctrl/Cmd+B shortcut) collapses the
 *     list panel to zero width; the collapsed flag persists in localStorage.
 *     The upcoming rail renders as a fixed-width sibling *outside* the panel
 *     group (desktop-only, self-gated `xl:flex`), so it never crowds the
 *     split.
 *   - 768–1023 px (tablet): `SidebarProvider` + flex layout; the sidebar
 *     starts collapsed to free space for the detail pane; no rail.
 *   - < 768 px: not this shell. A compact viewport is redirected to
 *     `/me/scheduler` before this renders (ADR-0179 §6); the full-screen
 *     mobile overlay this shell used to carry was unreachable for that reason.
 *
 * Data, handlers, and dialogs stay in `app/scheduler/page.tsx` — this
 * component only arranges the rendered panes it is given.
 */

import { useCallback, useRef, useState } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"
import { useTranslations } from "next-intl"

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { useBreakpoint } from "@/hooks/ui"
import { useResizableLayout, type Layout } from "@/hooks/ui/use-resizable-layout"
import { cn } from "@/lib/utils"

/** localStorage key for the persisted desktop panel split. */
export const SCHEDULER_PANEL_STORAGE_KEY = "scheduler-panels"
/** localStorage key for the persisted desktop list-panel collapsed flag. */
export const SCHEDULER_LIST_COLLAPSED_KEY = "scheduler-list-collapsed"

// Match SettingsShell's navigation width, including the user's font scale.
const LIST_WIDTH = "15rem"
const PANEL_BOUNDS = { listMax: 45, detailMin: 40 } as const

function readCollapsedFlag(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(SCHEDULER_LIST_COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

function writeCollapsedFlag(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SCHEDULER_LIST_COLLAPSED_KEY, collapsed ? "1" : "0")
  } catch {
    // storage may be unavailable (private mode, quota); ignore
  }
}

export interface SchedulerShellProps {
  /**
   * Render prop for the task list: `"chrome"` wraps it in the collapsible
   * `<Sidebar>` (tablet/mobile); `"content"` renders the bare sections for
   * the desktop resizable panel.
   */
  sidebar: (variant: "chrome" | "content") => React.ReactNode
  /** Content header (contains SidebarTrigger — must stay inside the provider). */
  header: React.ReactNode
  /** Detail / dashboard pane content. */
  detail: React.ReactNode
  /** Desktop-only right rail (self-gated `xl:flex`); omitted on tablet. */
  rail?: React.ReactNode
}

function DesktopSchedulerShell({ sidebar, header, detail, rail }: SchedulerShellProps) {
  const t = useTranslations("scheduler")
  const { defaultLayout, onLayoutChanged } = useResizableLayout(SCHEDULER_PANEL_STORAGE_KEY)
  const [initialCollapsed] = useState(readCollapsedFlag)
  const [initialLayout] = useState(() =>
    initialCollapsed ? { "scheduler-list": 0, "scheduler-detail": 100 } : defaultLayout
  )
  const liveLayoutRef = useRef<Layout | undefined>(defaultLayout)
  const listPanelRef = useRef<PanelImperativeHandle | null>(null)
  const [isListCollapsed, setIsListCollapsed] = useState(initialCollapsed)
  const previousCollapsedRef = useRef(initialCollapsed)
  const [animateToggle, setAnimateToggle] = useState(false)

  const handleSidebarOpenChange = useCallback((open: boolean) => {
    setAnimateToggle(true)
    setIsListCollapsed(!open)
    writeCollapsedFlag(!open)
  }, [])

  // Keep the group and its children mounted: changing a key loses scroll,
  // focus and detail state, and gives the browser no geometry to interpolate.
  useIsomorphicLayoutEffect(() => {
    if (previousCollapsedRef.current === isListCollapsed) return
    previousCollapsedRef.current = isListCollapsed
    const panel = listPanelRef.current
    if (isListCollapsed) panel?.collapse()
    else {
      const saved = liveLayoutRef.current?.["scheduler-list"]
      panel?.resize(saved && saved > 0 ? `${saved}%` : LIST_WIDTH)
    }
  }, [isListCollapsed])

  const handleLayoutChanged = useCallback(
    (next: Layout) => {
      // Dragging past the minimum can also collapse the panel. Keep the
      // trigger and persisted flag in sync, but never save the zero split.
      if (next["scheduler-list"] === 0) {
        setIsListCollapsed(true)
        writeCollapsedFlag(true)
        return
      }
      if (isListCollapsed) return
      liveLayoutRef.current = next
      onLayoutChanged(next)
    },
    [isListCollapsed, onLayoutChanged]
  )

  return (
    // SidebarProvider supplies the useSidebar() context that the
    // SidebarTrigger inside the header depends on; the sidebar *content*
    // renders in panel 1 rather than the offcanvas chrome, so the trigger is
    // wired to the panel-collapse state instead of the offcanvas state.
    <SidebarProvider
      open={!isListCollapsed}
      onOpenChange={handleSidebarOpenChange}
      data-bg-target="chat"
      className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden"
    >
      <ResizablePanelGroup
        orientation="horizontal"
        className={cn(
          "min-h-0 flex-1",
          // v4 sizes the outer [data-panel] elements; className on Panel
          // styles its inner scroller. Only toggles animate, never dragging.
          animateToggle &&
            "[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-200 [&>[data-panel]]:ease-out"
        )}
        onTransitionEnd={(event) => {
          if (event.propertyName === "flex-grow") setAnimateToggle(false)
        }}
        defaultLayout={initialLayout}
        onLayoutChanged={handleLayoutChanged}
      >
        <ResizablePanel
          id="scheduler-list"
          panelRef={listPanelRef}
          groupResizeBehavior="preserve-pixel-size"
          collapsible
          collapsedSize="0%"
          defaultSize={initialCollapsed ? "0%" : LIST_WIDTH}
          minSize={LIST_WIDTH}
          maxSize={`${PANEL_BOUNDS.listMax}%`}
          style={{ overflow: "hidden" }}
          className={cn(
            "flex flex-col overflow-hidden text-sidebar-foreground",
            // The sidebar tint, as glass inside a wallpaper (see globals.css
            // `--sidebar-pane-bg`).
            "bg-[var(--sidebar-pane-bg,var(--sidebar))] [backdrop-filter:var(--sidebar-pane-filter,none)]",
            !isListCollapsed && "border-e"
          )}
          data-testid="scheduler-list-pane"
          data-collapsed={isListCollapsed || undefined}
        >
          <div
            className="flex h-full min-h-0 min-w-[15rem] flex-col"
            inert={isListCollapsed}
            aria-hidden={isListCollapsed || undefined}
          >
            {sidebar("content")}
          </div>
        </ResizablePanel>
        <ResizableHandle
          withHandle
          onPointerDownCapture={() => setAnimateToggle(false)}
          onKeyDownCapture={() => setAnimateToggle(false)}
          aria-label={t("resize.listHandle")}
          className={cn(isListCollapsed && "hidden")}
        />
        <ResizablePanel
          id="scheduler-detail"
          defaultSize="100%"
          style={{ overflow: "hidden" }}
          minSize={`${PANEL_BOUNDS.detailMin}%`}
          className="flex min-w-0 flex-col overflow-hidden"
          data-testid="scheduler-detail-pane"
          data-bg-target="chat"
        >
          {header}
          <div className="min-h-0 flex-1 overflow-auto">{detail}</div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {rail}
    </SidebarProvider>
  )
}

export function SchedulerShell(props: SchedulerShellProps) {
  const { sidebar, header, detail } = props
  const breakpoint = useBreakpoint()

  if (breakpoint === "desktop") {
    return <DesktopSchedulerShell {...props} />
  }

  // Tablet two-pane layout; the rail is intentionally not rendered below the
  // desktop tier. A mobile breakpoint never reaches this shell (see above);
  // if it did, the collapsed-list tablet layout is the honest fallback.
  return (
    <SidebarProvider
      defaultOpen={false}
      style={{ "--sidebar-width": LIST_WIDTH } as React.CSSProperties}
      data-bg-target="chat"
      className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden"
    >
      <div className="flex h-full w-full min-w-0 flex-1">
        {sidebar("chrome")}
        <SidebarInset data-bg-target="chat">
          {header}
          <div className="min-h-0 flex-1 overflow-auto">{detail}</div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  )
}
