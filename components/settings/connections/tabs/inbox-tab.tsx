"use client"

/**
 * Inbox tab in the Connections settings section.
 *
 * Read-only summary showing totals per adapter:
 *  - total conversations
 *  - unread
 *  - pinned
 *  - archived
 *
 * Links to /inbox for the full Inbox UI.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { InboxIcon, ExternalLinkIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ChatSession } from "@cognia/agent-config-types"

interface AdapterStats {
  adapter: AdapterInstanceRow
  total: number
  unread: number
  pinned: number
  archived: number
}

export function InboxTab() {
  const t = useTranslations("settings.connections.inbox")
  const stats = useLiveQuery<AdapterStats[]>(async () => {
    if (typeof window === "undefined") return []
    const db = getDb()

    const [adapters, sessions, overrides] = await Promise.all([
      db.adapterInstances.toArray(),
      db.sessions.filter((s) => s.platformBinding != null).toArray() as Promise<ChatSession[]>,
      db.conversationOverrides.toArray() as Promise<ConversationOverrideRow[]>,
    ])

    const overrideMap = new Map(overrides.map((o) => [o.conversationKey, o]))

    return adapters.map((adapter) => {
      const adapterSessions = sessions.filter((s) => s.platformBinding?.adapterId === adapter.id)

      let unread = 0
      let pinned = 0
      let archived = 0

      for (const session of adapterSessions) {
        const ck = session.platformBinding!.conversationKey
        const override = overrideMap.get(ck)
        if (override?.pinned) pinned++
        if (override?.archived) archived++
        if (!override?.lastReadAt || override.lastReadAt < session.updatedAt) unread++
      }

      return {
        adapter,
        total: adapterSessions.length,
        unread,
        pinned,
        archived,
      }
    })
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t("summary")}</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/inbox" data-testid="open-inbox-link">
            <InboxIcon className="h-4 w-4 mr-2" />
            {t("openInbox")}
            <ExternalLinkIcon className="h-3 w-3 ml-1" />
          </Link>
        </Button>
      </div>

      {!stats || stats.length === 0 ? (
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-muted-foreground">{t("noAdapters")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2" data-testid="inbox-stats-list">
          {stats.map(({ adapter, total, unread, pinned, archived }) => (
            <Card key={adapter.id} data-testid={`inbox-stat-${adapter.id}`}>
              <CardHeader className="pb-2 pt-3">
                <CardTitle className="flex items-center justify-between text-sm font-medium">
                  <span>{adapter.displayName}</span>
                  <Badge variant="outline" className="text-xs">
                    {adapter.type}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-3">
                <div className="grid grid-cols-4 gap-2 text-center text-xs">
                  <StatCell label={t("totalLabel")} value={total} testId={`total-${adapter.id}`} />
                  <StatCell
                    label={t("unreadLabel")}
                    value={unread}
                    testId={`unread-${adapter.id}`}
                  />
                  <StatCell
                    label={t("pinnedLabel")}
                    value={pinned}
                    testId={`pinned-${adapter.id}`}
                  />
                  <StatCell
                    label={t("archivedLabel")}
                    value={archived}
                    testId={`archived-${adapter.id}`}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function StatCell({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="space-y-0.5" data-testid={testId}>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-semibold text-sm">{value}</p>
    </div>
  )
}
