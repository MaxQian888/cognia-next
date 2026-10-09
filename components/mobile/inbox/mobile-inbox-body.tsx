"use client"

/**
 * Mobile-native Inbox body.
 *
 * The compact branch of every Inbox list route (`/inbox/{all,drafts,adapter,
 * platform}`). A thin segmented switcher over two surfaces that already exist
 * and are tested:
 *
 *   - 消息 (Messages) → the responsive `InboxShell` list (offcanvas sidebar,
 *     search, filter chips, tap-through to the chat).
 *   - 草稿 (Drafts)   → the mobile `DraftApprovalPanel` (swipe-approve /
 *     swipe-reject + pull-to-refresh).
 *
 * A scoped route (`adapterId` / `platformKind`) scopes the Messages list and
 * shows the scope as a dismissible chip under the header; dismissing it goes
 * back to the unscoped `/inbox/all`. Without it a phone that followed a
 * section or sidebar link had no visible sign the list was filtered, and no
 * way out but Back.
 *
 * Sizing: `/inbox` is a viewport-owning route (`lib/shell/full-viewport-routes.ts`),
 * so the compact shell gives this column a definite height and reserves the
 * tab bar below it. The body therefore fills (`h-full`), applies the TOP
 * safe-area inset once on its own header, and embeds the shell with
 * `embedded` so it adds none. It used to be `h-[100dvh]` (ignoring the tab
 * bar) with the inset applied here AND again by the shell.
 *
 * The active tab is local state seeded by the route, so a `/inbox/drafts`
 * deep-link opens on Drafts while in-page switching stays instant.
 *
 * "Select" (Messages tab, phone width) puts the list in selection mode: taps
 * check rows and a bulk dock appears as the column's last row, directly above
 * the tab bar. "Done" (or a bulk action that fully lands) leaves it.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckSquareIcon, XIcon } from "lucide-react"

import { InboxErrorBoundary } from "@/components/inbox/inbox-error-boundary"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { DraftApprovalPanel } from "@/components/mobile/connector/draft-approval-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PlatformBadge } from "@/components/inbox/platform-badge"
import { useAdapterInstance } from "@/hooks/connectors/use-adapter-instance"
import { useBreakpoint } from "@/hooks/ui"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { listAllPendingDrafts } from "@/lib/db/connector-drafts"
import { loggers } from "@cognia/logging"

const log = loggers.ui

/**
 * Pending-draft count for the tab badge. The badge is decoration on the tab
 * header, so a failed read degrades to "no badge" instead of throwing out of
 * `useLiveQuery` into the route-wide boundary (which would blank both tabs).
 * The live query re-runs on the next drafts-table change, so the badge
 * recovers on its own once the database does.
 */
