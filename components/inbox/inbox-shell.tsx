"use client"

/**
 * Three-pane Inbox shell: left sidebar (InboxSidebar), middle conversation
 * list (ConversationList), right detail (children).
 *
 * Responsive behaviour (driven by the shared `useBreakpoint()` hook):
 *   - ≥ 1024 px (desktop): a `ResizablePanelGroup` whose three panels
 *     (sidebar / list / detail) are draggable and whose sizes persist via
 *     `useInboxLayoutStore`. The shadcn `<Sidebar>` chrome is *not* rendered
 *     here — the sidebar's inner content (`<InboxSidebarContent />`) lives in
 *     panel 1 instead — but we still mount `SidebarProvider` so the
 *     `md:hidden` `SidebarTrigger`s inside the list/header keep a valid
 *     `useSidebar()` context.
 *   - 768–1023 px (tablet): `SidebarProvider` + flex layout; sidebar starts
 *     collapsed to free space for the detail pane.
 *   - < 768 px (mobile): single-pane stack. Either the list (full-width) when
 *     no conversation is selected, or the detail pane when `conversationKey`
 *     is set. `InboxSidebar` becomes an offcanvas Sheet automatically.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { InboxIcon, Settings2Icon } from "lucide-react"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { useBreakpoint } from "@/hooks/ui"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import {
  useInboxLayoutStore,
  INBOX_LAYOUT_BOUNDS,
  INBOX_LAYOUT_DEFAULTS,
} from "@/stores/inbox/inbox-layout-store"
import { InboxSidebar, InboxSidebarContent } from "./inbox-sidebar"
import { ConversationList } from "./conversation-list"
import { InboxNoticeArea } from "./notices/notice-area"
import { StateCard } from "./state/state-card"
import { useInboxWriteRoute } from "@/lib/connectors/inbox-writes"
import { isTauri } from "@/lib/platform/detect"

export type InboxView = "all" | "by-adapter" | "by-platform" | "conversation"

export interface InboxShellProps {
  /** Which inbox view is active — drives sidebar highlight + list filter. */
  view: InboxView
  /** Adapter-scoped view: only this adapter's conversations are shown. */
  adapterId?: string
  /** Platform-scoped view: conversations for all adapters of one platform. */
  platformKind?: string
  /** Conversation view: only this conversation's messages are shown. */
  conversationKey?: string
  /** Right-pane content (typically the ChatSession view). */
  children?: React.ReactNode
}

/** Detail-pane content with a subtle mount-in slide (each conversation route
 * mounts a fresh shell, so this animates on open). Reduced-motion aware. */
function DetailContent({
  children,
  emptyPrompt,
}: {
  children?: React.ReactNode
  emptyPrompt: string
}) {
  const transition = useReducedMotionTransition(mobileTransition("fast"))
  return (
    <motion.div
      className="flex min-h-0 flex-1 flex-col"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
    >
      {children ?? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {emptyPrompt}
        </div>
      )}
    </motion.div>
  )
}

function DesktopInboxShell({
  view,
  adapterId,
  platformKind,
  conversationKey,
  children,
  emptyPrompt,
}: InboxShellProps & { emptyPrompt: string }) {
  const t = useTranslations("inbox.shell")
  const setSizes = useInboxLayoutStore((s) => s.setSizes)
  // Seed the persisted layout once at mount; the panel group owns live sizes
  // thereafter and pushes settled splits back through `setSizes`.
  const [initialLayout] = useState<Record<string, number>>(() => {
    const { sidebarSize, listSize, detailSize } = useInboxLayoutStore.getState()
    return {
      "inbox-sidebar": sidebarSize,
      "inbox-list": listSize,
      "inbox-detail": detailSize,
    }
  })
  const { sidebarMin, sidebarMax, listMin, listMax, detailMin } = INBOX_LAYOUT_BOUNDS

  return (
    // SidebarProvider supplies the useSidebar() context the (hidden on desktop)
    // SidebarTriggers depend on; we render the sidebar *content* in panel 1
    // rather than the offcanvas <Sidebar> chrome.
    <SidebarProvider
      data-bg-target="chat"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden safe-area-pt safe-area-pb"
    >
      {/* Every other feature route mounts this band, and `/inbox` was the one
       * that did not: no title, no breadcrumb, no page-level action slot, so it
       * read as a different application from `/scheduler` beside it. The header
       * is here rather than in the route files because all five inbox routes
       * mount this shell, and putting it in each of them is how it would drift.
       *
       * Desktop only. The mobile branch below is a single pane whose own
       * `MobileInboxBody` already carries a segmented switcher, and a second
       * band above it would cost a phone two rows of chrome for one title. */}
      <FeaturePageHeader
        variant="management"
        testId="inbox-header"
        icon={<InboxIcon />}
        title={t("pageTitle")}
        description={t("pageDescription")}
        primaryAction={{
          id: "connector-settings",
          label: t("openSettings"),
          icon: Settings2Icon,
          href: "/me/connectors",
          testId: "inbox-open-connector-settings",
        }}
      />
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={initialLayout}
        onLayoutChanged={(next: Record<string, number>) => {
          const s = next["inbox-sidebar"]
          const l = next["inbox-list"]
          const d = next["inbox-detail"]
          if (typeof s === "number" && typeof l === "number" && typeof d === "number") {
            setSizes([s, l, d])
          }
        }}
      >
        <ResizablePanel
          id="inbox-sidebar"
          defaultSize={`${INBOX_LAYOUT_DEFAULTS.sidebarSize}%`}
          minSize={`${sidebarMin}%`}
          maxSize={`${sidebarMax}%`}
          className="flex flex-col overflow-hidden border-e"
          data-testid="inbox-sidebar-pane"
        >
          <InboxSidebarContent
            view={view}
            activeAdapterId={adapterId}
            activePlatformKind={platformKind}
          />
        </ResizablePanel>
        <ResizableHandle withHandle aria-label={t("resize.sidebarHandle")} />
        <ResizablePanel
          id="inbox-list"
          defaultSize={`${INBOX_LAYOUT_DEFAULTS.listSize}%`}
          minSize={`${listMin}%`}
          maxSize={`${listMax}%`}
          className="flex flex-col overflow-hidden border-e"
          data-testid="inbox-conversation-list-pane"
        >
          <ConversationList
            adapterId={adapterId}
            platformKind={platformKind}
            activeConversationKey={conversationKey}
          />
        </ResizablePanel>
        <ResizableHandle withHandle aria-label={t("resize.detailHandle")} />
        <ResizablePanel
          id="inbox-detail"
          defaultSize={`${INBOX_LAYOUT_DEFAULTS.detailSize}%`}
          minSize={`${detailMin}%`}
          className="flex min-w-0 flex-col overflow-hidden"
          data-testid="inbox-detail-pane"
          data-bg-target="chat"
        >
          <InboxNoticeArea conversationKey={conversationKey} />
          <DetailContent emptyPrompt={emptyPrompt}>{children}</DetailContent>
        </ResizablePanel>
      </ResizablePanelGroup>
      {/* ⌘K is the unified global search (ADR-0129); platform-bound
          conversations are one of its providers, so no inbox-local palette. */}
    </SidebarProvider>
  )
}

