"use client"

/**
 * Settings → Observability → Diagnostics — Inbox telemetry export card.
 *
 * Reads the `inboxTelemetryEvents` ring buffer (cap 3000) and lets the
 * operator export the snapshot as CSV or JSON for incident reporting or
 * deeper analysis. The card surfaces the row count so the operator can
 * tell at a glance whether the breadcrumb layer has captured anything
 * actionable.
 *
 * The export pipeline reuses the same DOM glue (`downloadBlob`) as the
 * connector audit exporter; the CSV column layout is shaped to the
 * telemetry row, not the audit row, so we keep a dedicated exporter at
 * `lib/telemetry/inbox-telemetry-export.ts`.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DownloadIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { listRecent } from "@/lib/db/inbox-telemetry"
import { exportInboxTelemetry } from "@/lib/telemetry/inbox-telemetry-export"

const SNAPSHOT_LIMIT = 3000

export function InboxTelemetryCard() {
  const t = useTranslations("settings.diagnostics.inboxTelemetry")
  const [rowCount, setRowCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows = await listRecent({ limit: SNAPSHOT_LIMIT })
        if (!cancelled) setRowCount(rows.length)
      } catch {
        if (!cancelled) setRowCount(0)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshNonce])

  const onExport = async (format: "csv" | "json") => {
    setLoading(true)
    try {
      const rows = await listRecent({ limit: SNAPSHOT_LIMIT })
      if (rows.length === 0) {
        toast.message(t("emptyExport"))
        return
      }
      const { filename } = exportInboxTelemetry({ rows, format })
      toast.success(t("exported", { filename }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card data-testid="inbox-telemetry-card">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {rowCount === null ? t("loadingCount") : t("rowCount", { count: rowCount })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRefreshNonce((n) => n + 1)}
            data-testid="inbox-telemetry-refresh"
          >
            <RefreshCwIcon className="mr-1 h-3 w-3" aria-hidden />
            {t("refresh")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={loading || rowCount === 0}
            onClick={() => void onExport("csv")}
            data-testid="inbox-telemetry-export-csv"
          >
            <DownloadIcon className="mr-1 h-3 w-3" aria-hidden />
            {t("exportCsv")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || rowCount === 0}
            onClick={() => void onExport("json")}
            data-testid="inbox-telemetry-export-json"
          >
            <DownloadIcon className="mr-1 h-3 w-3" aria-hidden />
            {t("exportJson")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
