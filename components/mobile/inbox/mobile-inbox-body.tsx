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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { listAllPendingDrafts } from "@/lib/db/connector-drafts"

export type MobileInboxTab = "messages" | "drafts"

export interface MobileInboxBodyProps {
  initialTab?: MobileInboxTab
}

export function MobileInboxBody({ initialTab = "messages" }: MobileInboxBodyProps) {
  const t = useTranslations("mobile.inbox")
  const [tab, setTab] = useState<MobileInboxTab>(initialTab)
  const draftCount = useLiveQuery(async () => (await listAllPendingDrafts()).length, []) ?? 0

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as MobileInboxTab)}
      className="h-[100dvh] gap-0 safe-area-pt"
      data-testid="mobile-inbox-body"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <h1 className="text-sm font-semibold">{t("title")}</h1>
        <TabsList
          aria-label={t("tabsAria")}
          className="ml-auto h-8"
        >
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

      <TabsContent value="messages" className="min-h-0 overflow-hidden">
        <InboxShell view="all" />
      </TabsContent>
      <TabsContent value="drafts" className="min-h-0 overflow-hidden">
        <DraftApprovalPanel />
      </TabsContent>
    </Tabs>
  )
}
