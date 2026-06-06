"use client"

/**
 * Responsive scheduler shell — owns the page's three layout tiers (mirrors
 * `components/inbox/inbox-shell.tsx`):
 *
 *   - ≥ 1024 px (desktop): a `ResizablePanelGroup` with a draggable split
 *     between the task list (sidebar content) and the detail pane; splits
 *     persist via `useResizableLayout("scheduler-panels")`. The shadcn
 *     `<Sidebar>` chrome is *not* rendered — `SchedulerSidebarContent` lives
 *     in panel 1 — but `SidebarProvider` stays mounted so `SidebarTrigger`s
 *     inside the header keep a valid `useSidebar()` context. The upcoming
 *     rail renders as a fixed-width sibling *outside* the panel group
 *     (desktop-only, self-gated `xl:flex`), so it never crowds the split.
 *   - 768–1023 px (tablet): `SidebarProvider` + flex layout; the sidebar
 *     starts collapsed to free space for the detail pane; no rail.
 *   - < 768 px (mobile): single pane; selecting a task pushes a full-screen
 *     detail overlay (AnimatePresence slide-in, reduced-motion aware).
 *
 * Data, handlers, and dialogs stay in `app/scheduler/page.tsx` — this
 * component only arranges the rendered panes it is given.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useState } from "react"
import { useTranslations } from "next-intl"

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { useBreakpoint } from "@/hooks/ui"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import { cn } from "@/lib/utils"

/** localStorage key for the persisted desktop panel split. */
export const SCHEDULER_PANEL_STORAGE_KEY = "scheduler-panels"

const PANEL_DEFAULTS = { list: 24, detail: 76 } as const
const PANEL_BOUNDS = { listMin: 16, listMax: 40, detailMin: 40 } as const

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
  /** Desktop-only right rail (self-gated `xl:flex`); omitted on tablet/mobile. */
  rail?: React.ReactNode
  /** Full-screen mobile detail content; rendered when `isMobileDetailOpen`. */
  mobileDetail?: React.ReactNode
  /** Whether the mobile push-detail overlay is open. */
  isMobileDetailOpen?: boolean
}

function DesktopSchedulerShell({ sidebar, header, detail, rail }: SchedulerShellProps) {
  const t = useTranslations("scheduler")
  const { defaultLayout, onLayoutChanged } = useResizableLayout(SCHEDULER_PANEL_STORAGE_KEY)
  // Seed once at mount; the panel group owns live sizes thereafter.
  const [initialLayout] = useState<Record<string, number> | undefined>(() => defaultLayout)

  return (
    // SidebarProvider supplies the useSidebar() context that the (hidden on
    // desktop) SidebarTrigger inside the header depends on; the sidebar
    // *content* renders in panel 1 rather than the offcanvas chrome.
    <SidebarProvider
      data-bg-target="chat"
      className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden"
    >
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={initialLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="scheduler-list"
          defaultSize={`${PANEL_DEFAULTS.list}%`}
          minSize={`${PANEL_BOUNDS.listMin}%`}
          maxSize={`${PANEL_BOUNDS.listMax}%`}
          className="flex flex-col overflow-hidden border-e bg-sidebar text-sidebar-foreground"
          data-testid="scheduler-list-pane"
        >
          {sidebar("content")}
        </ResizablePanel>
        <ResizableHandle withHandle aria-label={t("resize.listHandle")} />
        <ResizablePanel
          id="scheduler-detail"
          defaultSize={`${PANEL_DEFAULTS.detail}%`}
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
  const { sidebar, header, detail, mobileDetail, isMobileDetailOpen = false } = props
  const breakpoint = useBreakpoint()
  const prefersReducedMotion = useReducedMotion()

  if (breakpoint === "desktop") {
    return <DesktopSchedulerShell {...props} />
  }

  const isMobile = breakpoint === "mobile"
  const isTablet = breakpoint === "tablet"
  const showOverlay = isMobile && isMobileDetailOpen

  return (
    <SidebarProvider
      defaultOpen={!isTablet}
      data-bg-target="chat"
      className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden"
    >
      {/* Mobile detail view — full-screen push. */}
      <AnimatePresence>
        {showOverlay && (
          <motion.div
            key="mobile-detail"
            data-testid="scheduler-mobile-detail-shell"
            className="absolute inset-0 z-30 bg-background"
            {...(prefersReducedMotion
              ? {}
              : {
                  initial: { x: "100%" },
                  animate: { x: 0 },
                  exit: { x: "100%" },
                  transition: { duration: 0.22, ease: "easeOut" },
                })}
          >
            {mobileDetail}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tablet two-pane / mobile list layout. The rail is intentionally not
          rendered below the desktop tier. */}
      <div className={cn("flex h-full w-full min-w-0 flex-1", showOverlay && "hidden")}>
        {sidebar("chrome")}
        <SidebarInset data-bg-target="chat">
          {header}
          <div className="min-h-0 flex-1 overflow-auto">{detail}</div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  )
}
