"use client"

// Usage tab — historical snapshots in a simple table. The chart promised by
// the plan can land in a follow-up; the table covers the goal of "show me
// my last N samples and where the limit is heading" without taking on a
// recharts integration during this phase.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"

import { useSubscriptionUsage } from "@/lib/anthropic-subscription/hooks"
import { isTauri } from "@/lib/tauri"
import { topByCost, type SessionUsageTotals } from "@/lib/db/session-usage"
import { listSessions } from "@/lib/db/sessions"
import type { ChatSession } from "@/lib/claude/types"
import { useChatStore } from "@/stores/chat"

export function SubscriptionUsageTab() {
  const t = useTranslations("subscription")
  const tabReady = isTauri()
  const { rows, loading } = useSubscriptionUsage(200)

  if (!tabReady) {
    return <SettingsAlert title={t("webModeBanner")}>{t("webModeBanner")}</SettingsAlert>
  }

  if (loading) {
    return <p className="text-xs text-muted-foreground">{t("usage.loading")}</p>
  }

  if (rows.length === 0) {
    return <SettingsEmptyState title={t("usage.emptyTitle")} description={t("usage.emptyBody")} />
  }

  return (
    <div className="space-y-4">
      <SettingsCard title={t("usage.tableTitle")} description={t("usage.tableDescription")}>
        <ScrollArea className="h-[420px]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("usage.col.fetchedAt")}</TableHead>
                <TableHead>{t("usage.col.source")}</TableHead>
                <TableHead>{t("usage.col.status")}</TableHead>
                <TableHead className="text-right">{t("usage.col.fiveHour")}</TableHead>
                <TableHead className="text-right">{t("usage.col.sevenDay")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.localId}>
                  <TableCell className="font-mono text-xs">
                    {new Date(row.fetchedAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.source === "probe" ? "default" : "secondary"}>
                      {row.source}
                    </Badge>
                  </TableCell>
                  <TableCell>{row.status}</TableCell>
                  <TableCell className="text-right font-mono">
                    {row.fiveHour ? `${Math.round(row.fiveHour.utilization * 100)}%` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {row.sevenDay ? `${Math.round(row.sevenDay.utilization * 100)}%` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </SettingsCard>

      <TopSessionsCard />
    </div>
  )
}

interface TopRow {
  sessionId: string
  totals: SessionUsageTotals
  session: ChatSession | null
}

function TopSessionsCard() {
  const t = useTranslations("subscription.usage.topSessions")
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const [rows, setRows] = useState<TopRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      setLoading(true)
      try {
        const top = await topByCost(10)
        const sessions = await listSessions()
        if (cancelled) return
        const byId = new Map(sessions.map((s) => [s.id, s]))
        setRows(
          top.map((entry) => ({
            sessionId: entry.sessionId,
            totals: entry.totals,
            session: byId.get(entry.sessionId) ?? null,
          }))
        )
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void refresh()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <SettingsCard title={t("title")} description={t("description")}>
      {loading ? (
        <p className="text-xs text-muted-foreground">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="rounded border bg-muted/30 p-4 text-center text-xs italic text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>{t("colSession")}</TableHead>
              <TableHead className="text-right">{t("colTurns")}</TableHead>
              <TableHead className="text-right">{t("colTokens")}</TableHead>
              <TableHead className="text-right">{t("colCost")}</TableHead>
              <TableHead className="text-right">{t("colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, idx) => (
              <TableRow key={r.sessionId} data-testid={`top-session-${r.sessionId}`}>
                <TableCell className="text-xs text-muted-foreground">{idx + 1}</TableCell>
                <TableCell className="max-w-[16rem] truncate">
                  {r.session?.title ?? t("untitled")}
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {r.sessionId}
                  </p>
                </TableCell>
                <TableCell className="text-right text-xs">{r.totals.turns}</TableCell>
                <TableCell className="text-right text-xs">
                  {(
                    r.totals.inputTokens +
                    r.totals.outputTokens +
                    r.totals.cacheReadTokens
                  ).toLocaleString()}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  ${r.totals.costUsd.toFixed(4)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setActiveSession(r.sessionId)}
                    disabled={!r.session}
                    data-testid={`top-session-resume-${r.sessionId}`}
                  >
                    {t("resume")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SettingsCard>
  )
}
