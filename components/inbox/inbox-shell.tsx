"use client"

/**
 * Inbox shell: sidebar (InboxSidebar), conversation list (ConversationList)
 * and the triage pane (TriagePreviewPane, or the route's own `children`).
 *
 * The shell owns the shared state and hands it down:
 *  - `useConversationRows` — one live query for the list AND the triage
 *    pane's empty-state counts, so the two cannot disagree.
 *  - `useInboxUrlState` — grouping, filters and the previewed session live in
 *    the URL (`?group=`, `?f=`, `?preview=`), so a preview survives the route
 *    remount every scope change causes, deep-links, and comes back on Back.
 *
 * Responsive behaviour (driven by the shared `useBreakpoint()` hook):
 *   - ≥ 1024 px (desktop): a `ResizablePanelGroup` whose three panels
 *     (sidebar / list / triage) are draggable and whose sizes persist via
 *     `useInboxLayoutStore`. The shadcn `<Sidebar>` chrome is *not* rendered
 *     here — the sidebar's inner content lives in panel 1 — but we still
 *     mount `SidebarProvider` for the `useSidebar()` context.
 *   - 768–1023 px (tablet): list (w-72) + triage pane; the sidebar is
 *     off-canvas (starts closed) behind the list header's trigger.
 *   - < 768 px (phone): the list alone. A tap opens the chat directly; a
 *     long-press opens the row's action sheet, whose "Preview" shows the
 *     triage pane in a bottom drawer (`triage-preview-drawer.tsx`).
 *
 * Click selects into the pane; double-click / Enter / "Reply in chat" opens
 * the full chat through `/inbox/c`, which redirects into the chat workspace.
 * The pane has no read side effects (see `triage-preview-pane.tsx`).
 *
 * `embedded`: the compact `MobileInboxBody` hosts this shell under its own
 * header, which already applies the top safe-area inset, inside a compact
 * shell that already reserves the bottom one. Applying them again here
 * doubled both.
 */

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { InboxIcon, Settings2Icon } from "lucide-react"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { useBreakpoint } from "@/hooks/ui"
import { useConversationRows } from "@/hooks/inbox/use-conversation-rows"
import { useInboxUrlState } from "@/hooks/inbox/use-inbox-url-state"
import { useInboxAdapters } from "@/hooks/inbox/use-inbox-adapters"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { inboxSessionHref } from "@/lib/inbox/conversation-href"
import {
  summarizeConversationRows,
  type ConversationRowItem,
} from "@/lib/inbox/conversation-grouping"
import {
  useInboxLayoutStore,
  INBOX_LAYOUT_BOUNDS,
  INBOX_LAYOUT_DEFAULTS,
} from "@/stores/inbox/inbox-layout-store"
import { InboxSidebar, InboxSidebarContent, type InboxView } from "./inbox-sidebar"
import { ConversationList, type ConversationSelectionMode } from "./conversation-list"
import { InboxErrorBoundary } from "./inbox-error-boundary"
import { InboxNoticeArea } from "./notices/notice-area"
import { StateCard } from "./state/state-card"
import { TriagePreviewPane } from "./triage/triage-preview-pane"
import { TriagePreviewDrawer, type TriagePreviewTarget } from "./triage/triage-preview-drawer"
import { useInboxWriteRoute } from "@/lib/connectors/inbox-writes"
import { isTauri } from "@/lib/platform/detect"

export type { InboxView }

export interface InboxShellProps {
  /** Which inbox route is active — drives the sidebar's active destination. */
  view: InboxView
  /** Adapter-scoped view: only this adapter's conversations are shown. */
  adapterId?: string
  /** Platform-scoped view: conversations for all adapters of one platform. */
  platformKind?: string
  /**
   * The detail pane's resting content when nothing is previewed (the Draft
   * Center on `/inbox/drafts`). A preview replaces it; closing the preview
   * brings it back.
   */
  children?: React.ReactNode
  /** Hosted under a header that already owns the safe-area insets. */
  embedded?: boolean
  /**
   * Phone only: the host's "Select" toggle (`MobileInboxBody`'s header). While
   * on, a tap checks a row instead of opening it and the bulk dock shows.
   */
  touchSelecting?: boolean
  onTouchSelectingChange?: (selecting: boolean) => void
  /**
   * Phone only: told whether the list has rows a tap could check. The host's
   * "Select" toggle hides while it does not (no host to read from, still
   * loading, or nothing in scope), since there would be nothing to pick.
   */
  onSelectableChange?: (selectable: boolean) => void
}

