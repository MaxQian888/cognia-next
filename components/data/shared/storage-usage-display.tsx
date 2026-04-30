"use client"

// Compact storage stats card. Shows total row count + per-table breakdown,
// and (when the browser allows) the IDB origin's estimated usage / quota.

import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { useStorageStats } from "@/hooks/data/use-storage-stats"
import { HardDriveIcon } from "lucide-react"

const ROW_LABELS: Array<{ key: string; labelKey: string }> = [
  { key: "sessions", labelKey: "sessions" },
  { key: "messages", labelKey: "messages" },
  { key: "characters", labelKey: "characters" },
  { key: "skills", labelKey: "skills" },
  { key: "skillResources", labelKey: "skillResources" },
  { key: "teams", labelKey: "teams" },
  { key: "promptPresets", labelKey: "promptPresets" },
  { key: "mcpServers", labelKey: "mcpServers" },
  { key: "trustedWorkspaces", labelKey: "trustedWorkspaces" },
  { key: "sessionState", labelKey: "sessionState" },
  { key: "backupHistory", labelKey: "backupHistory" },
]

export function StorageUsageDisplay() {
  const t = useTranslations("settings.data.overview.storageBreakdown")
  const stats = useStorageStats()
  const usagePct =
    stats.usageBytes && stats.quotaBytes
      ? Math.round((stats.usageBytes / stats.quotaBytes) * 100)
      : null

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <HardDriveIcon className="size-4" />
        <Label className="text-sm">{t("title")}</Label>
      </div>
      {usagePct !== null && (
        <div className="space-y-1">
          <Progress value={usagePct} />
          <p className="text-[11px] text-muted-foreground">
            {t("usage", {
              used: formatBytes(stats.usageBytes ?? 0),
              quota: formatBytes(stats.quotaBytes ?? 0),
              pct: usagePct,
            })}
          </p>
        </div>
      )}
      {usagePct === null && (
        <p className="text-[11px] italic text-muted-foreground">{t("usageUnavailable")}</p>
      )}
      <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {ROW_LABELS.map(({ key, labelKey }) => {
          const count = stats.counts[key] ?? 0
          return (
            <li key={key}>
              <span className="font-mono">{t(`row.${labelKey}` as never)}:</span>{" "}
              <span className={count > 0 ? "" : "italic"}>{count}</span>
            </li>
          )
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        {t("totalRows", { count: stats.totalRows })}
      </p>
    </Card>
  )
}

function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 B"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
