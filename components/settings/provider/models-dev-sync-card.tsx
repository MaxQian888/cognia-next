"use client"

// Global "Sync from models.dev" card mounted at the top of the provider
// settings page. Triggers a live catalog sync and surfaces the last-synced
// time, source (bundled snapshot vs live), and provider/model counts.

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { RefreshCw, Loader2, Database } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useModelsDevCatalog } from "@/hooks/settings/use-models-dev-catalog"

export function ModelsDevSyncCard() {
  const t = useTranslations("providers")
  const { row, providerCount, modelCount, isSyncing, error, sync } = useModelsDevCatalog()

  useEffect(() => {
    if (error) toast.error(t("modelsDev.syncError", { message: error }))
  }, [error, t])

  const lastSynced = row?.fetchedAt
    ? new Date(row.fetchedAt).toLocaleString()
    : t("modelsDev.never")
  const sourceLabel =
    row?.source === "remote" ? t("modelsDev.sourceRemote") : t("modelsDev.sourceBundled")

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background">
          <Database className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{t("modelsDev.title")}</p>
            {row && (
              <Badge variant="secondary" className="text-[10px]">
                {sourceLabel}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("modelsDev.summary", {
              providers: providerCount,
              models: modelCount,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("modelsDev.lastSynced", { time: lastSynced })}
          </p>
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void sync()}
        disabled={isSyncing}
        className="shrink-0"
      >
        {isSyncing ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="mr-2 h-4 w-4" />
        )}
        {isSyncing ? t("modelsDev.syncing") : t("modelsDev.sync")}
      </Button>
    </div>
  )
}

export default ModelsDevSyncCard