export function InboxShell({
  view,
  adapterId,
  platformKind,
  conversationKey,
  children,
}: InboxShellProps) {
  const t = useTranslations("inbox.shell")
  const breakpoint = useBreakpoint()
  const writeRoute = useInboxWriteRoute()
  const router = useRouter()

  // ADR-0131 §2.2 — a standalone browser tab or an unpaired phone has no
  // connector runtime and no host to relay to, so every Inbox write is
  // impossible here. Rendering the normal shell would show an empty list that
  // reads as "you have no conversations" and reply controls that silently do
  // nothing. Say so instead, and point at pairing.
  //
  // Deliberately NOT applied on the desktop: a Tauri window always has a
  // runtime (or is driving a remote host), so `"unavailable"` there means the
  // runtime is still booting, and swapping the whole shell out mid-boot would
  // flash this card on every cold start.
  if (writeRoute === "unavailable" && !isTauri()) {
    return (
      <div
        className="flex h-full min-h-0 flex-1 items-center justify-center overflow-auto safe-area-pt safe-area-pb"
        data-testid="inbox-requires-host"
      >
        <StateCard.RequiresHost onPair={() => router.push("/pair")} />
      </div>
    )
  }

  if (breakpoint === "desktop") {
    return (
      <DesktopInboxShell
        view={view}
        adapterId={adapterId}
        platformKind={platformKind}
        conversationKey={conversationKey}
        emptyPrompt={t("selectPrompt")}
      >
        {children}
      </DesktopInboxShell>
    )
  }

  const isMobile = breakpoint === "mobile"
  const isTablet = breakpoint === "tablet"

  // Mobile single-pane rule: when a conversation is selected we show only the
  // detail pane; otherwise we show only the list. Tablet keeps both panes.
  const showList = !isMobile || !conversationKey
  const showDetail = !isMobile || Boolean(conversationKey)

  return (
    <SidebarProvider
      defaultOpen={!isTablet}
      data-bg-target="chat"
      className="flex h-full min-h-0 flex-1 overflow-hidden safe-area-pt safe-area-pb"
      style={{ "--sidebar-width": "14rem" } as React.CSSProperties}
    >
      {/* Left pane — adapter sections + view-mode chips */}
      <InboxSidebar view={view} activeAdapterId={adapterId} activePlatformKind={platformKind} />

      {/* Middle pane — conversation list. Full-width on mobile when no
       * conversation is selected; fixed responsive widths on md+. */}
      <div
        data-testid="inbox-conversation-list-pane"
        className={cn(
          "w-full md:w-64 lg:w-72 shrink-0 border-e flex flex-col overflow-hidden",
          !showList && "hidden md:flex"
        )}
      >
        <ConversationList
          adapterId={adapterId}
          platformKind={platformKind}
          activeConversationKey={conversationKey}
        />
      </div>

      {/* Right pane — conversation detail / children */}
      <SidebarInset
        data-testid="inbox-detail-pane"
        data-bg-target="chat"
        className={cn(
          "flex flex-col flex-1 min-w-0 overflow-hidden",
          !showDetail && "hidden md:flex"
        )}
      >
        <InboxNoticeArea conversationKey={conversationKey} />
        <DetailContent emptyPrompt={t("selectPrompt")}>{children}</DetailContent>
      </SidebarInset>
    </SidebarProvider>
  )
}
