"use client"

/**
 * Body of `/me/storage`. Owns the one data source (`useStorageOverview`)
 * and lays the three blocks out:
 *
 *   hero (usage bar + health + persistence)   ─ full width
 *   breakdown rows          │  manage rows     ─ side by side once the
 *                                                body is ≥ 42rem wide
 *
 * The split keys on the container (`@container` / `@2xl:`), not the
 * viewport: `SubPageShell` clamps the body, and a wide phone in landscape
 * or a narrow desktop window should get the column count its actual width
 * can carry.
 *
 * The manage block replaced two things: a lone outline button at the very
 * bottom of the page, and a second list of backup files that duplicated
 * `/me/backup`. It is now two `MeRow`s: clean up (opens the same
 * `StorageCleanupSheet`) and a link to the backups page with the on-disk
 * total as its value.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArchiveIcon, BrushCleaningIcon } from "lucide-react"

import { MeRow } from "@/components/mobile/me/me-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { StorageBreakdownCard } from "@/components/mobile/me/storage-breakdown-card"
import { StorageCleanupSheet } from "@/components/mobile/me/storage-cleanup-sheet"
import { StorageUsageCard } from "@/components/mobile/me/storage-usage-card"
import { useStorageOverview, type UseStorageOverviewOptions } from "@/hooks/storage/use-storage-overview"
import { formatBytes } from "@/lib/storage/usage"

export type StorageOverviewProps = UseStorageOverviewOptions

export function StorageOverview(props: StorageOverviewProps = {}) {
  const t = useTranslations("mobile.me")
  const tStorage = useTranslations("mobile.me.storage")
  const overview = useStorageOverview(props)
  const [cleanupOpen, setCleanupOpen] = useState(false)

  const backups = overview.usage?.backups ?? []

  return (
    <div className="@container" data-testid="storage-overview">
      <div className="grid gap-5 @2xl:grid-cols-2" data-testid="storage-overview-grid">
        <div className="@2xl:col-span-2">
        <StorageUsageCard
          usage={overview.usage}
          stats={overview.stats}
          health={overview.health}
          persisted={overview.persisted}
          isLoading={overview.isLoading}
          refreshing={overview.refreshing}
          disabled={overview.isBusy}
          onRefresh={overview.refresh}
          onRequestPersistence={overview.requestPersistence}
        />
      </div>
      <StorageBreakdownCard
        stats={overview.stats}
        health={overview.health}
        isLoading={overview.isLoading}
        disabled={overview.isBusy}
        formatBytes={overview.formatBytes}
        onClearCategory={overview.clearCategory}
      />
      <MeSection
        title={tStorage("manageTitle")}
        description={tStorage("manageDescription")}
        withSeparators
        testid="storage-manage"
      >
        <MeRow
          icon={BrushCleaningIcon}
          iconClassName="text-primary"
          label={tStorage("cleanupCta")}
          description={tStorage("cleanupRowDescription")}
          disabled={overview.isBusy}
          onClick={() => setCleanupOpen(true)}
          testid="storage-cleanup-cta"
        />
        <MeRow
          icon={ArchiveIcon}
          iconClassName="text-muted-foreground"
          label={tStorage("backupsRow")}
          description={tStorage("backupsRowDescription", {
            count: backups.length,
            total: formatBytes(overview.usage?.backupBytes ?? 0),
          })}
          href="/me/backup"
          ariaLabel={t("backupRow")}
          testid="storage-backups-row"
        />
      </MeSection>
      <StorageCleanupSheet
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        onCleaned={() => void overview.refresh()}
      />
      </div>
    </div>
  )
}
