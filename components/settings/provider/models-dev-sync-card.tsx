"use client"

// Compact, non-resident models.dev catalog sync control mounted at the top of
// the provider settings page. Previously a permanently-resident card that
// always showed counts / source / last-synced; it is now a small "Sync"
// button whose detail collapses to a hover summary and a transient status line
// (syncing / error / never-synced / brief "Synced ✓"). See `SyncStatusStrip`.

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { SyncStatusStrip, type SyncPhase } from "@/components/settings/_shared/sync-status-strip"
import { useModelsDevCatalog } from "@/hooks/settings/use-models-dev-catalog"

export function ModelsDevSyncCard() {
  const t = useTranslations("providers")
  const { row, providerCount, modelCount, isSyncing, error, sync } = useModelsDevCatalog()

  useEffect(() => {
    if (error) toast.error(t("modelsDev.syncError", { message: error }))
  }, [error, t])

  // Map catalog hook state → strip phase. `!row` = never synced (stale); a
  // present row that is fresh collapses to the resting `idle` state.
  const phase: SyncPhase = isSyncing ? "syncing" : error ? "error" : !row ? "stale" : "idle"

  const lastSynced = row?.fetchedAt
    ? new Date(row.fetchedAt).toLocaleString()
    : t("modelsDev.never")
  const sourceLabel =
    row?.source === "remote" ? t("modelsDev.sourceRemote") : t("modelsDev.sourceBundled")

  // Counts + source + last-synced are kept discoverable as the button's hover
  // title rather than occupying the page.
  const summary = row
    ? `${t("modelsDev.summary", { providers: providerCount, models: modelCount })} · ` +
      `${sourceLabel} · ${t("modelsDev.lastSynced", { time: lastSynced })}`
    : t("modelsDev.lastSynced", { time: lastSynced })

  const statusText =
    phase === "error"
      ? (error ?? undefined)
      : phase === "stale"
        ? t("modelsDev.lastSynced", { time: lastSynced })
        : undefined

  return (
    <SyncStatusStrip
      data-testid="models-dev-sync"
      label={t("modelsDev.sync")}
      syncingLabel={t("modelsDev.syncing")}
      syncedLabel={t("modelsDev.synced")}
      phase={phase}
      statusText={statusText}
      summary={summary}
      onSync={() => void sync()}
    />
  )
}

export default ModelsDevSyncCard
