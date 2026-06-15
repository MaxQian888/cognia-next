"use client"

/**
 * Mobile-native Inbox body.
 *
 * `/inbox/all` and `/inbox/drafts` reflow the desktop three-pane
 * `InboxShell` to a single column on phones, but there was no mobile-native
 * way to triage connector drafts (swipe approve / reject) without dropping
 * into the desktop `DraftCenter`. This body adds a thin segmented switcher
 * over two surfaces that already exist and are tested:
 *
 *   - 消息 (Messages) → the responsive `InboxShell` list (offcanvas sidebar,
 *     search, filter chips, tap-through to `/inbox/c/<key>`).
 *   - 草稿 (Drafts)   → the mobile `DraftApprovalPanel` (swipe-approve /
 *     swipe-reject + pull-to-refresh), which was built but never mounted.
 *
 * Rendered from `app/inbox/{all,drafts}/page.tsx` only when
 * `usePlatform() === "mobile"`; desktop / web keep the `InboxShell` directly.
 * The active tab is local state seeded by the route, so a `/inbox/drafts`
 * deep-link opens on Drafts while in-page switching stays instant.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { InboxShell } from "@/components/inbox/inbox-shell"
import { DraftApprovalPanel } from "@/components/mobile/connector/draft-approval-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { listAllPendingDrafts } from "@/lib/db/connector-drafts"
import { cn } from "@/lib/utils"

export type MobileInboxTab = "messages" | "drafts"

export interface MobileInboxBodyProps {
  initialTab?: MobileInboxTab
}

export function MobileInboxBody({ initialTab = "messages" }: MobileInboxBodyProps) {
  const t = useTranslations("mobile.inbox")
  const [tab, setTab] = useState<MobileInboxTab>(initialTab)
  const draftCount = useLiveQuery(async () => (await listAllPendingDrafts()).length, []) ?? 0

  return (
    <div className="flex h-[100dvh] flex-col safe-area-pt" data-testid="mobile-inbox-body">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <h1 className="text-sm font-semibold">{t("title")}</h1>
        <div
          role="tablist"
          aria-label={t("tabsAria")}
          className="ml-auto flex items-center gap-1 rounded-lg bg-muted p-0.5"
        >
          <TabChip
            id="messages"
            active={tab === "messages"}
            label={t("tabs.messages")}
            onSelect={() => setTab("messages")}
          />
          <TabChip
            id="drafts"
            active={tab === "drafts"}
            label={t("tabs.drafts")}
            badge={draftCount}
            onSelect={() => setTab("drafts")}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "drafts" ? (
          <DraftApprovalPanel />
        ) : (
          <InboxShell view="all" />
        )}
      </div>
    </div>
  )
}

interface TabChipProps {
  id: MobileInboxTab
  active: boolean
  label: string
  badge?: number
  onSelect: () => void
}

function TabChip({ id, active, label, badge, onSelect }: TabChipProps) {
  return (
    <Button
      type="button"
      role="tab"
      aria-selected={active}
      variant="ghost"
      size="sm"
      onClick={onSelect}
      data-testid={`mobile-inbox-tab-${id}`}
      className={cn(
        "h-7 gap-1.5 rounded-md px-3 text-xs",
        active ? "bg-background shadow-sm" : "text-muted-foreground"
      )}
    >
      <span>{label}</span>
      {badge ? (
        <Badge
          variant="secondary"
          className="h-4 min-w-4 justify-center px-1 text-[10px] leading-none"
          data-testid={`mobile-inbox-tab-${id}-badge`}
        >
          {badge > 99 ? "99+" : badge}
        </Badge>
      ) : null}
    </Button>
  )
}