/** Detail-pane content with a subtle mount-in slide. Reduced-motion aware. */
function DetailContent({ children, motionKey }: { children: React.ReactNode; motionKey: string }) {
  const transition = useReducedMotionTransition(mobileTransition("fast"))
  return (
    <motion.div
      key={motionKey}
      className="flex min-h-0 flex-1 flex-col"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
    >
      {children}
    </motion.div>
  )
}

export function InboxShell({
  view,
  adapterId,
  platformKind,
  children,
  embedded = false,
  touchSelecting = false,
  onTouchSelectingChange,
  onSelectableChange,
}: InboxShellProps) {
  const breakpoint = useBreakpoint()
  const writeRoute = useInboxWriteRoute()
  const router = useRouter()
  const url = useInboxUrlState()
  // Both reads capture their failures instead of throwing: they sit above the
  // per-pane error boundaries, and a throw here would blank the whole Inbox.
  const rowsState = useConversationRows({ adapterId, platformKind })
  const rows = rowsState.rows
  const adaptersState = useInboxAdapters()
  const adapters = adaptersState.adapters
  const summary = useMemo(() => (rows ? summarizeConversationRows(rows) : undefined), [rows])

  const isMobile = breakpoint === "mobile"
  const hostUnavailable = writeRoute === "unavailable" && !isTauri()
  const selectable = !hostUnavailable && (rows?.length ?? 0) > 0
  useEffect(() => {
    onSelectableChange?.(selectable)
  }, [onSelectableChange, selectable])
  const selectionMode: ConversationSelectionMode = isMobile ? "open" : "preview"
  // A phone has no pane; a stale `?preview=` from a wider window is ignored
  // there rather than hiding the list behind it.
  const previewSessionId = isMobile ? null : url.previewSessionId
  const previewKey = useMemo(
    () =>
      previewSessionId
        ? rows?.find((row) => row.session.id === previewSessionId)?.session.platformBinding
            ?.conversationKey
        : undefined,
    [rows, previewSessionId]
  )

  // The phone's preview drawer ("Preview" in a row's long-press sheet). Local
  // rather than `?preview=`: a phone ignores that param (see above), so a
  // stale one from a wider window can never pop a drawer open.
  const [drawerPreview, setDrawerPreview] = useState<TriagePreviewTarget | null>(null)

  const openInChat = (conversationKey: string, sessionId: string) =>
    router.push(inboxSessionHref(conversationKey, sessionId))
  const openRow = (row: ConversationRowItem) =>
    openInChat(row.session.platformBinding!.conversationKey, row.session.id)

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
  if (hostUnavailable) {
    return (
      <div
        className={cn(
          "flex h-full min-h-0 flex-1 items-center justify-center overflow-auto",
          !embedded && "safe-area-pt safe-area-pb"
        )}
        data-testid="inbox-requires-host"
      >
        <StateCard.RequiresHost onPair={() => router.push("/pair")} />
      </div>
    )
  }

  const sidebarProps = {
    view,
    grouping: url.grouping,
    onGroupingChange: url.setGrouping,
    adapters,
    adaptersError: adaptersState.error,
    onRetryAdapters: adaptersState.retry,
    activeAdapterId: adapterId,
    activePlatformKind: platformKind,
  }

  const list = (
    <InboxErrorBoundary key={`${adapterId ?? ""}:${platformKind ?? ""}`}>
      <ConversationList
        rows={rows}
        error={rowsState.error}
        onRetry={rowsState.retry}
        adapters={adapters}
        grouping={url.grouping}
        filters={url.filters}
        onToggleFilter={url.toggleFilter}
        onClearFilters={url.clearFilters}
        adapterId={adapterId}
        platformKind={platformKind}
        selectedSessionId={previewSessionId}
        selectionMode={selectionMode}
        onSelectSession={(row) => url.setPreview(row.session.id)}
        onOpenSession={openRow}
        onClearPreview={() => url.setPreview(null)}
        onPreviewSession={(row) =>
          setDrawerPreview({
            sessionId: row.session.id,
            conversationKey: row.session.platformBinding!.conversationKey,
            title: row.session.title || row.session.platformBinding!.conversationKey,
          })
        }
        touchSelecting={isMobile && touchSelecting}
        onTouchSelectingChange={onTouchSelectingChange}
      />
    </InboxErrorBoundary>
  )

  const detail = (
    <>
      {/* Adapter-wide notices stay at the top of the pane. The previewed
          conversation's drafts are listed inline by the pane, so the draft
          notice is suppressed rather than offering the same draft twice. */}
      <InboxErrorBoundary key={`notices:${previewKey ?? ""}`}>
        <InboxNoticeArea
          conversationKey={previewKey}
          suppressKinds={previewSessionId ? ["draft"] : undefined}
        />
      </InboxErrorBoundary>
      <InboxErrorBoundary key={`detail:${previewSessionId ?? ""}`}>
        <DetailContent motionKey={previewSessionId ?? (children ? "route" : "empty")}>
          {previewSessionId || !children ? (
            <TriagePreviewPane
              sessionId={previewSessionId}
              summary={summary}
              onOpenInChat={(conversation) =>
                openInChat(conversation.conversationKey, conversation.session.id)
              }
              onClose={() => url.setPreview(null)}
            />
          ) : (
            children
          )}
        </DetailContent>
      </InboxErrorBoundary>
    </>
  )

  if (breakpoint === "desktop") {
    return (
      <DesktopInboxShell
        sidebar={<InboxSidebarContent {...sidebarProps} />}
        list={list}
        embedded={embedded}
      >
        {detail}
      </DesktopInboxShell>
    )
  }

  const isTablet = breakpoint === "tablet"

  return (
    <SidebarProvider
      defaultOpen={!isTablet}
      data-bg-target="chat"
      className={cn(
        "flex h-full min-h-0 flex-1 overflow-hidden",
        !embedded && "safe-area-pt safe-area-pb"
      )}
      style={{ "--sidebar-width": "14rem" } as React.CSSProperties}
    >
      {/* Left pane — off-canvas on tablet (the list header's trigger opens
          it), a sheet on the phone. */}
      <InboxErrorBoundary>
        <InboxSidebar {...sidebarProps} />
      </InboxErrorBoundary>

      {/* Middle pane — the whole width on a phone, a fixed column on tablet. */}
      <div
        data-testid="inbox-conversation-list-pane"
        className="flex w-full shrink-0 flex-col overflow-hidden border-e md:w-72"
      >
        {list}
      </div>

      {/* Right pane — the triage preview. Tablet only: a phone opens the
          chat on a tap and previews in a drawer from the long-press sheet. */}
      {!isMobile ? (
        <SidebarInset
          data-testid="inbox-detail-pane"
          data-bg-target="chat"
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          {detail}
        </SidebarInset>
      ) : (
        <InboxErrorBoundary>
          <TriagePreviewDrawer
            target={drawerPreview}
            onClose={() => setDrawerPreview(null)}
            onOpenInChat={(conversationKey, sessionId) => {
              setDrawerPreview(null)
              openInChat(conversationKey, sessionId)
            }}
          />
        </InboxErrorBoundary>
      )}
    </SidebarProvider>
  )
}

function DesktopInboxShell({
  sidebar,
  list,
  children,
  embedded,
}: {
  sidebar: React.ReactNode
  list: React.ReactNode
  children: React.ReactNode
  embedded: boolean
}) {
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
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col overflow-hidden",
        !embedded && "safe-area-pt safe-area-pb"
      )}
    >
      {/* Every other feature route mounts this band. It is here rather than in
       * the route files because all inbox routes mount this shell, and putting
       * it in each of them is how it would drift. Desktop only: the compact
       * body carries its own header, and a second band would cost a phone two
       * rows of chrome for one title. */}
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
          <InboxErrorBoundary>{sidebar}</InboxErrorBoundary>
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
          {list}
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
          {children}
        </ResizablePanel>
      </ResizablePanelGroup>
      {/* ⌘K is the unified global search (ADR-0129); platform-bound
          conversations are one of its providers, so no inbox-local palette. */}
    </SidebarProvider>
  )
}