export async function countPendingDraftsForBadge(): Promise<number> {
  try {
    return (await listAllPendingDrafts()).length
  } catch (error) {
    log.warn("mobile inbox: pending-draft count unavailable", {
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}

export type MobileInboxTab = "messages" | "drafts"

export interface MobileInboxBodyProps {
  initialTab?: MobileInboxTab
  /** `/inbox/adapter`: scope the Messages list to one adapter. */
  adapterId?: string
  /** `/inbox/platform`: scope the Messages list to one platform. */
  platformKind?: string
}

/** The scope a scoped route shows, as a chip that clears it. */
function MobileInboxScopeChip({
  adapterId,
  platformKind,
}: {
  adapterId?: string
  platformKind?: string
}) {
  const t = useTranslations("mobile.inbox.scope")
  const tPlatform = useTranslations("inbox.platformBadge")
  const router = useRouter()
  const adapter = useAdapterInstance(adapterId)
  const platform = (adapter?.type ?? platformKind) as PlatformKind | undefined
  const name = adapterId
    ? (adapter?.displayName ?? adapterId)
    : platformKind && tPlatform.has(`names.${platformKind}`)
      ? tPlatform(`names.${platformKind}`)
      : (platformKind ?? "")

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5"
      data-testid="mobile-inbox-scope"
    >
      <span className="text-xs text-muted-foreground">
        {adapterId ? t("adapter") : t("platform")}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 rounded-pill bg-secondary py-0.5 ps-2 pe-0.5 text-xs font-medium">
        {platform ? (
          <span aria-hidden className="contents">
            <PlatformBadge platform={platform} iconOnly />
          </span>
        ) : null}
        <span className="truncate" data-testid="mobile-inbox-scope-name">
          {name}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // 44px touch target around a 20px glyph.
          className="relative size-5 rounded-full after:absolute after:-inset-3"
          onClick={() => router.push("/inbox/all")}
          aria-label={t("clear", { name })}
          data-testid="mobile-inbox-scope-clear"
        >
          <XIcon className="size-3" aria-hidden />
        </Button>
      </span>
    </div>
  )
}

export function MobileInboxBody({
  initialTab = "messages",
  adapterId,
  platformKind,
}: MobileInboxBodyProps) {
  const t = useTranslations("mobile.inbox")
  const [tab, setTab] = useState<MobileInboxTab>(initialTab)
  const [selecting, setSelecting] = useState(false)
  // Reported by the shell: false while there is no host, while loading, and
  // for an empty scope, so "Select" never offers to pick from nothing.
  const [selectable, setSelectable] = useState(false)
  const draftCount = useLiveQuery(countPendingDraftsForBadge, []) ?? 0
  const scoped = Boolean(adapterId || platformKind)
  // The compact body also serves a Capacitor tablet, where the shell draws
  // the tablet layout (checkboxes on the rows, the bulk bar in the list
  // header) and this phone-only toggle would do nothing.
  const phone = useBreakpoint() === "mobile"
  const canSelect = phone && tab === "messages" && selectable

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value as MobileInboxTab)
        setSelecting(false)
      }}
      className="flex h-full min-h-0 flex-1 flex-col gap-0"
      data-testid="mobile-inbox-body"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 safe-area-pt">
        <h1 className="text-sm font-semibold">{t("title")}</h1>
        {canSelect ? (
          <Button
            type="button"
            variant={selecting ? "secondary" : "ghost"}
            size="sm"
            // 44px touch target around a compact header control.
            className="relative ml-auto h-8 gap-1.5 px-2.5 text-xs after:absolute after:-inset-y-1.5 after:inset-x-0"
            onClick={() => setSelecting((value) => !value)}
            aria-pressed={selecting}
            data-testid="mobile-inbox-select"
          >
            {selecting ? null : <CheckSquareIcon className="size-3.5" aria-hidden />}
            {selecting ? t("selection.done") : t("selection.select")}
          </Button>
        ) : null}
        <TabsList aria-label={t("tabsAria")} className={canSelect ? "h-8" : "ml-auto h-8"}>
          <TabsTrigger
            value="messages"
            className="h-7 px-3 text-xs"
            data-testid="mobile-inbox-tab-messages"
          >
            {t("tabs.messages")}
          </TabsTrigger>
          <TabsTrigger
            value="drafts"
            className="h-7 px-3 text-xs"
            data-testid="mobile-inbox-tab-drafts"
          >
            {t("tabs.drafts")}
            {draftCount > 0 ? (
              <Badge
                variant="secondary"
                className="h-4 min-w-4 justify-center px-1 text-[10px] leading-none"
                data-testid="mobile-inbox-tab-drafts-badge"
              >
                {draftCount > 99 ? t("tabs.draftCountOverflow") : draftCount}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>
      </header>

      <TabsContent value="messages" className="flex min-h-0 flex-col overflow-hidden">
        {scoped ? <MobileInboxScopeChip adapterId={adapterId} platformKind={platformKind} /> : null}
        <InboxShell
          view={adapterId ? "by-adapter" : platformKind ? "by-platform" : "all"}
          adapterId={adapterId}
          platformKind={platformKind}
          embedded
          touchSelecting={canSelect && selecting}
          onTouchSelectingChange={setSelecting}
          onSelectableChange={setSelectable}
        />
      </TabsContent>
      <TabsContent value="drafts" className="min-h-0 overflow-hidden">
        {/* Pane-level containment, matching the InboxShell panes: a failed
            drafts read shows Retry here while the Messages tab keeps working. */}
        <InboxErrorBoundary>
          <DraftApprovalPanel />
        </InboxErrorBoundary>
      </TabsContent>
    </Tabs>
  )
}
