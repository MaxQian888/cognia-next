"use client"

// Usage tab — historical snapshots in a simple table. The chart promised by
// the plan can land in a follow-up; the table covers the goal of "show me
// my last N samples and where the limit is heading" without taking on a
// recharts integration during this phase.

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
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
  )
}
